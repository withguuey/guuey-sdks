// @vitest-environment jsdom
/**
 * guuey#192: the stall watchdog. A half-dead SSE connection (TCP alive, zero
 * bytes, no error, no `done`) used to leave the turn suspended forever —
 * frozen streaming cursor, stuck Stop button — while the backend had
 * completed and persisted the reply. The watchdog probes history without
 * touching the live stream, adopts the finished reply when it is already
 * persisted, and only after bounded fruitless probes fails the turn with the
 * client-originated `STREAM_STALLED` code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentInvoke, STALL_RECOVERY_DEFAULTS } from "./useAgentInvoke.js";
import { CLIENT_ERROR_CODES } from "./error-codes.js";
import type {
  AgentInvokeAdapters,
  AgentInvokeHistoryAdapter,
  AgentMessage,
  HistoryLoadResult,
  InvokeRequest,
  UseAgentInvokeOptions,
} from "./types.js";

const APP_ID = "app-stall";
const WINDOW = STALL_RECOVERY_DEFAULTS.windowMs;

const SESSION_FRAME = 'event: session\ndata: {"threadId":"t-192"}\n\n';
const DONE_FRAME = 'event: done\ndata: {"stopReason":"end"}\n\n';
function textDelta(delta: string): string {
  return `event: message\ndata: {"type":"text.delta","delta":"${delta}"}\n\n`;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Resolves when the request aborts (the fetch-reader unwind, in miniature). */
