// @vitest-environment jsdom
/**
 * A stream that is RESET mid-reply (guuey#3436). After the turn was admitted,
 * the body THROWS (`reader.read()` rejects) instead of closing. That is the
 * same cut as a clean close without `done`, so it gets the same #192 verdict:
 * the finished reply is adopted when history holds it, and otherwise the turn
 * fails with `STREAM_TRUNCATED`. A failure the pod already voiced in-band keeps
 * its own words and code: the browser's exception text never overwrites them.
 * A user abort stays a user abort.
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
} from "./types.js";

const WINDOW = STALL_RECOVERY_DEFAULTS.windowMs;
const SESSION_FRAME = 'event: session\ndata: {"threadId":"t-reset"}\n\n';
const ERROR_FRAME =
  'event: error\ndata: {"code":"PLATFORM_ERROR","message":"Something went wrong on our side. Please try again."}\n\n';
const textDelta = (delta: string): string => `event: message\ndata: {"type":"text.delta","delta":"${delta}"}\n\n`;
/** What a browser's fetch body throws on a reset connection. */
const RESET_TEXT = "network error";

/** Yield `frames`, then THROW as a reset connection does (never a clean close). */
function resettingTransport(frames: string[]): AgentInvokeAdapters["transport"] {
  return async function* (_req: InvokeRequest): AsyncGenerator<string> {
    for (const f of frames) yield f;
    throw new TypeError(RESET_TEXT);
  };
}

function adapters(transport: AgentInvokeAdapters["transport"], history?: AgentInvokeHistoryAdapter): AgentInvokeAdapters {
  return {
    storage: { load: () => null, save: () => {} },
    generateId: () => "cmid-reset",
    transport,
    ...(history ? { history } : {}),
  };
}

function renderInvoke(a: AgentInvokeAdapters) {
  return renderHook(() => useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-reset", adapters: a }));
}

const COMPLETED: AgentMessage[] = [
  { role: "user", text: "hi" },
  { role: "assistant", text: "the full persisted answer" },
];
const ADOPTED: AgentMessage[] = [
  { role: "user", text: "hi", precedingTurnCount: 0 },
  { role: "assistant", text: "the full persisted answer" },
];
const NOT_YET: AgentMessage[] = [{ role: "user", text: "hi" }];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useAgentInvoke — a stream RESET after admission (guuey#3436)", () => {
  it("adopts the finished reply when history holds it, never surfacing the reset text (mutant: the catch sets e.message)", async () => {
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({ messages: COMPLETED }));
    const { result, unmount } = renderInvoke(adapters(resettingTransport([SESSION_FRAME, textDelta("partial ")]), { load }));
    await act(async () => {
      await result.current.send("hi");
    });
    expect(load).toHaveBeenCalledWith("t-reset");
    expect(result.current.messages).toEqual(ADOPTED);
    expect(result.current.adopted).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
    expect(result.current.aborted).toBe(false);
    expect(result.current.status).toBe("ready");
    unmount();
  });

  it("without the finished reply, fails with STREAM_TRUNCATED and the SDK's sentence, not the reset text (mutant: skip the probe on a throw)", async () => {
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({ messages: NOT_YET }));
    const { result, unmount } = renderInvoke(adapters(resettingTransport([SESSION_FRAME, textDelta("partial ")]), { load }));
    await act(async () => {
      const sending = result.current.send("hi");
      await vi.advanceTimersByTimeAsync(WINDOW);
      await sending;
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.STREAM_TRUNCATED);
    expect(result.current.error).toMatch(/ended before the reply finished/);
    expect(result.current.error).not.toBe(RESET_TEXT);
    expect(result.current.adopted).toBe(false);
    expect(result.current.aborted).toBe(false);
    // The partial text the user saw is kept.
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "partial " });
    unmount();
  });

  it("an `error` frame, then a reset: the pod's words and code stand, with no probe (mutant: the catch overwrites them)", async () => {
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({ messages: NOT_YET }));
    const { result, unmount } = renderInvoke(adapters(resettingTransport([SESSION_FRAME, textDelta("partial "), ERROR_FRAME]), { load }));
    await act(async () => {
      await result.current.send("hi");
    });
    expect(load).not.toHaveBeenCalled();
    expect(result.current.errorCode).toBe("PLATFORM_ERROR");
    expect(result.current.error).toBe("Something went wrong on our side. Please try again.");
    expect(result.current.aborted).toBe(false);
    unmount();
  });

  it("a user abort during the probe stays a user abort: no error, `aborted` set (mutant: the verdict lands after an abort)", async () => {
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({ messages: NOT_YET }));
    const { result, unmount } = renderInvoke(adapters(resettingTransport([SESSION_FRAME, textDelta("partial ")]), { load }));
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

  it("negative control: a throw BEFORE admission keeps today's failed-send handling (mutant: probe a pre-admission throw)", async () => {
    const load = vi.fn<(tid: string) => Promise<HistoryLoadResult>>(async () => ({ messages: COMPLETED }));
    const { result, unmount } = renderInvoke(adapters(resettingTransport([]), { load }));
    await act(async () => {
      await result.current.send("hi");
    });
    expect(load).not.toHaveBeenCalled();
    expect(result.current.error).toBe(RESET_TEXT);
    expect(result.current.errorCode).toBeNull();
    unmount();
  });
});
