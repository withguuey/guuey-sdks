// @vitest-environment jsdom
/**
 * A stream that CLOSES without its `done` frame. The pod ends every invoke it
 * can still reach with `done`, so a clean close without one means the
 * connection was cut. The hook must not return to `ready` as if the turn had
 * finished: history is checked for the finished reply (the stall watchdog's
 * own decision), once at the close and once more after the watchdog's window,
 * since the pod may persist the reply seconds after the cut. The reply is
 * adopted when it is there, and otherwise the turn fails with
 * `STREAM_TRUNCATED`.
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

const WINDOW = STALL_RECOVERY_DEFAULTS.windowMs;
const SESSION_FRAME = 'event: session\ndata: {"threadId":"t-cut"}\n\n';
const DONE_FRAME = 'event: done\ndata: {"stopReason":"end"}\n\n';
const ERROR_FRAME = 'event: error\ndata: {"code":"TIMEOUT","message":"This took too long. Please try again."}\n\n';
const textDelta = (delta: string): string => `event: message\ndata: {"type":"text.delta","delta":"${delta}"}\n\n`;

/** Yield `frames`, then END the stream (a clean close, whatever the frames said). */
function closingTransport(sent: InvokeRequest[], frames: string[]): AgentInvokeAdapters["transport"] {
  return async function* (req: InvokeRequest): AsyncGenerator<string> {
    sent.push(req);
    for (const f of frames) yield f;
  };
}

function adapters(transport: AgentInvokeAdapters["transport"], history?: AgentInvokeHistoryAdapter): AgentInvokeAdapters {
  return {
    storage: { load: () => null, save: () => {} },
    generateId: () => "cmid-cut",
    transport,
    ...(history ? { history } : {}),
  };
}

function renderInvoke(a: AgentInvokeAdapters, extra?: Partial<UseAgentInvokeOptions>) {
  return renderHook(() => useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-cut", adapters: a, ...extra }));
}

const COMPLETED: AgentMessage[] = [
  { role: "user", text: "hi" },
  { role: "assistant", text: "the full persisted answer" },
];
const NOT_YET: AgentMessage[] = [{ role: "user", text: "hi" }];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useAgentInvoke — a stream that closes without `done`", () => {
  it("adopts the finished reply when history already holds it at the close", async () => {
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({ messages: COMPLETED }));
    const { result, unmount } = renderInvoke(adapters(closingTransport([], [SESSION_FRAME, textDelta("partial ")]), { load }));
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.messages).toEqual(COMPLETED);
    expect(result.current.adopted).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
    expect(result.current.aborted).toBe(false);
    expect(result.current.status).toBe("ready");
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("t-cut");
    unmount();
  });

  it("a reply the pod persists seconds AFTER the cut is adopted on the one re-read, never reported as cut", async () => {
    let persisted = false;
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({ messages: persisted ? COMPLETED : NOT_YET }));
    const { result, unmount } = renderInvoke(adapters(closingTransport([], [SESSION_FRAME, textDelta("partial ")]), { load }));
    let sending!: Promise<void>;
    await act(async () => {
      sending = result.current.send("hi");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.status).not.toBe("ready");
    expect(result.current.errorCode).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      persisted = true;
      await vi.advanceTimersByTimeAsync(WINDOW);
      await sending;
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.messages).toEqual(COMPLETED);
    expect(result.current.adopted).toBe(true);
    expect(result.current.errorCode).toBeNull();
    unmount();
  });

  it("no reply in history after the re-read: the turn fails with STREAM_TRUNCATED and a reader-grade line", async () => {
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({ messages: NOT_YET }));
    const { result, unmount } = renderInvoke(adapters(closingTransport([], [SESSION_FRAME, textDelta("partial ")]), { load }));
    await act(async () => {
      const sending = result.current.send("hi");
      await vi.advanceTimersByTimeAsync(WINDOW);
      await sending;
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.STREAM_TRUNCATED);
    expect(result.current.error).toMatch(/ended before the reply finished/);
    expect(result.current.adopted).toBe(false);
    expect(result.current.aborted).toBe(false);
    expect(result.current.status).toBe("ready");
    // The partial text the user saw is kept.
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "partial " });
    unmount();
  });

  it("a close before any text leaves no empty bubble beside the error", async () => {
    const { result, unmount } = renderInvoke(adapters(closingTransport([], [SESSION_FRAME])));
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.STREAM_TRUNCATED);
    expect(result.current.messages).toEqual([{ role: "user", text: "hi", clientMessageId: "cmid-cut", precedingTurnCount: 0 }]);
    unmount();
  });

  it("no history adapter: no probe and no wait, the turn fails at the close", async () => {
    const { result, unmount } = renderInvoke(adapters(closingTransport([], [SESSION_FRAME, textDelta("partial ")])));
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.STREAM_TRUNCATED);
    unmount();
  });

  it("negative control: a stream WITH `done` ends quietly, with no probe", async () => {
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({ messages: NOT_YET }));
    const { result, unmount } = renderInvoke(adapters(closingTransport([], [SESSION_FRAME, textDelta("all of it"), DONE_FRAME]), { load }));
    await act(async () => {
      await result.current.send("hi");
    });
    expect(load).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "all of it" });
    unmount();
  });

  it("a failure the pod voiced in-band keeps its own words and code, with no probe", async () => {
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({ messages: NOT_YET }));
    const { result, unmount } = renderInvoke(adapters(closingTransport([], [SESSION_FRAME, ERROR_FRAME]), { load }));
    await act(async () => {
      await result.current.send("hi");
    });
    expect(load).not.toHaveBeenCalled();
    expect(result.current.errorCode).toBe("TIMEOUT");
    expect(result.current.error).toBe("This took too long. Please try again.");
    unmount();
  });

  it("a user abort during the re-read wait stays a user abort: no error, `aborted` set", async () => {
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({ messages: NOT_YET }));
    const { result, unmount } = renderInvoke(adapters(closingTransport([], [SESSION_FRAME, textDelta("partial ")]), { load }));
    let sending!: Promise<void>;
    await act(async () => {
      sending = result.current.send("hi");
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      result.current.abort();
      await sending;
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.aborted).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
    unmount();
  });
});
