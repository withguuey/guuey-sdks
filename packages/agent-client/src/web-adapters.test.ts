import { describe, it, expect, vi } from "vitest";
import {
  __resetReaderEndpointWarning,
  __resetRelayEndpointWarning,
  createUiActionRelay,
  createUiResourceReader,
  createWebAdapters,
  deleteThread,
} from "./web-adapters.js";
import { AGENT_ERROR_CODES } from "./error-codes.js";
import type { InvokeRequest } from "./types.js";

/** A well-formed guest secret: 64 lowercase hex chars. */
const SECRET = "0123456789abcdef".repeat(4);
/** A second well-formed secret, for the rotation pin. */
const SECRET_B = "fedcba9876543210".repeat(4);

function sseResponse(body = 'data: {"type":"text"}\n\n'): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A `fetch`-shaped mock that returns queued responses in order. */
function mockFetch(responses: Response[]) {
  const queue = [...responses];
  return vi.fn(
    (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const next = queue.shift();
      if (!next) throw new Error("mockFetch: no queued response");
      return Promise.resolve(next);
    },
  );
}

/** Swap the global `fetch` for the duration of `fn`, then restore it. */
async function withGlobalFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Normalise whatever `HeadersInit` the code passed into a plain lookup. */
function headersOf(init: Parameters<typeof fetch>[1]): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function invokeRequest(signal: AbortSignal = new AbortController().signal): InvokeRequest {
  return {
    url: "https://pod.example.com/agent/invoke",
    body: { input: "hi", clientMessageId: "cmid-1" },
    signal,
  };
}

/** A structured pod refusal: `{code, message}` + status (+ `Retry-After`). */
function refusal(
  code: string,
  status: number,
  retryAfter?: string,
  message = `refused: ${code}`,
): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(retryAfter === undefined ? {} : { "Retry-After": retryAfter }),
    },
  });
}

/** The governor's saturation refusal — the one the transport retries. */
const saturated = (retryAfter?: string): Response =>
  refusal(AGENT_ERROR_CODES.POD_SATURATED, 503, retryAfter);

/** Drive an invoke stream to completion and return the concatenated chunks. */
async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

/**
 * The transport itself (identity carriers, the AgentResponseError envelope,
 * the POD_SATURATED retry) is pinned in `./transport.test.ts`, its module.
 * This one test stays here because it pins the ADAPTER property: every
 * `createWebAdapters` consumer inherits that retry without opting in.
 */
