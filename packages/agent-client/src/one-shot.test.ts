/**
 * guuey#2492 — every one-shot call takes a caller `signal` and a `timeoutMs`,
 * and a hung request can no longer hold its caller until the platform's own
 * network timeout gives up (about a minute on React Native iOS).
 *
 * Two hanging fetch stubs pin the two worlds a host can be in: one that
 * honours the signal the way a real `fetch` does (rejects with an AbortError),
 * and one that ignores it entirely (a polyfill that never settles). The call
 * must settle on the abort or the timeout in BOTH.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHitlAnswerRelay,
  createUiActionRelay,
  createUiResourceReader,
  deleteThread,
} from "./web-adapters.js";
import { dismissLinkPrompt } from "./link-prompt.js";
import { mergeGuestThreads } from "./guest-merge.js";
import { fetchThreadHistory } from "./history.js";
import { RequestCancelledError } from "./errors.js";
import { CLIENT_ERROR_CODES } from "./error-codes.js";

const BASE = "https://api.example/v1";
const POD = "https://pod.example";

interface SeenRequest {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that never answers; it rejects on its signal like a real `fetch`. */
function hangingFetch(): { impl: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const impl: typeof fetch = (input, init) => {
    seen.push({ url: String(input), init });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  return { impl, seen };
}

/** A fetch that never settles and ignores every signal (the worst polyfill). */
function deafFetch(): { impl: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const impl: typeof fetch = (input, init) => {
    seen.push({ url: String(input), init });
    return new Promise<Response>(() => {});
  };
  return { impl, seen };
}

/** Answers each request from `answer`, recording it. */
function scriptedFetch(answer: (url: string, n: number) => Response | "hang"): {
  impl: typeof fetch;
  seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  const hang = hangingFetch();
  const impl: typeof fetch = (input, init) => {
    seen.push({ url: String(input), init });
    const out = answer(String(input), seen.length);
    if (out === "hang") return hang.impl(input, init);
    return Promise.resolve(out);
  };
  return { impl, seen };
}

/** Settle-or-not probe: `undefined` while the promise is still pending. */
function track<T>(p: Promise<T>): { readonly value: T | undefined; readonly error: unknown; readonly settled: boolean } {
  const state: { value: T | undefined; error: unknown; settled: boolean } = {
    value: undefined,
    error: undefined,
    settled: false,
  };
  p.then(
    (v) => {
      state.value = v;
      state.settled = true;
    },
    (e: unknown) => {
      state.error = e;
      state.settled = true;
    },
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("deleteThread — signal and timeoutMs (guuey#2492)", () => {
  it("a hung DELETE settles as 'failed' once timeoutMs passes (the issue's never-throws ask), and the request is aborted", async () => {
    const { impl, seen } = hangingFetch();
    const out = track(deleteThread({ apiBaseUrl: BASE, threadId: "t-1", fetchImpl: impl, timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(out.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(out.value).toBe("failed");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init?.signal?.aborted).toBe(true);
  });

  it("settles on the timeout even when the fetch ignores its signal entirely", async () => {
    const { impl } = deafFetch();
    const out = track(deleteThread({ apiBaseUrl: BASE, threadId: "t-1", fetchImpl: impl, timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.value).toBe("failed");
  });

  it("the caller's abort settles the call as 'failed' at once and aborts the request in flight", async () => {
    const { impl, seen } = hangingFetch();
    const controller = new AbortController();
    const out = track(deleteThread({ apiBaseUrl: BASE, threadId: "t-1", fetchImpl: impl, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    expect(out.settled).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.value).toBe("failed");
    expect(seen[0]!.init?.signal?.aborted).toBe(true);
  });

  it("an already-aborted signal sends nothing", async () => {
    const { impl, seen } = hangingFetch();
    const controller = new AbortController();
    controller.abort();
    expect(await deleteThread({ apiBaseUrl: BASE, threadId: "t-1", fetchImpl: impl, signal: controller.signal })).toBe(
      "failed",
    );
    expect(seen).toHaveLength(0);
  });

  it("a timeoutMs of zero or less times out at once and sends nothing, even with no await before the request", async () => {
    for (const timeoutMs of [0, -5]) {
      const { impl, seen } = scriptedFetch(() => new Response("{}", { status: 200 }));
      const out = await deleteThread({ apiBaseUrl: BASE, threadId: "t-1", guestSecret: "a".repeat(64), fetchImpl: impl, timeoutMs });
      expect(out).toBe("failed");
      expect(seen).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("an abort while waiting on getAccessToken stops there: no request is sent, even once the token arrives", async () => {
    const { impl, seen } = hangingFetch();
    let release: (token: string) => void = () => {};
    const getAccessToken = () => new Promise<string | null>((resolve) => (release = resolve));
    const controller = new AbortController();
    const out = track(
      deleteThread({ apiBaseUrl: BASE, threadId: "t-1", getAccessToken, fetchImpl: impl, signal: controller.signal }),
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.value).toBe("failed");
    release("tok");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(0);
  });

  it("the timeout also covers the 401 retry: one budget for the whole call", async () => {
    // The 401 answers at t=1500, so the retry starts late: one budget settles
    // the call at t=2000, a fresh budget per request would wait to t=3500.
    const hang = hangingFetch();
    const seen: SeenRequest[] = [];
    const impl: typeof fetch = (input, init) => {
      seen.push({ url: String(input), init });
      if (seen.length > 1) return hang.impl(input, init);
      return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}", { status: 401 })), 1_500));
    };
    const getAccessToken = async (opts?: { forceRefresh?: boolean }) => (opts?.forceRefresh ? "fresh" : "stale");
    const out = track(
      deleteThread({ apiBaseUrl: BASE, threadId: "t-1", getAccessToken, fetchImpl: impl, timeoutMs: 2_000 }),
    );
    await vi.advanceTimersByTimeAsync(1_500);
    expect(seen).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(out.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(out.value).toBe("failed");
    expect(seen).toHaveLength(2);
    expect(new Headers(seen[1]!.init?.headers).get("authorization")).toBe("Bearer fresh");
    expect(seen[1]!.init?.signal?.aborted).toBe(true);
  });

  it("a timely answer is unchanged: same request, the timer is cleared and the caller's listener removed", async () => {
    const { impl, seen } = scriptedFetch(() => new Response("{}", { status: 200 }));
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const out = await deleteThread({
      apiBaseUrl: BASE,
      threadId: "t-1",
      guestSecret: "a".repeat(64),
      fetchImpl: impl,
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    expect(out).toBe("deleted");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init?.method).toBe("DELETE");
    expect(new Headers(seen[0]!.init?.headers).get("x-guuey-guest")).toBe("a".repeat(64));
    expect(vi.getTimerCount()).toBe(0);
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("without signal or timeoutMs the request init is exactly what it was (no signal added)", async () => {
    const { impl, seen } = scriptedFetch(() => new Response("{}", { status: 200 }));
    await deleteThread({ apiBaseUrl: BASE, threadId: "t-1", fetchImpl: impl });
    expect(seen[0]!.init).toEqual({ method: "DELETE", headers: {}, credentials: "include" });
  });

  it("a timeoutMs past setTimeout's limit waits the longest timer, never fires at once", async () => {
    const { impl } = hangingFetch();
    const out = track(deleteThread({ apiBaseUrl: BASE, threadId: "t-1", fetchImpl: impl, timeoutMs: 3_000_000_000 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(out.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_147_483_647 - 10);
    expect(out.value).toBe("failed");
  });

  it("a non-finite timeoutMs sets no limit", async () => {
    const { impl } = hangingFetch();
    const out = track(
      deleteThread({ apiBaseUrl: BASE, threadId: "t-1", fetchImpl: impl, timeoutMs: Number.POSITIVE_INFINITY }),
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(out.settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createHitlAnswerRelay — signal and timeoutMs (guuey#2492)", () => {
  const ANSWER = { askId: "ask-1", status: "resolved" as const };

  it("a hung answer settles as REQUEST_TIMEOUT (status 0)", async () => {
    const { impl } = hangingFetch();
    const relay = createHitlAnswerRelay({ endpointUrl: POD, fetchImpl: impl, timeoutMs: 3_000 });
    const out = track(relay(ANSWER));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(out.value).toEqual({
      ok: false,
      status: 0,
      code: CLIENT_ERROR_CODES.REQUEST_TIMEOUT,
      message: expect.any(String),
    });
  });

  it("the caller's abort settles as REQUEST_ABORTED", async () => {
    const { impl } = deafFetch();
    const controller = new AbortController();
    const relay = createHitlAnswerRelay({ endpointUrl: POD, fetchImpl: impl, cancelSignal: controller.signal });
    const out = track(relay(ANSWER));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.value).toMatchObject({ ok: false, status: 0, code: CLIENT_ERROR_CODES.REQUEST_ABORTED });
  });
});

describe("the relays' wake signal stays a wake signal (guuey#2452 kept, guuey#2492)", () => {
  it("createHitlAnswerRelay: aborting `signal` leaves the answer in flight alone and still reads its answer", async () => {
    const { impl, seen } = hangingFetch();
    const controller = new AbortController();
    const relay = createHitlAnswerRelay({ endpointUrl: POD, fetchImpl: impl, signal: controller.signal });
    const out = track(relay({ askId: "ask-1", status: "resolved" }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.settled).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init?.signal?.aborted ?? false).toBe(false);
  });

  it("createUiActionRelay: aborting `signal` leaves the click in flight alone", async () => {
    const { impl, seen } = hangingFetch();
    const controller = new AbortController();
    const relay = createUiActionRelay({
      apiBaseUrl: BASE,
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: "a".repeat(64),
      fetchImpl: impl,
      signal: controller.signal,
    });
    const out = track(relay({ resourceUri: "ui://x/y", name: "ggui_runtime_submit_action", arguments: {} }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.settled).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init?.signal?.aborted ?? false).toBe(false);
  });
});

describe("createUiResourceReader — signal and timeoutMs (guuey#2492)", () => {
  const OK_BODY = { uri: "ui://x/y", mimeType: "text/html", text: "<p>x</p>" };

  it("a hung pod door times out as a miss and the platform door still answers", async () => {
    const { impl, seen } = scriptedFetch((url) =>
      url.startsWith(POD) ? "hang" : new Response(JSON.stringify(OK_BODY), { status: 200 }),
    );
    const read = createUiResourceReader({
      endpointUrl: POD,
      apiBaseUrl: BASE,
      threadId: "t1",
      guestSecret: "a".repeat(64),
      fetchImpl: impl,
      timeoutMs: 1_000,
    });
    const out = track(read("ui://x/y"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.value?.resource.text).toBe("<p>x</p>");
    expect(seen).toHaveLength(2);
    expect(seen[0]!.init?.signal?.aborted).toBe(true);
  });

  it("the caller's abort is a miss and the next door is never asked", async () => {
    const { impl, seen } = hangingFetch();
    const controller = new AbortController();
    const read = createUiResourceReader({
      endpointUrl: POD,
      apiBaseUrl: BASE,
      threadId: "t1",
      guestSecret: "a".repeat(64),
      fetchImpl: impl,
      signal: controller.signal,
    });
    const out = track(read("ui://x/y"));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.settled).toBe(true);
    expect(out.value).toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});

describe("createUiActionRelay — signal and timeoutMs (guuey#2492)", () => {
  it("a hung pod door times out and the click answers in-band as an error", async () => {
    const { impl, seen } = deafFetch();
    const relay = createUiActionRelay({
      apiBaseUrl: BASE,
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: "a".repeat(64),
      fetchImpl: impl,
      timeoutMs: 1_000,
    });
    const out = track(relay({ resourceUri: "ui://x/y", name: "ggui_runtime_submit_action", arguments: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.settled).toBe(true);
    expect(out.value).toMatchObject({ isError: true });
    expect(seen).toHaveLength(1);
  });

  it("the caller's abort answers the click in-band at once, aborts the request, and a later click sends nothing", async () => {
    const { impl, seen } = hangingFetch();
    const controller = new AbortController();
    const relay = createUiActionRelay({
      apiBaseUrl: BASE,
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: "a".repeat(64),
      fetchImpl: impl,
      cancelSignal: controller.signal,
    });
    const action = { resourceUri: "ui://x/y", name: "ggui_runtime_submit_action", arguments: {} };
    const out = track(relay(action));
    await vi.advanceTimersByTimeAsync(0);
    expect(out.settled).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.value).toMatchObject({ isError: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init?.signal?.aborted).toBe(true);
    expect(await relay(action)).toMatchObject({ isError: true });
    expect(seen).toHaveLength(1);
  });
});

/**
 * A bearer that answers "stale" at once and holds its forceRefresh answer
 * until `release` (or answers "fresh" at once when `held` is false).
 */
function refreshingToken(held: boolean): {
  getAccessToken: (opts?: { forceRefresh?: boolean }) => Promise<string | null>;
  release: (token: string) => void;
} {
  let release: (token: string) => void = () => {};
  const getAccessToken = (opts?: { forceRefresh?: boolean }): Promise<string | null> => {
    if (!opts?.forceRefresh) return Promise.resolve("stale");
    if (!held) return Promise.resolve("fresh");
    return new Promise<string | null>((resolve) => (release = resolve));
  };
  return { getAccessToken, release: (token) => release(token) };
}

/** The pod answers 401 first, then hangs on the retry. */
const unauthorizedThenHang = (_url: string, n: number): Response | "hang" =>
  n === 1 ? new Response("{}", { status: 401 }) : "hang";

/** The pod answers 401 first, then 200 to anything that still reaches it. */
const unauthorizedThenOk = (_url: string, n: number): Response | "hang" =>
  n === 1 ? new Response("{}", { status: 401 }) : new Response("{}", { status: 200 });

describe("the single 401 retry runs under the call's scope (guuey#2492)", () => {
  const ANSWER = { askId: "ask-1", status: "resolved" as const };
  const ACTION = { resourceUri: "ui://x/y", name: "ggui_runtime_submit_action", arguments: {} };

  it("createUiResourceReader: the timeout aborts the retried read too", async () => {
    const { impl, seen } = scriptedFetch(unauthorizedThenHang);
    const read = createUiResourceReader({
      endpointUrl: POD,
      getAccessToken: refreshingToken(false).getAccessToken,
      fetchImpl: impl,
      timeoutMs: 2_000,
    });
    const out = track(read("ui://x/y"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(out.settled).toBe(true);
    expect(out.value).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(new Headers(seen[1]!.init?.headers).get("authorization")).toBe("Bearer fresh");
    expect(seen[1]!.init?.signal?.aborted).toBe(true);
  });

  it("createUiResourceReader: an abort while forceRefresh resolves sends no retry, even once the token arrives", async () => {
    const { impl, seen } = scriptedFetch(unauthorizedThenOk);
    const token = refreshingToken(true);
    const controller = new AbortController();
    const read = createUiResourceReader({
      endpointUrl: POD,
      getAccessToken: token.getAccessToken,
      fetchImpl: impl,
      signal: controller.signal,
    });
    const out = track(read("ui://x/y"));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.settled).toBe(true);
    expect(out.value).toBeUndefined();
    token.release("fresh");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
  });

  it("createUiActionRelay: the timeout aborts the retried POST too", async () => {
    const { impl, seen } = scriptedFetch(unauthorizedThenHang);
    const relay = createUiActionRelay({
      apiBaseUrl: BASE,
      threadId: "t1",
      endpointUrl: POD,
      getAccessToken: refreshingToken(false).getAccessToken,
      fetchImpl: impl,
      timeoutMs: 2_000,
    });
    const out = track(relay(ACTION));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(out.value).toMatchObject({ isError: true });
    expect(seen).toHaveLength(2);
    expect(new Headers(seen[1]!.init?.headers).get("authorization")).toBe("Bearer fresh");
    expect(seen[1]!.init?.signal?.aborted).toBe(true);
  });

  it("createUiActionRelay: an abort while forceRefresh resolves sends no retry, even once the token arrives", async () => {
    const { impl, seen } = scriptedFetch(unauthorizedThenOk);
    const token = refreshingToken(true);
    const controller = new AbortController();
    const relay = createUiActionRelay({
      apiBaseUrl: BASE,
      threadId: "t1",
      endpointUrl: POD,
      getAccessToken: token.getAccessToken,
      fetchImpl: impl,
      cancelSignal: controller.signal,
    });
    const out = track(relay(ACTION));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.value).toMatchObject({ isError: true });
    token.release("fresh");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
  });

  it("createHitlAnswerRelay: the timeout aborts the retried answer too", async () => {
    const { impl, seen } = scriptedFetch(unauthorizedThenHang);
    const relay = createHitlAnswerRelay({
      endpointUrl: POD,
      getAccessToken: refreshingToken(false).getAccessToken,
      fetchImpl: impl,
      timeoutMs: 2_000,
    });
    const out = track(relay(ANSWER));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(out.value).toMatchObject({ ok: false, status: 0, code: CLIENT_ERROR_CODES.REQUEST_TIMEOUT });
    expect(seen).toHaveLength(2);
    expect(new Headers(seen[1]!.init?.headers).get("authorization")).toBe("Bearer fresh");
    expect(seen[1]!.init?.signal?.aborted).toBe(true);
  });

  it("createHitlAnswerRelay: an abort while forceRefresh resolves sends no retry, even once the token arrives", async () => {
    const { impl, seen } = scriptedFetch(unauthorizedThenOk);
    const token = refreshingToken(true);
    const controller = new AbortController();
    const relay = createHitlAnswerRelay({
      endpointUrl: POD,
      getAccessToken: token.getAccessToken,
      fetchImpl: impl,
      cancelSignal: controller.signal,
    });
    const out = track(relay(ANSWER));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.value).toMatchObject({ ok: false, status: 0, code: CLIENT_ERROR_CODES.REQUEST_ABORTED });
    token.release("fresh");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
  });
});

describe("dismissLinkPrompt — signal and timeoutMs (guuey#2492)", () => {
  it("a hung dismiss rejects with RequestCancelledError reason 'timeout'", async () => {
    const { impl } = hangingFetch();
    const out = track(dismissLinkPrompt(BASE, "tok", impl, { timeoutMs: 2_000 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(out.error).toBeInstanceOf(RequestCancelledError);
    expect(out.error).toMatchObject({ reason: "timeout", code: CLIENT_ERROR_CODES.REQUEST_TIMEOUT });
  });

  it("a timeoutMs of zero or less rejects with reason 'timeout' and sends nothing", async () => {
    const { impl, seen } = hangingFetch();
    const out = track(dismissLinkPrompt(BASE, "tok", impl, { timeoutMs: -5 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(out.error).toBeInstanceOf(RequestCancelledError);
    expect(out.error).toMatchObject({ reason: "timeout", code: CLIENT_ERROR_CODES.REQUEST_TIMEOUT });
    expect(seen).toHaveLength(0);
  });

  it("the caller's abort rejects with reason 'aborted'", async () => {
    const { impl } = hangingFetch();
    const controller = new AbortController();
    const out = track(dismissLinkPrompt(BASE, "tok", impl, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.error).toMatchObject({ reason: "aborted", code: CLIENT_ERROR_CODES.REQUEST_ABORTED });
  });
});

describe("mergeGuestThreads — signal and timeoutMs (guuey#2492)", () => {
  it("a hung merge settles as REQUEST_TIMEOUT (status 0)", async () => {
    const { impl } = hangingFetch();
    const out = track(
      mergeGuestThreads({ apiBaseUrl: BASE, appId: "app-1", getAccessToken: async () => "tok", fetchImpl: impl, timeoutMs: 1_000 }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.value).toEqual({ supported: true, ok: false, status: 0, code: CLIENT_ERROR_CODES.REQUEST_TIMEOUT });
  });

  it("the caller's abort settles as REQUEST_ABORTED", async () => {
    const { impl } = hangingFetch();
    const controller = new AbortController();
    const out = track(
      mergeGuestThreads({
        apiBaseUrl: BASE,
        appId: "app-1",
        getAccessToken: async () => "tok",
        fetchImpl: impl,
        signal: controller.signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.value).toEqual({ supported: true, ok: false, status: 0, code: CLIENT_ERROR_CODES.REQUEST_ABORTED });
  });
});

describe("fetchThreadHistory — signal and timeoutMs (guuey#2492)", () => {
  it("a hung page rejects with RequestCancelledError reason 'timeout'", async () => {
    const { impl } = hangingFetch();
    const out = track(fetchThreadHistory({ baseUrl: BASE, threadId: "t1", fetchImpl: impl, timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.error).toBeInstanceOf(RequestCancelledError);
    expect(out.error).toMatchObject({ reason: "timeout" });
  });

  it("with only requestInit.signal (neither new option), requestInit reaches fetch untouched and an abort rejects with fetch's own AbortError", async () => {
    const { impl, seen } = hangingFetch();
    const controller = new AbortController();
    const requestInit: RequestInit = { headers: { authorization: "Bearer t" }, signal: controller.signal };
    const out = track(fetchThreadHistory({ baseUrl: BASE, threadId: "t1", fetchImpl: impl, requestInit }));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init).toBe(requestInit);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.error).toBeInstanceOf(DOMException);
    expect(out.error).toMatchObject({ name: "AbortError" });
    expect(out.error).not.toBeInstanceOf(RequestCancelledError);
  });

  it("with only an already-aborted requestInit.signal, the request still reaches fetch, which rejects with its AbortError", async () => {
    const { impl, seen } = hangingFetch();
    const controller = new AbortController();
    controller.abort();
    const requestInit: RequestInit = { signal: controller.signal };
    const out = track(fetchThreadHistory({ baseUrl: BASE, threadId: "t1", fetchImpl: impl, requestInit }));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init).toBe(requestInit);
    expect(out.error).toMatchObject({ name: "AbortError" });
    expect(out.error).not.toBeInstanceOf(RequestCancelledError);
  });

  it("with a new option given too, requestInit.signal is linked into the call's scope: its abort rejects with RequestCancelledError 'aborted'", async () => {
    const { impl, seen } = hangingFetch();
    const controller = new AbortController();
    const out = track(
      fetchThreadHistory({
        baseUrl: BASE,
        threadId: "t1",
        fetchImpl: impl,
        requestInit: { headers: { authorization: "Bearer t" }, signal: controller.signal },
        timeoutMs: 60_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(new Headers(seen[0]!.init?.headers).get("authorization")).toBe("Bearer t");
    expect(seen[0]!.init?.signal).not.toBe(controller.signal);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.error).toBeInstanceOf(RequestCancelledError);
    expect(out.error).toMatchObject({ reason: "aborted", code: CLIENT_ERROR_CODES.REQUEST_ABORTED });
    expect(seen[0]!.init?.signal?.aborted).toBe(true);
  });
});
