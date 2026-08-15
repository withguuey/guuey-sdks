import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { fetchStreamTransport } from "./transport.js";
import { AgentResponseError } from "./errors.js";
import { AGENT_ERROR_CODES } from "./error-codes.js";
import type { InvokeRequest } from "./types.js";

/** A well-formed guest secret: 64 lowercase hex chars. */
const SECRET = "0123456789abcdef".repeat(4);

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

/**
 * The guarantee this module EXISTS for (guuey#186 G2): the transport's import
 * closure must never reach `@guuey/mcp-apps-host` — that graph is what a
 * transport-only consumer is escaping. Walked statically over the SOURCE
 * files (tsc preserves the module structure 1:1 into dist), so a future
 * import added anywhere in the closure fails here, not in a consumer's build.
 */
describe("transport module import closure", () => {
  it("never imports @guuey/mcp-apps-host, directly or transitively", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const seen = new Set<string>();
    const queue = ["transport.ts"];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(join(srcDir, file), "utf-8");
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1];
        expect(specifier, `${file} imports ${specifier}`).not.toContain("mcp-apps-host");
        if (specifier.startsWith("./")) {
          queue.push(specifier.slice(2).replace(/\.js$/, ".ts"));
        }
      }
    }
    // The closure the docblock promises — a new module joining it is a
    // deliberate decision, not drift.
    expect([...seen].sort()).toEqual([
      "error-codes.ts",
      "errors.ts",
      "saturation-retry.ts",
      "transport.ts",
      "types.ts",
    ]);
  });
});

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
});