describe("createUiResourceReader — missing pod door warns at construction", () => {
  it("warns once when endpointUrl is omitted (undefined), never when null is declared or a pod door is given", () => {
    __resetReaderEndpointWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // `null` = declared history-only viewer: silent.
      createUiResourceReader({ apiBaseUrl: "https://api.example", threadId: "t", endpointUrl: null });
      expect(warn).not.toHaveBeenCalled();
      // A real pod door: silent.
      createUiResourceReader({ apiBaseUrl: "https://api.example", threadId: "t", endpointUrl: "https://pod.example" });
      expect(warn).not.toHaveBeenCalled();
      // Forgotten: warns, naming endpointUrl and the mid-turn consequence.
      createUiResourceReader({ apiBaseUrl: "https://api.example", threadId: "t" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/endpointUrl/);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/mid-turn/);
      // Once per module, not per construction — a surface re-creating the
      // reader per render must not spam.
      createUiResourceReader({ apiBaseUrl: "https://api.example", threadId: "t" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createWebAdapters saturation-retry inheritance", () => {
  it("every createWebAdapters consumer inherits the retry, on the real timer-based wait", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = mockFetch([saturated("2"), sseResponse("data: ok\n\n")]);
      const adapters = createWebAdapters({ getGuestSecret: () => SECRET });
      const streamed = withGlobalFetch(fetchImpl, () => drain(adapters.transport(invokeRequest())));
      await vi.advanceTimersByTimeAsync(2000);
      expect(await streamed).toBe("data: ok\n\n");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads the bearer per ATTEMPT: a cold-start retry sends the fresh token, not the stale one", async () => {
    vi.useFakeTimers();
    try {
      // Envelope-less 503 (the cold-start shape), then success. tok-1 may
      // have expired during the backoff wait; the retry must carry tok-2.
      const fetchImpl = mockFetch([
        new Response("Service Unavailable", { status: 503 }),
        sseResponse("data: ok\n\n"),
      ]);
      const getAccessToken = vi
        .fn<() => Promise<string | null>>()
        .mockResolvedValueOnce("tok-1")
        .mockResolvedValueOnce("tok-2");
      const adapters = createWebAdapters({ getAccessToken });
      const streamed = withGlobalFetch(fetchImpl, () => drain(adapters.transport(invokeRequest())));
      await vi.advanceTimersByTimeAsync(2000);
      expect(await streamed).toBe("data: ok\n\n");
      expect(getAccessToken).toHaveBeenCalledTimes(2);
      expect(headersOf(fetchImpl.mock.calls[0][1]).Authorization).toBe("Bearer tok-1");
      expect(headersOf(fetchImpl.mock.calls[1][1]).Authorization).toBe("Bearer tok-2");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createWebAdapters transport", () => {
  it("re-resolves the secret per request, so a rotation takes effect on the next one", async () => {
    const fetchImpl = mockFetch([sseResponse(), sseResponse()]);
    // Asserting two DIFFERENT headers pins the documented behaviour (the value
    // is re-read per request); a call-count assertion would also pass for an
    // implementation that calls the resolver every time but memoises the first
    // value it got.
    const getGuestSecret = vi
      .fn<() => string | null>()
      .mockReturnValueOnce(SECRET)
      .mockReturnValueOnce(SECRET_B);
    const adapters = createWebAdapters({ getGuestSecret });
    await withGlobalFetch(fetchImpl, async () => {
      await drain(adapters.transport(invokeRequest()));
      await drain(adapters.transport(invokeRequest()));
    });
    expect(headersOf(fetchImpl.mock.calls[0][1])["x-guuey-guest"]).toBe(SECRET);
    expect(headersOf(fetchImpl.mock.calls[1][1])["x-guuey-guest"]).toBe(SECRET_B);
  });

  it("prefers the token when both resolvers are supplied", async () => {
    const fetchImpl = mockFetch([sseResponse()]);
    const adapters = createWebAdapters({
      getAccessToken: async () => "tok_abc",
      getGuestSecret: () => SECRET,
    });
    await withGlobalFetch(fetchImpl, () => drain(adapters.transport(invokeRequest())));
    const init = fetchImpl.mock.calls[0][1];
    expect(headersOf(init).Authorization).toBe("Bearer tok_abc");
    expect(headersOf(init)["x-guuey-guest"]).toBeUndefined();
  });

  it("uses the guest secret when the token resolver yields null (signed out)", async () => {
    const fetchImpl = mockFetch([sseResponse()]);
    const adapters = createWebAdapters({
      getAccessToken: async () => null,
      getGuestSecret: () => SECRET,
    });
    await withGlobalFetch(fetchImpl, () => drain(adapters.transport(invokeRequest())));
    expect(headersOf(fetchImpl.mock.calls[0][1])["x-guuey-guest"]).toBe(SECRET);
  });

  it("falls back to cookie mode when the guest resolver yields null", async () => {
    const fetchImpl = mockFetch([sseResponse()]);
    const adapters = createWebAdapters({ getGuestSecret: () => null });
    await withGlobalFetch(fetchImpl, () => drain(adapters.transport(invokeRequest())));
    expect(fetchImpl.mock.calls[0][1]?.credentials).toBe("include");
  });
});

describe("createWebAdapters history install", () => {
  const apiBaseUrl = "https://api.example.com/v1";

  it("is not installed without a read-plane base", () => {
    expect(createWebAdapters({ getGuestSecret: () => SECRET }).history).toBeUndefined();
    expect(createWebAdapters({ getAccessToken: async () => "tok" }).history).toBeUndefined();
  });

  it("is not installed when neither identity resolver is supplied", () => {
    expect(createWebAdapters({ apiBaseUrl }).history).toBeUndefined();
  });

  it("is installed in guest mode and reads with the guest header", async () => {
    const fetchImpl = mockFetch([jsonResponse({ rows: [], nextToken: null })]);
    const history = createWebAdapters({ apiBaseUrl, getGuestSecret: () => SECRET }).history;
    if (!history) throw new Error("history adapter not installed in guest mode");
    const result = await withGlobalFetch(fetchImpl, () => history.load("t_1"));
    expect(result).toEqual({ messages: [], cards: [] });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/threads/t_1/messages");
    expect(fetchImpl.mock.calls[0][1]).toEqual({ headers: { "x-guuey-guest": SECRET } });
  });

  it("reads with the bearer, and only the bearer, when both resolvers are supplied", async () => {
    const fetchImpl = mockFetch([jsonResponse({ rows: [], nextToken: null })]);
    const history = createWebAdapters({
      apiBaseUrl,
      getAccessToken: async () => "tok_abc",
      getGuestSecret: () => SECRET,
    }).history;
    if (!history) throw new Error("history adapter not installed");
    await withGlobalFetch(fetchImpl, () => history.load("t_1"));
    expect(fetchImpl.mock.calls[0][1]).toEqual({ headers: { Authorization: "Bearer tok_abc" } });
  });

  it("skips the read (no identity) when the guest secret is malformed", async () => {
    const fetchImpl = mockFetch([]);
    const history = createWebAdapters({ apiBaseUrl, getGuestSecret: () => "not-a-secret" }).history;
    if (!history) throw new Error("history adapter not installed");
    const result = await withGlobalFetch(fetchImpl, () => history.load("t_1"));
    expect(result).toEqual({ messages: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still skips the read when a signed-out token resolver has no guest fallback", async () => {
    const fetchImpl = mockFetch([]);
    const history = createWebAdapters({ apiBaseUrl, getAccessToken: async () => null }).history;
    if (!history) throw new Error("history adapter not installed");
    const result = await withGlobalFetch(fetchImpl, () => history.load("t_1"));
    expect(result).toEqual({ messages: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a guest transcript through the shared reader", async () => {
    const fetchImpl = mockFetch([
      jsonResponse({
        rows: [{ seq: 1, at: "2026-07-27T00:00:00Z", kind: "text", authorRole: "user", text: "hi" }],
        nextToken: null,
      }),
    ]);
    const history = createWebAdapters({ apiBaseUrl, getGuestSecret: () => SECRET }).history;
    if (!history) throw new Error("history adapter not installed in guest mode");
    const result = await withGlobalFetch(fetchImpl, () => history.load("t_1"));
    expect(result).toEqual({ messages: [{ role: "user", text: "hi", seq: 1 }], cards: [] });
  });
});

/**
 * The history-401-retry (widget wave 2 / T15, B4 live-gate finding): a token
 * this resolver already returned can be stale by the time the MOUNT-time
 * transcript read fires, before the send path's own `withIdentifiedToken` has
 * asked anyone for anything. Same single-retry discipline as that send path —
 * ask once with `forceRefresh`, retry once, and let a genuine failure surface
 * rather than looping or silently returning an empty transcript.
 */
describe("createWebAdapters history — 401 retry", () => {
  const apiBaseUrl = "https://api.example.com/v1";
  const TRANSCRIPT = jsonResponse({
    rows: [{ seq: 1, at: "2026-07-28T00:00:00Z", kind: "text", authorRole: "user", text: "hi" }],
    nextToken: null,
  });

  it("retries once with a force-refreshed token after a 401, and succeeds", async () => {
    const fetchImpl = mockFetch([jsonResponse({}, 401), TRANSCRIPT]);
    const getAccessToken = vi.fn(async (opts?: { forceRefresh?: boolean }) =>
      opts?.forceRefresh ? "fresh-token" : "stale-token",
    );
    const history = createWebAdapters({ apiBaseUrl, getAccessToken }).history;
    if (!history) throw new Error("history adapter not installed");
    const result = await withGlobalFetch(fetchImpl, () => history.load("t_1"));
    expect(result).toEqual({ messages: [{ role: "user", text: "hi", seq: 1 }], cards: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchImpl.mock.calls[0][1]).Authorization).toBe("Bearer stale-token");
    expect(headersOf(fetchImpl.mock.calls[1][1]).Authorization).toBe("Bearer fresh-token");
    expect(getAccessToken).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("retries exactly once — a second 401 surfaces rather than looping", async () => {
    const fetchImpl = mockFetch([jsonResponse({}, 401), jsonResponse({}, 401)]);
    const getAccessToken = vi.fn(async (opts?: { forceRefresh?: boolean }) =>
      opts?.forceRefresh ? "fresh-token" : "stale-token",
    );
    const history = createWebAdapters({ apiBaseUrl, getAccessToken }).history;
    if (!history) throw new Error("history adapter not installed");
    await withGlobalFetch(fetchImpl, async () => {
      await expect(history.load("t_1")).rejects.toThrow(/401/);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces the ORIGINAL 401 when the forced refresh has nothing fresher to offer", async () => {
    const fetchImpl = mockFetch([jsonResponse({}, 401)]);
    const getAccessToken = vi.fn(async (opts?: { forceRefresh?: boolean }) =>
      opts?.forceRefresh ? null : "stale-token",
    );
    const history = createWebAdapters({ apiBaseUrl, getAccessToken }).history;
    if (!history) throw new Error("history adapter not installed");
    await withGlobalFetch(fetchImpl, async () => {
      await expect(history.load("t_1")).rejects.toThrow(/401/);
    });
    // No second network call: a resolver with nothing fresher to offer must
    // not spend a request replaying the token that just failed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-401 failure", async () => {
    const fetchImpl = mockFetch([jsonResponse({}, 500)]);
    const getAccessToken = vi.fn(async () => "tok_abc");
    const history = createWebAdapters({ apiBaseUrl, getAccessToken }).history;
    if (!history) throw new Error("history adapter not installed");
    await withGlobalFetch(fetchImpl, async () => {
      await expect(history.load("t_1")).rejects.toThrow(/500/);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getAccessToken).not.toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("never retries a guest-header 401 — there is no fresher identity to force-refresh", async () => {
    const fetchImpl = mockFetch([jsonResponse({}, 401)]);
    const history = createWebAdapters({ apiBaseUrl, getGuestSecret: () => SECRET }).history;
    if (!history) throw new Error("history adapter not installed");
    await withGlobalFetch(fetchImpl, async () => {
      await expect(history.load("t_1")).rejects.toThrow(/401/);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("identity-resolution failures", () => {
  const apiBaseUrl = "https://api.example.com/v1";
  const rejectingToken = async (): Promise<string | null> => {
    throw new Error("token refresh failed");
  };

  // A failing token read must FAIL, never quietly become an anonymous send:
  // the pod accepts anonymous invokes unconditionally, so a fall-through would
  // succeed and fork the caller's turns into an unreachable guest thread.
  // These pin the semantics against a refactor that hoists the guest read above
  // the `await`, or wraps the token read in a try/catch.
  it("rejects the invoke when the token resolver rejects, even with a guest secret to hand", async () => {
    const fetchImpl = mockFetch([]);
    const adapters = createWebAdapters({
      getAccessToken: rejectingToken,
      getGuestSecret: () => SECRET,
    });
    await withGlobalFetch(fetchImpl, async () => {
      await expect(drain(adapters.transport(invokeRequest()))).rejects.toThrow("token refresh failed");
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects the history load when the token resolver rejects, even with a guest secret to hand", async () => {
    const fetchImpl = mockFetch([]);
    const history = createWebAdapters({
      apiBaseUrl,
      getAccessToken: rejectingToken,
      getGuestSecret: () => SECRET,
    }).history;
    if (!history) throw new Error("history adapter not installed");
    // The adapter REJECTS (it does not return an empty transcript). The hook is
    // what makes history best-effort: `useAgentInvoke` catches a rejected
    // `load` and leaves the chat empty.
    await withGlobalFetch(fetchImpl, async () => {
      await expect(history.load("t_1")).rejects.toThrow("token refresh failed");
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("propagates a throwing guest resolver rather than degrading to cookie mode", async () => {
    const fetchImpl = mockFetch([]);
    const adapters = createWebAdapters({
      getGuestSecret: () => {
        throw new DOMException("localStorage is blocked", "SecurityError");
      },
    });
    await withGlobalFetch(fetchImpl, async () => {
      await expect(drain(adapters.transport(invokeRequest()))).rejects.toThrow(/blocked/);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("guest secret confidentiality", () => {
  it("never writes the secret to the console on invoke or history", async () => {
    const fetchImpl = mockFetch([sseResponse(), jsonResponse({ rows: [], nextToken: null })]);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      const adapters = createWebAdapters({
        apiBaseUrl: "https://api.example.com/v1",
        getGuestSecret: () => SECRET,
      });
      const history = adapters.history;
      if (!history) throw new Error("history adapter not installed in guest mode");
      await withGlobalFetch(fetchImpl, async () => {
        await drain(adapters.transport(invokeRequest()));
        await history.load("t_1");
      });
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(SECRET);
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// guuey#122 Gap 1 — the ui-resource reader: deny == miss == undefined, and
// the same credential precedence as the transport.
describe("createUiResourceReader", () => {
  const OK_BODY = { uri: "ui://ggui/render/s/h", mimeType: "text/html", text: "<html>x</html>" };
  function mkFetch(status: number, body?: unknown) {
    return vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  it("resolves a ggui-uri to the ggui channel with the fetched payload", async () => {
    const fetchImpl = mkFetch(200, OK_BODY);
    const read = createUiResourceReader({
      endpointUrl: null, // history-door-only test — declared, not forgotten
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      guestSecret: "a".repeat(64),
      fetchImpl,
    });
    const mount = await read("ui://ggui/render/s/h");
    expect(mount).toEqual({ channel: "ggui", resource: OK_BODY });
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(String(call[0])).toBe(
      "https://api.example/v1/threads/t1/ui-resource?uri=ui%3A%2F%2Fggui%2Frender%2Fs%2Fh",
    );
    expect((call[1] as { headers: Record<string, string> }).headers["x-guuey-guest"]).toBe(
      "a".repeat(64),
    );
  });

  it("a bearer wins over a guest secret (same rule as the transport)", async () => {
    const fetchImpl = mkFetch(200, OK_BODY);
    const read = createUiResourceReader({
      endpointUrl: null, // history-door-only test — declared, not forgotten
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      getAccessToken: async () => "tok",
      guestSecret: "a".repeat(64),
      fetchImpl,
    });
    await read("ui://x/y");
    const headers = (
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as {
        headers: Record<string, string>;
      }
    ).headers;
    expect(headers["authorization"]).toBe("Bearer tok");
    expect(headers["x-guuey-guest"]).toBeUndefined();
  });

  it("cookie mode (no bearer, no guest) sends credentials:'include' and NO identity header — the transport's third arm (guuey#221)", async () => {
    const fetchImpl = mkFetch(200, OK_BODY);
    const read = createUiResourceReader({
      endpointUrl: null, // history-door-only test — declared, not forgotten
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      fetchImpl,
    });
    await read("ui://x/y");
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as {
      headers: Record<string, string>;
      credentials?: string;
    };
    expect(init.credentials).toBe("include");
    expect(init.headers["authorization"]).toBeUndefined();
    expect(init.headers["x-guuey-guest"]).toBeUndefined();
  });

  it("a header carrier (bearer OR guest) never ALSO sends cookie credentials — one carrier per read", async () => {
    for (const identity of [
      { getAccessToken: async () => "tok" },
      { guestSecret: "a".repeat(64) },
    ]) {
      const fetchImpl = mkFetch(200, OK_BODY);
      const read = createUiResourceReader({
        endpointUrl: null, // history-door-only test — declared, not forgotten
        apiBaseUrl: "https://api.example/v1",
        threadId: "t1",
        fetchImpl,
        ...identity,
      });
      await read("ui://x/y");
      const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]![1] as { credentials?: string };
      expect(init.credentials).toBeUndefined();
    }
  });

  it("maps EVERY non-OK (401/403/404/502) and transport failure to undefined — deny == miss", async () => {
    for (const status of [401, 403, 404, 502]) {
      const read = createUiResourceReader({
        endpointUrl: null, // history-door-only test — declared, not forgotten
        apiBaseUrl: "https://api.example/v1",
        threadId: "t1",
        fetchImpl: mkFetch(status),
      });
      expect(await read("ui://x/y")).toBeUndefined();
    }
    const throwing = createUiResourceReader({
      endpointUrl: null, // history-door-only test — declared, not forgotten
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await throwing("ui://x/y")).toBeUndefined();
  });

  it("a non-ggui ui:// uri resolves to the inline (self-only sandbox) channel", async () => {
    const read = createUiResourceReader({
      endpointUrl: null, // history-door-only test — declared, not forgotten
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      fetchImpl: mkFetch(200, { uri: "ui://other/app", text: "<html>y</html>" }),
    });
    expect(await read("ui://other/app")).toEqual({
      channel: "inline",
      resource: { uri: "ui://other/app", text: "<html>y</html>" },
    });
  });

  it("a malformed body (missing text) is undefined, never a broken mount", async () => {
    const read = createUiResourceReader({
      endpointUrl: null, // history-door-only test — declared, not forgotten
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      fetchImpl: mkFetch(200, { uri: "ui://x/y" }),
    });
    expect(await read("ui://x/y")).toBeUndefined();
  });

  it("a blob-only body passes through — the proxy's blob arm is not silently a miss (guuey#127)", async () => {
    const read = createUiResourceReader({
      endpointUrl: null, // history-door-only test — declared, not forgotten
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      fetchImpl: mkFetch(200, { uri: "ui://x/y", mimeType: "text/html", blob: "PGI+aGk8L2I+" }),
    });
    expect(await read("ui://x/y")).toEqual({
      channel: "inline",
      resource: { uri: "ui://x/y", mimeType: "text/html", blob: "PGI+aGk8L2I+" },
    });
  });

  // guuey#209 C1 — the two-door contract: pod door (live turns) first,
  // platform door (persisted locators) second; each miss falls through.
  describe("the pod door (endpointUrl)", () => {
    /** URL-routed mock: `answers` maps a URL PREFIX to its response. */
    function mkDoorFetch(answers: Record<string, { status: number; body?: unknown } | "throw">) {
      return vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        for (const [prefix, answer] of Object.entries(answers)) {
          if (!url.startsWith(prefix)) continue;
          if (answer === "throw") throw new Error("ECONNREFUSED");
          return {
            ok: answer.status >= 200 && answer.status < 300,
            status: answer.status,
            json: async () => answer.body,
          };
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;
    }
    const urls = (fetchImpl: typeof fetch): string[] =>
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) =>
        String(c[0]),
      );

    it("a live-turn locator resolves on the pod door alone — the platform door is never asked", async () => {
      const fetchImpl = mkDoorFetch({
        "https://pod.example/agent/ui-resource": { status: 200, body: OK_BODY },
      });
      const read = createUiResourceReader({
        apiBaseUrl: "https://api.example/v1",
        threadId: "t1",
        endpointUrl: "https://pod.example",
        guestSecret: "a".repeat(64),
        fetchImpl,
      });
      expect(await read("ui://ggui/render/s/h")).toEqual({ channel: "ggui", resource: OK_BODY });
      expect(urls(fetchImpl)).toEqual([
        "https://pod.example/agent/ui-resource?uri=ui%3A%2F%2Fggui%2Frender%2Fs%2Fh",
      ]);
      // Same identity carrier on the pod door as everywhere else.
      const headers = (
        (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as {
          headers: Record<string, string>;
        }
      ).headers;
      expect(headers["x-guuey-guest"]).toBe("a".repeat(64));
    });

    it("a pod miss (completed turn, past the grace window) falls through to the platform door", async () => {
      const fetchImpl = mkDoorFetch({
        "https://pod.example/agent/ui-resource": { status: 404 },
        "https://api.example/v1/threads/t1/ui-resource": { status: 200, body: OK_BODY },
      });
      const read = createUiResourceReader({
        apiBaseUrl: "https://api.example/v1",
        threadId: "t1",
        endpointUrl: "https://pod.example",
        fetchImpl,
      });
      expect(await read("ui://ggui/render/s/h")).toEqual({ channel: "ggui", resource: OK_BODY });
      expect(urls(fetchImpl)).toHaveLength(2);
    });

    it("a pod transport failure is a miss, not an error — the platform door is still tried", async () => {
      const fetchImpl = mkDoorFetch({
        "https://pod.example/agent/ui-resource": "throw",
        "https://api.example/v1/threads/t1/ui-resource": { status: 200, body: OK_BODY },
      });
      const read = createUiResourceReader({
        apiBaseUrl: "https://api.example/v1",
        threadId: "t1",
        endpointUrl: "https://pod.example",
        fetchImpl,
      });
      expect(await read("ui://ggui/render/s/h")).toEqual({ channel: "ggui", resource: OK_BODY });
    });

    it("accepts the full invoke URL shape and normalizes it (same rule as the transport)", async () => {
      const fetchImpl = mkDoorFetch({
        "https://pod.example/agent/ui-resource": { status: 200, body: OK_BODY },
      });
      const read = createUiResourceReader({
        apiBaseUrl: "https://api.example/v1",
        threadId: "t1",
        endpointUrl: "https://pod.example/agent/invoke",
        fetchImpl,
      });
      expect(await read("ui://ggui/render/s/h")).toBeDefined();
      expect(urls(fetchImpl)[0]).toBe(
        "https://pod.example/agent/ui-resource?uri=ui%3A%2F%2Fggui%2Frender%2Fs%2Fh",
      );
    });

    it("both doors missing is undefined — deny == miss, placeholder, never an error", async () => {
      const fetchImpl = mkDoorFetch({
        "https://pod.example/agent/ui-resource": { status: 404 },
        "https://api.example/v1/threads/t1/ui-resource": { status: 404 },
      });
      const read = createUiResourceReader({
        apiBaseUrl: "https://api.example/v1",
        threadId: "t1",
        endpointUrl: "https://pod.example",
        fetchImpl,
      });
      expect(await read("ui://ggui/render/s/h")).toBeUndefined();
    });
  });
});

// guuey#158 — the ui-action relay: the reader's credential surface on the
// POST side, answering in-band (never rejecting into the sandbox bridge).
describe("createUiActionRelay", () => {
  const OK_BODY = { content: [{ type: "text", text: "toggled" }] };
  const REQUEST = {
    resourceUri: "ui://ggui/render/s/h",
    name: "ggui_runtime_submit_action",
    arguments: { actionId: "toggle" },
  };
  function mkFetch(status: number, body?: unknown) {
    return vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  it("POSTs {uri, name, arguments} to the ui-action route and passes the result through", async () => {
    const fetchImpl = mkFetch(200, OK_BODY);
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: null, // persisted-door test — declared, not forgotten
      getAccessToken: async () => "tok",
      fetchImpl,
    });
    const out = await relay(REQUEST);
    expect(out).toEqual(OK_BODY);
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(String(call[0])).toBe("https://api.example/v1/threads/t1/ui-action");
    const init = call[1] as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({
      uri: REQUEST.resourceUri,
      name: REQUEST.name,
      arguments: REQUEST.arguments,
    });
  });

  it("every non-OK answers in-band isError — never a rejection", async () => {
    for (const status of [400, 403, 404, 502]) {
      const relay = createUiActionRelay({
        apiBaseUrl: "https://api.example/v1",
        threadId: "t1",
        endpointUrl: null, // persisted-door test — declared, not forgotten
        guestSecret: "a".repeat(64),
        fetchImpl: mkFetch(status),
      });
      const out = await relay(REQUEST);
      expect(out.isError).toBe(true);
      expect(out.content[0]!.type).toBe("text");
    }
  });

  it("a disallowed tool never reaches the network", async () => {
    const fetchImpl = mkFetch(200, OK_BODY);
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: null, // persisted-door test — declared, not forgotten
      fetchImpl,
    });
    const out = await relay({ ...REQUEST, name: "shell_exec" });
    expect(out.isError).toBe(true);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it("retries ONCE with a forceRefresh token on 401", async () => {
    const responses = [
      { ok: false, status: 401, json: async () => ({}) },
      { ok: true, status: 200, json: async () => OK_BODY },
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const getAccessToken = vi.fn(
      async (opts?: { forceRefresh?: boolean }) => (opts?.forceRefresh ? "fresh" : "stale"),
    );
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: null, // persisted-door test — declared, not forgotten
      getAccessToken,
      fetchImpl,
    });
    const out = await relay(REQUEST);
    expect(out).toEqual(OK_BODY);
    const second = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]!;
    expect(
      (second[1] as { headers: Record<string, string> }).headers["authorization"],
    ).toBe("Bearer fresh");
  });

  // guuey#222 — the pod door: the relay is the reader's two-door twin.
  const POD = "https://pod.example";
  const POD_URL = "https://pod.example/agent/ui-action";
  const PERSISTED_URL = "https://api.example/v1/threads/t1/ui-action";
  function urlsOf(fetchImpl: typeof fetch): string[] {
    return (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
  }
  function seqFetch(responses: Array<{ status: number; body?: unknown }>) {
    const q = [...responses];
    return vi.fn(async () => {
      const r = q.shift();
      if (!r) throw new Error("seqFetch: no queued response");
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    }) as unknown as typeof fetch;
  }

  it("pod door answers → result verbatim, persisted door NOT called", async () => {
    const fetchImpl = seqFetch([{ status: 200, body: OK_BODY }]);
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: POD,
      getAccessToken: async () => "tok",
      fetchImpl,
    });
    expect(await relay(REQUEST)).toEqual(OK_BODY);
    expect(urlsOf(fetchImpl)).toEqual([POD_URL]);
  });

  it("accepts a full /agent/invoke URL as the endpoint and derives the pod door from it", async () => {
    const fetchImpl = seqFetch([{ status: 200, body: OK_BODY }]);
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: `${POD}/agent/invoke`,
      guestSecret: "a".repeat(64),
      fetchImpl,
    });
    await relay(REQUEST);
    expect(urlsOf(fetchImpl)).toEqual([POD_URL]);
  });

  it("pod 404 (not live / past grace) falls through to the persisted door", async () => {
    const fetchImpl = seqFetch([{ status: 404 }, { status: 200, body: OK_BODY }]);
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: "a".repeat(64),
      fetchImpl,
    });
    expect(await relay(REQUEST)).toEqual(OK_BODY);
    expect(urlsOf(fetchImpl)).toEqual([POD_URL, PERSISTED_URL]);
  });

  it("pod 502 UPSTREAM_UNAVAILABLE is terminal — in-band isError, NO fall-through", async () => {
    const fetchImpl = seqFetch([{ status: 502 }, { status: 200, body: OK_BODY }]);
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: "a".repeat(64),
      fetchImpl,
    });
    const out = await relay(REQUEST);
    expect(out.isError).toBe(true);
    expect(urlsOf(fetchImpl)).toEqual([POD_URL]);
  });

  it("pod 400/403 are terminal too (deny is not a miss)", async () => {
    for (const status of [400, 403]) {
      const fetchImpl = seqFetch([{ status }, { status: 200, body: OK_BODY }]);
      const relay = createUiActionRelay({
        apiBaseUrl: "https://api.example/v1",
        threadId: "t1",
        endpointUrl: POD,
        guestSecret: "a".repeat(64),
        fetchImpl,
      });
      expect((await relay(REQUEST)).isError).toBe(true);
      expect(urlsOf(fetchImpl)).toEqual([POD_URL]);
    }
  });

  it("both doors 404 → in-band isError (unchanged never-reject contract)", async () => {
    const fetchImpl = seqFetch([{ status: 404 }, { status: 404 }]);
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: "a".repeat(64),
      fetchImpl,
    });
    expect((await relay(REQUEST)).isError).toBe(true);
    expect(urlsOf(fetchImpl)).toEqual([POD_URL, PERSISTED_URL]);
  });

  it("cookie mode sends credentials:'include' and NO identity headers; bearer/guest send no credentials", async () => {
    const initOf = (f: typeof fetch, i = 0) =>
      (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[i]![1] as {
        headers: Record<string, string>;
        credentials?: string;
      };
    const cookie = seqFetch([{ status: 200, body: OK_BODY }]);
    await createUiActionRelay({ apiBaseUrl: "https://api.example/v1", threadId: "t1", endpointUrl: POD, fetchImpl: cookie })(REQUEST);
    expect(initOf(cookie).credentials).toBe("include");
    expect(initOf(cookie).headers["authorization"]).toBeUndefined();
    expect(initOf(cookie).headers["x-guuey-guest"]).toBeUndefined();

    const bearer = seqFetch([{ status: 200, body: OK_BODY }]);
    await createUiActionRelay({ apiBaseUrl: "https://api.example/v1", threadId: "t1", endpointUrl: POD, getAccessToken: async () => "tok", fetchImpl: bearer })(REQUEST);
    expect(initOf(bearer).credentials).toBeUndefined();
    expect(initOf(bearer).headers["authorization"]).toBe("Bearer tok");

    const guest = seqFetch([{ status: 200, body: OK_BODY }]);
    await createUiActionRelay({ apiBaseUrl: "https://api.example/v1", threadId: "t1", endpointUrl: POD, guestSecret: "a".repeat(64), fetchImpl: guest })(REQUEST);
    expect(initOf(guest).credentials).toBeUndefined();
    expect(initOf(guest).headers["x-guuey-guest"]).toBe("a".repeat(64));
  });

  it("absent endpointUrl → persisted door only, warns ONCE; null → silent", async () => {
    __resetRelayEndpointWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f1 = seqFetch([{ status: 200, body: OK_BODY }]);
      await createUiActionRelay({ apiBaseUrl: "https://api.example/v1", threadId: "t1", fetchImpl: f1 })(REQUEST);
      expect(urlsOf(f1)).toEqual([PERSISTED_URL]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/endpointUrl/);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/mid-turn/);
      // once per module, not per construction
      createUiActionRelay({ apiBaseUrl: "https://api.example/v1", threadId: "t1", fetchImpl: f1 });
      expect(warn).toHaveBeenCalledTimes(1);
      // declared history-only viewer: silent
      __resetRelayEndpointWarning();
      createUiActionRelay({ apiBaseUrl: "https://api.example/v1", threadId: "t1", endpointUrl: null, fetchImpl: f1 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createUiResourceReader — per-resource declared CSP passthrough (guuey#312)", () => {
  it("a response carrying _meta.ui.csp yields a mount with the declaration", async () => {
    const read = createUiResourceReader({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t-312",
      endpointUrl: null, // history-only viewer: one door, one queued response
      fetchImpl: mockFetch([
        jsonResponse({
          uri: "ui://ggui/render/s/h",
          mimeType: "text/html",
          text: "<html>card</html>",
          _meta: { ui: { csp: { connectDomains: ["wss://engine.ggui.ai"] } } },
        }),
      ]),
    });
    await expect(read("ui://ggui/render/s/h")).resolves.toEqual({
      channel: "ggui",
      resource: { uri: "ui://ggui/render/s/h", mimeType: "text/html", text: "<html>card</html>" },
      csp: { connectDomains: ["wss://engine.ggui.ai"] },
    });
  });

  it("a response without _meta yields the same mount as before — undeclared, no csp key", async () => {
    const read = createUiResourceReader({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t-312",
      endpointUrl: null,
      fetchImpl: mockFetch([
        jsonResponse({ uri: "ui://weather/card", text: "<html>card</html>" }),
      ]),
    });
    await expect(read("ui://weather/card")).resolves.toEqual({
      channel: "inline",
      resource: { uri: "ui://weather/card", text: "<html>card</html>" },
    });
  });
});

describe("createUiResourceReader — the origin hint (guuey#421)", () => {
  it("origin:'history' skips the pod door — exactly ONE request, the platform door", async () => {
    const fetchImpl = mockFetch([
      jsonResponse({ uri: "ui://x/1", text: "<p>c</p>" }),
    ]);
    const read = createUiResourceReader({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t-421",
      endpointUrl: "https://pod.example", // pod door CONFIGURED — and skipped
      fetchImpl,
    });
    await expect(read("ui://x/1", { origin: "history" })).resolves.toMatchObject({
      channel: "inline",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("/threads/t-421/ui-resource");
    expect(url).not.toContain("pod.example");
  });

  it("no hint (or live) keeps pod-first — the pre-#421 order byte-identically", async () => {
    const fetchImpl = mockFetch([
      jsonResponse({ uri: "ui://x/1", text: "<p>c</p>" }),
    ]);
    const read = createUiResourceReader({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t-421",
      endpointUrl: "https://pod.example",
      fetchImpl,
    });
    await read("ui://x/1");
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("pod.example");
  });
});

describe("createUiResourceReader — pod-only assembly (guuey#368)", () => {
  it("no threadId, no apiBaseUrl: the POD door still dials and resolves — the local-dev shape", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse({ uri: "ui://fixt/1", mimeType: "text/html", text: "<p>x</p>" });
    };
    const read = createUiResourceReader({ endpointUrl: "https://pod.example", fetchImpl });
    const mount = await read("ui://fixt/1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("https://pod.example/agent/ui-resource?uri=ui%3A%2F%2Ffixt%2F1");
    expect(mount?.resource.text).toBe("<p>x</p>");
  });

  it("a pod MISS in a pod-only assembly is the honest placeholder — the platform door is never guessed at", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse({ error: "not live" }, 404);
    };
    const read = createUiResourceReader({ endpointUrl: "https://pod.example", fetchImpl });
    expect(await read("ui://fixt/1")).toBeUndefined();
    expect(calls).toHaveLength(1); // exactly the pod door; no half-built platform URL
  });

  it("both platform halves present keeps the two-door fallthrough exactly as before", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return calls.length === 1
        ? jsonResponse({ error: "not live" }, 404)
        : jsonResponse({ uri: "ui://fixt/1", text: "<p>y</p>" });
    };
    const read = createUiResourceReader({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: "https://pod.example",
      fetchImpl,
    });
    const mount = await read("ui://fixt/1");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("/threads/t1/ui-resource");
    expect(mount?.resource.text).toBe("<p>y</p>");
  });
});

describe("deleteThread — the guest-erasure door (guuey#526)", () => {
  const BASE = "https://api.example/v1";
  const fetchStub = (status: number) => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(status === 200 ? '{"deleted":true,"threadId":"t-1"}' : "{}", { status });
    }) as typeof fetch;
    return { impl, calls };
  };

  it("guest identity: exactly one carrier — the x-guuey-guest header, no credentials", async () => {
    const { impl, calls } = fetchStub(200);
    const secret = "a".repeat(64);
    const out = await deleteThread({ apiBaseUrl: BASE, threadId: "t-1", guestSecret: secret, fetchImpl: impl });
    expect(out).toBe("deleted");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/threads/t-1`);
    expect(calls[0].init?.method).toBe("DELETE");
    expect((calls[0].init?.headers as Record<string, string>)["x-guuey-guest"]).toBe(secret);
    expect(calls[0].init?.credentials).toBeUndefined();
  });

  it("bearer wins over the guest secret; neither → cookie credentials (the transport's rule verbatim)", async () => {
    const a = fetchStub(200);
    await deleteThread({
      apiBaseUrl: BASE,
      threadId: "t-1",
      getAccessToken: async () => "tok",
      guestSecret: "b".repeat(64),
      fetchImpl: a.impl,
    });
    const headers = a.calls[0].init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok");
    expect(headers["x-guuey-guest"]).toBeUndefined();

    const b = fetchStub(200);
    await deleteThread({ apiBaseUrl: BASE, threadId: "t-1", fetchImpl: b.impl });
    expect(b.calls[0].init?.credentials).toBe("include");
  });

  it("404 is SUCCESS by contract (the row is gone — repeat delete idempotency)", async () => {
    const { impl } = fetchStub(404);
    expect(await deleteThread({ apiBaseUrl: BASE, threadId: "t-1", guestSecret: "c".repeat(64), fetchImpl: impl })).toBe("deleted");
  });

  it("403 → denied; 500 → failed; a thrown fetch → failed — never a rejection", async () => {
    expect(await deleteThread({ apiBaseUrl: BASE, threadId: "t-1", fetchImpl: fetchStub(403).impl })).toBe("denied");
    expect(await deleteThread({ apiBaseUrl: BASE, threadId: "t-1", fetchImpl: fetchStub(500).impl })).toBe("failed");
    const throwing = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    expect(await deleteThread({ apiBaseUrl: BASE, threadId: "t-1", fetchImpl: throwing })).toBe("failed");
  });

  it("401 with a bearer in play → ONE forceRefresh retry carrying the fresh token", async () => {
    const seen: Array<Record<string, string>> = [];
    let n = 0;
    const impl = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      n += 1;
      return new Response("{}", { status: n === 1 ? 401 : 200 });
    }) as typeof fetch;
    const getAccessToken = vi.fn(async (opts?: { forceRefresh?: boolean }) =>
      opts?.forceRefresh === true ? "fresh" : "stale",
    );
    const out = await deleteThread({ apiBaseUrl: BASE, threadId: "t-1", getAccessToken, fetchImpl: impl });
    expect(out).toBe("deleted");
    expect(seen).toHaveLength(2);
    expect(seen[0]["authorization"]).toBe("Bearer stale");
    expect(seen[1]["authorization"]).toBe("Bearer fresh");
  });
});
