import { describe, it, expect, vi } from "vitest";
import { createWebAdapters, fetchStreamTransport } from "./web-adapters";
import type { InvokeRequest } from "./types";

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

function invokeRequest(): InvokeRequest {
  return {
    url: "https://pod.example.com/agent/invoke",
    body: { input: "hi", clientMessageId: "cmid-1" },
    signal: new AbortController().signal,
  };
}

/** Drive an invoke stream to completion and return the concatenated chunks. */
async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

describe("fetchStreamTransport identity headers", () => {
  it("sends a bearer and no cookie credentials when a token is present", async () => {
    const fetchImpl = mockFetch([sseResponse()]);
    await withGlobalFetch(fetchImpl, () => drain(fetchStreamTransport(invokeRequest(), "tok_abc")));
    const init = fetchImpl.mock.calls[0][1];
    expect(headersOf(init).Authorization).toBe("Bearer tok_abc");
    expect(headersOf(init)["x-guuey-guest"]).toBeUndefined();
    expect(init?.credentials).toBeUndefined();
  });

  it("falls back to cookie credentials when neither identity is present", async () => {
    const fetchImpl = mockFetch([sseResponse()]);
    await withGlobalFetch(fetchImpl, () => drain(fetchStreamTransport(invokeRequest())));
    const init = fetchImpl.mock.calls[0][1];
    expect(init?.credentials).toBe("include");
    expect(headersOf(init).Authorization).toBeUndefined();
    expect(headersOf(init)["x-guuey-guest"]).toBeUndefined();
  });

  it("sends the guest header — and no cookie credentials — for a well-formed secret", async () => {
    const fetchImpl = mockFetch([sseResponse()]);
    await withGlobalFetch(fetchImpl, () =>
      drain(fetchStreamTransport(invokeRequest(), null, SECRET)),
    );
    const init = fetchImpl.mock.calls[0][1];
    expect(headersOf(init)["x-guuey-guest"]).toBe(SECRET);
    expect(headersOf(init).Authorization).toBeUndefined();
    expect(init?.credentials).toBeUndefined();
  });

  it("prefers the bearer and never carries two identities at once", async () => {
    const fetchImpl = mockFetch([sseResponse()]);
    await withGlobalFetch(fetchImpl, () =>
      drain(fetchStreamTransport(invokeRequest(), "tok_abc", SECRET)),
    );
    const init = fetchImpl.mock.calls[0][1];
    expect(headersOf(init).Authorization).toBe("Bearer tok_abc");
    expect(headersOf(init)["x-guuey-guest"]).toBeUndefined();
    expect(init?.credentials).toBeUndefined();
  });

  it.each([
    ["too short", "abc123"],
    ["too long", SECRET + "ab"],
    ["non-hex chars", "z".repeat(64)],
    ["uppercase hex", SECRET.toUpperCase()],
    ["empty", ""],
    ["whitespace-padded", ` ${SECRET} `],
  ])("ignores a malformed secret (%s) and falls back to cookie mode", async (_label, bad) => {
    const fetchImpl = mockFetch([sseResponse()]);
    await withGlobalFetch(fetchImpl, () => drain(fetchStreamTransport(invokeRequest(), null, bad)));
    const init = fetchImpl.mock.calls[0][1];
    expect(headersOf(init)["x-guuey-guest"]).toBeUndefined();
    expect(init?.credentials).toBe("include");
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
    expect(result).toEqual({ messages: [{ role: "user", text: "hi" }], cards: [] });
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
    expect(result).toEqual({ messages: [{ role: "user", text: "hi" }], cards: [] });
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