function abortOf(req: InvokeRequest): Promise<void> {
  return new Promise<void>((resolve) => {
    if (req.signal.aborted) resolve();
    else req.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Yield `frames`, then go byte-silent until the request aborts — the #192 shape. */
function halfDeadTransport(
  sentRequests: InvokeRequest[],
  frames: string[],
): AgentInvokeAdapters["transport"] {
  return async function* (req: InvokeRequest): AsyncGenerator<string> {
    sentRequests.push(req);
    for (const f of frames) yield f;
    await abortOf(req);
    req.signal.throwIfAborted();
  };
}

function makeAdapters(
  transport: AgentInvokeAdapters["transport"],
  history?: AgentInvokeHistoryAdapter,
): AgentInvokeAdapters {
  return {
    storage: { load: () => null, save: () => {} },
    generateId: () => "cmid-stall",
    transport,
    ...(history ? { history } : {}),
  };
}

function renderInvoke(adapters: AgentInvokeAdapters, extra?: Partial<UseAgentInvokeOptions>) {
  return renderHook(() =>
    useAgentInvoke({
      endpointUrl: "https://pod.example.com",
      appId: APP_ID,
      adapters,
      ...extra,
    }),
  );
}

const COMPLETED: AgentMessage[] = [
  { role: "user", text: "hi" },
  { role: "assistant", text: "the full persisted answer" },
];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useAgentInvoke stall recovery (guuey#192)", () => {
  it("adopts the finished reply from history when the stream goes silent mid-turn", async () => {
    const sent: InvokeRequest[] = [];
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({
      messages: COMPLETED,
      cards: [{ seq: 3, at: "2026-08-15T00:00:00Z", cardSnapshot: { kind: "card" } }],
    }));
    const { result, unmount } = renderInvoke(
      makeAdapters(halfDeadTransport(sent, [SESSION_FRAME, textDelta("partial ")]), { load }),
    );

    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hi");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("responding");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW);
      await sendDone;
    });

    // Seamless: the transcript IS the persisted one, no error surfaced, the
    // dead stream was aborted, and the probe queried the session's thread.
    expect(result.current.messages).toEqual(COMPLETED);
    expect(result.current.historyCards).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
    expect(result.current.status).toBe("ready");
    expect(sent[0].signal.aborted).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("t-192");
    unmount();
  });

  it("keeps a live-but-quiet stream: an in-flight probe verdict re-arms, late bytes finish the turn", async () => {
    const sent: InvokeRequest[] = [];
    const resume = deferred<void>();
    const transport = async function* (req: InvokeRequest): AsyncGenerator<string> {
      sent.push(req);
      yield SESSION_FRAME;
      yield textDelta("part one");
      await Promise.race([resume.promise, abortOf(req)]);
      req.signal.throwIfAborted();
      yield textDelta(" part two");
      yield DONE_FRAME;
    };
    // History still shows the turn in flight: our user row, no assistant tail.
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({
      messages: [{ role: "user", text: "hi" }],
    }));
    const { result, unmount } = renderInvoke(makeAdapters(transport, { load }));

    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hi");
      await vi.advanceTimersByTimeAsync(0);
    });

    // First silent window: probe fires, verdict is in-flight, stream survives.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW);
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(sent[0].signal.aborted).toBe(false);

    // Bytes resume: the turn completes exactly as if nothing had watched it.
    await act(async () => {
      resume.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await sendDone;
    });
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("ready");
    const last = result.current.messages[result.current.messages.length - 1];
    expect(last).toEqual({ role: "assistant", text: "part one part two" });
    expect(sent[0].signal.aborted).toBe(false);
    unmount();
  });

  it("fails with STREAM_STALLED after bounded fruitless windows when no probe is possible", async () => {
    const sent: InvokeRequest[] = [];
    // No history adapter, and no session frame either — nothing to probe.
    const { result, unmount } = renderInvoke(
      makeAdapters(halfDeadTransport(sent, [textDelta("partial ")])),
    );

    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hi");
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      for (let i = 0; i < STALL_RECOVERY_DEFAULTS.probeAttempts; i++) {
        await vi.advanceTimersByTimeAsync(WINDOW);
      }
      await sendDone;
    });

    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.STREAM_STALLED);
    expect(result.current.error).not.toBeNull();
    expect(result.current.status).toBe("ready");
    expect(sent[0].signal.aborted).toBe(true);
    // The streamed partial is kept — an honest failure, not a wiped turn.
    const last = result.current.messages[result.current.messages.length - 1];
    expect(last).toEqual({ role: "assistant", text: "partial " });
    unmount();
  });

  it("never fires during pre-first-byte silence — a cold start is not a stall", async () => {
    const sent: InvokeRequest[] = [];
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({
      messages: COMPLETED,
    }));
    // Parks immediately: zero bytes ever.
    const { result, unmount } = renderInvoke(
      makeAdapters(halfDeadTransport(sent, []), { load }),
    );

    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hi");
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW * 6);
    });
    expect(result.current.status).toBe("connecting");
    expect(result.current.error).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(sent[0].signal.aborted).toBe(false);

    await act(async () => {
      result.current.abort();
      await sendDone;
    });
    unmount();
  });

  it("stallRecovery: false restores the old behaviour — silence is left alone", async () => {
    const sent: InvokeRequest[] = [];
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({
      messages: COMPLETED,
    }));
    const { result, unmount } = renderInvoke(
      makeAdapters(halfDeadTransport(sent, [SESSION_FRAME, textDelta("partial ")]), { load }),
      { stallRecovery: false },
    );

    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hi");
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW * 8);
    });
    expect(result.current.status).toBe("responding");
    expect(result.current.error).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(sent[0].signal.aborted).toBe(false);

    await act(async () => {
      result.current.abort();
      await sendDone;
    });
    unmount();
  });

  it("a user abort during an in-flight probe wins: the late verdict is discarded", async () => {
    const sent: InvokeRequest[] = [];
    const pendingLoad = deferred<HistoryLoadResult>();
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(() => pendingLoad.promise);
    const { result, unmount } = renderInvoke(
      makeAdapters(halfDeadTransport(sent, [SESSION_FRAME, textDelta("partial ")]), { load }),
    );

    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hi");
      await vi.advanceTimersByTimeAsync(0);
    });

    // The probe fires and is now awaiting the (still-pending) history read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW);
    });
    expect(load).toHaveBeenCalledTimes(1);

    // The user stops the turn while the probe is in flight, THEN the read
    // resolves complete — the verdict must be discarded, not adopted.
    await act(async () => {
      result.current.abort();
      await sendDone;
      pendingLoad.resolve({ messages: COMPLETED });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
    // The abort contract holds: partial text kept, nothing replaced.
    const last = result.current.messages[result.current.messages.length - 1];
    expect(last).toEqual({ role: "assistant", text: "partial " });
    unmount();
  });
});
