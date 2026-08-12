import { describe, it, expect, vi } from "vitest";
import {
  createUiActionRelay,
  createUiResourceReader,
  createWebAdapters,
  fetchStreamTransport,
} from "./web-adapters.js";
import { AgentResponseError } from "./errors.js";
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

/** Capture what the transport waited, without waiting. */
function fakeSleep() {
  const waits: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    waits.push(ms);
  });
  return { sleep, waits };
}

/** Drive a stream expecting it to reject, and return the thrown error. */
async function rejection(stream: AsyncIterable<string>): Promise<unknown> {
  try {
    await drain(stream);
  } catch (err) {
    return err;
  }
  throw new Error("expected the stream to reject");
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

/**
 * The failure envelope itself: a non-OK invoke becomes an `AgentResponseError`
 * carrying the pod's structured `{code, message}` plus its `Retry-After` hint.
 * Every consumer branch downstream (the hook's `errorCode`, the saturation
 * retry, the surfaces' upgrade copy) reads those fields, and nothing pinned
 * them before scaling S1-F5.
 */
describe("fetchStreamTransport — AgentResponseError envelope", () => {
  it("carries the pod's code, message, status and Retry-After hint", async () => {
    const fetchImpl = mockFetch([
      refusal(AGENT_ERROR_CODES.DRAINING, 503, "7", "this pod is shutting down; retry shortly"),
    ]);
    const err = await withGlobalFetch(fetchImpl, () => rejection(fetchStreamTransport(invokeRequest())));
    expect(err).toBeInstanceOf(AgentResponseError);
    const responseError = err as AgentResponseError;
    expect(responseError.message).toBe("this pod is shutting down; retry shortly");
    expect(responseError.status).toBe(503);
    expect(responseError.code).toBe("DRAINING");
    expect(responseError.retryAfterSeconds).toBe(7);
  });

  it("leaves retryAfterSeconds undefined when the response sent no hint", async () => {
    const fetchImpl = mockFetch([
      refusal(AGENT_ERROR_CODES.QUOTA_EXCEEDED, 429, undefined, "you've reached your plan limit"),
    ]);
    const err = (await withGlobalFetch(fetchImpl, () =>
      rejection(fetchStreamTransport(invokeRequest())),
    )) as AgentResponseError;
    expect(err.code).toBe("QUOTA_EXCEEDED");
    expect(err.message).toBe("you've reached your plan limit");
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it.each([
    ["an HTTP-date", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ["a fractional value", "12.5"],
    ["a negative value", "-5"],
    ["empty", ""],
    ["non-numeric", "soon"],
  ])("ignores a Retry-After we cannot read as whole seconds (%s)", async (_label, header) => {
    const fetchImpl = mockFetch([refusal(AGENT_ERROR_CODES.DRAINING, 503, header)]);
    const err = (await withGlobalFetch(fetchImpl, () =>
      rejection(fetchStreamTransport(invokeRequest())),
    )) as AgentResponseError;
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("falls back to the bare status when the body is not JSON", async () => {
    const fetchImpl = mockFetch([
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    ]);
    const err = (await withGlobalFetch(fetchImpl, () =>
      rejection(fetchStreamTransport(invokeRequest())),
    )) as AgentResponseError;
    expect(err).toBeInstanceOf(AgentResponseError);
    expect(err.message).toBe("agent responded 502");
    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("falls back to the bare status for a JSON body with no usable code/message", async () => {
    const fetchImpl = mockFetch([jsonResponse({ code: 7, message: "" }, 500)]);
    const err = (await withGlobalFetch(fetchImpl, () =>
      rejection(fetchStreamTransport(invokeRequest())),
    )) as AgentResponseError;
    expect(err.message).toBe("agent responded 500");
    expect(err.code).toBeUndefined();
  });
});

/**
 * Scaling S1-F5 (guuey#162): a pod at its concurrent-turn cap refuses with
 * `POD_SATURATED` + `Retry-After`, which is transient by construction — the
 * transport spends the hint and re-sends ONCE so the user doesn't have to.
 * Everything else about the refusal vocabulary is left alone on purpose.
 */
describe("fetchStreamTransport — POD_SATURATED auto-retry", () => {
  it("waits the hinted delay and streams the second attempt", async () => {
    const fetchImpl = mockFetch([saturated("3"), sseResponse("data: ok\n\n")]);
    const { sleep, waits } = fakeSleep();
    const out = await withGlobalFetch(fetchImpl, () =>
      drain(fetchStreamTransport(invokeRequest(), null, null, { sleep })),
    );
    expect(out).toBe("data: ok\n\n");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([3000]);
  });

  it("waits the 15s fallback when the refusal carries no readable hint", async () => {
    const fetchImpl = mockFetch([saturated(), sseResponse("data: ok\n\n")]);
    const { sleep, waits } = fakeSleep();
    await withGlobalFetch(fetchImpl, () =>
      drain(fetchStreamTransport(invokeRequest(), null, null, { sleep })),
    );
    expect(waits).toEqual([15000]);
  });

  it("caps the honoured hint at 30s — a chat must not park in `connecting` for minutes", async () => {
    const fetchImpl = mockFetch([saturated("600"), sseResponse("data: ok\n\n")]);
    const { sleep, waits } = fakeSleep();
    await withGlobalFetch(fetchImpl, () =>
      drain(fetchStreamTransport(invokeRequest(), null, null, { sleep })),
    );
    expect(waits).toEqual([30000]);
  });

  it("retries EXACTLY once — a second saturation surfaces rather than looping", async () => {
    const fetchImpl = mockFetch([saturated("1"), saturated("1")]);
    const { sleep, waits } = fakeSleep();
    const err = (await withGlobalFetch(fetchImpl, () =>
      rejection(fetchStreamTransport(invokeRequest(), null, null, { sleep })),
    )) as AgentResponseError;
    expect(err.code).toBe("POD_SATURATED");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([1000]);
  });

  it("does NOT retry DRAINING — the useful retry reaches a different pod, which this cannot do", async () => {
    const fetchImpl = mockFetch([refusal(AGENT_ERROR_CODES.DRAINING, 503, "15")]);
    const { sleep } = fakeSleep();
    const err = (await withGlobalFetch(fetchImpl, () =>
      rejection(fetchStreamTransport(invokeRequest(), null, null, { sleep })),
    )) as AgentResponseError;
    expect(err.code).toBe("DRAINING");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ["a quota refusal", refusal(AGENT_ERROR_CODES.QUOTA_EXCEEDED, 429)],
    ["an unauthorized refusal", refusal(AGENT_ERROR_CODES.UNAUTHORIZED, 401)],
    ["a codeless 500", new Response("boom", { status: 500 })],
  ])("does not retry %s", async (_label, response) => {
    const fetchImpl = mockFetch([response]);
    const { sleep } = fakeSleep();
    await withGlobalFetch(fetchImpl, () =>
      rejection(fetchStreamTransport(invokeRequest(), null, null, { sleep })),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never replays a stream that already yielded — a partial turn is not re-sent", async () => {
    // Synthetic by construction: the pod cannot refuse mid-stream (it answers
    // POD_SATURATED before the SSE body opens). The guard is pinned anyway
    // because a replay here would duplicate a partial assistant turn — the
    // failure mode is silent and user-visible, so "unreachable today" is not
    // a reason to leave it untested.
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      // Enqueue-then-error in `start` would NOT do: `error()` clears the queue,
      // so the chunk never reaches the reader and nothing is yielded. Erroring
      // on the SECOND pull is what puts a delivered chunk before the failure.
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode("data: partial\n\n"));
          return;
        }
        controller.error(new AgentResponseError("saturated", 503, "POD_SATURATED", 1));
      },
    });
    const fetchImpl = mockFetch([
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    ]);
    const { sleep } = fakeSleep();
    const chunks: string[] = [];
    await withGlobalFetch(fetchImpl, async () => {
      const stream = fetchStreamTransport(invokeRequest(), null, null, { sleep });
      await expect(
        (async () => {
          for await (const chunk of stream) chunks.push(chunk);
        })(),
      ).rejects.toThrow("saturated");
    });
    expect(chunks).toEqual(["data: partial\n\n"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("skips the retry when the turn is aborted during the wait", async () => {
    const controller = new AbortController();
    const fetchImpl = mockFetch([saturated("5")]);
    const sleep = vi.fn(async () => {
      controller.abort();
    });
    const err = (await withGlobalFetch(fetchImpl, () =>
      rejection(fetchStreamTransport(invokeRequest(controller.signal), null, null, { sleep })),
    )) as AgentResponseError;
    // The original refusal, not a follow-on AbortError: it is the honest cause.
    expect(err.code).toBe("POD_SATURATED");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

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

  it("maps EVERY non-OK (401/403/404/502) and transport failure to undefined — deny == miss", async () => {
    for (const status of [401, 403, 404, 502]) {
      const read = createUiResourceReader({
        apiBaseUrl: "https://api.example/v1",
        threadId: "t1",
        fetchImpl: mkFetch(status),
      });
      expect(await read("ui://x/y")).toBeUndefined();
    }
    const throwing = createUiResourceReader({
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
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      fetchImpl: mkFetch(200, { uri: "ui://x/y" }),
    });
    expect(await read("ui://x/y")).toBeUndefined();
  });

  it("a blob-only body passes through — the proxy's blob arm is not silently a miss (guuey#127)", async () => {
    const read = createUiResourceReader({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      fetchImpl: mkFetch(200, { uri: "ui://x/y", mimeType: "text/html", blob: "PGI+aGk8L2I+" }),
    });
    expect(await read("ui://x/y")).toEqual({
      channel: "inline",
      resource: { uri: "ui://x/y", mimeType: "text/html", blob: "PGI+aGk8L2I+" },
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
});
