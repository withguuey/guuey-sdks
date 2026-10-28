// @vitest-environment jsdom
/**
 * guuey#2858: the stall watchdog adopts the finished reply from a history read
 * that stopped at its page cap. Such a read holds fewer user turns than the
 * local transcript (its oldest rows are left out), so the count rule alone
 * never adopted it: the turn failed STREAM_STALLED although its reply was
 * stored. The read plane serves each user row's key, and the probe finds the
 * turn by it. A keyless truncated read cannot be matched and is not adopted.
 *
 * RED control: drop the `clientMessageId` from the probe and the first case
 * ends STREAM_STALLED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { STALL_RECOVERY_DEFAULTS, useAgentInvoke } from "./useAgentInvoke.js";
import { CLIENT_ERROR_CODES } from "./error-codes.js";
import type { AgentInvokeAdapters, AgentMessage, HistoryLoadResult, InvokeRequest } from "./types.js";

const WINDOW = STALL_RECOVERY_DEFAULTS.windowMs;
const SESSION_FRAME = 'event: session\ndata: {"threadId":"t-2858"}\n\n';
const PARTIAL = 'event: message\ndata: {"type":"text.delta","delta":"partial "}\n\n';

/** Yield the session and one delta, then go byte-silent until the request aborts. */
async function* halfDead(req: InvokeRequest): AsyncGenerator<string> {
  yield SESSION_FRAME;
  yield PARTIAL;
  await new Promise<void>((resolve) => {
    if (req.signal.aborted) resolve();
    else req.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  req.signal.throwIfAborted();
}

/** The seeded transcript: three earlier turns, so the local transcript holds four user turns after the send. */
const SEEDED: AgentMessage[] = [1, 2, 3].flatMap((n): AgentMessage[] => [
  { role: "user", text: `q${n}`, seq: n * 2 - 1, clientMessageId: `cm-${n}` },
  { role: "assistant", text: `a${n}`, seq: n * 2 },
]);

function render(load: (tid: string) => Promise<HistoryLoadResult>) {
  let seeded = false;
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => "t-2858", save: () => {} },
    generateId: () => "cm-4",
    transport: halfDead,
    history: {
      load: async (tid) => {
        if (!seeded) {
          seeded = true;
          return { messages: SEEDED };
        }
        return load(tid);
      },
    },
  };
  return renderHook(() => useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-2858", adapters }));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useAgentInvoke stall recovery over a truncated history (guuey#2858)", () => {
  it("a keyed truncated read holding this turn's finished reply is adopted, and the transcript says it is truncated", async () => {
    const load = vi.fn(async (): Promise<HistoryLoadResult> => ({
      messages: [
        { role: "user", text: "q3", seq: 5, clientMessageId: "cm-3" },
        { role: "assistant", text: "a3", seq: 6 },
        { role: "user", text: "q4", seq: 7, clientMessageId: "cm-4" },
        { role: "assistant", text: "the full answer", seq: 8 },
      ],
      truncated: true,
      order: "desc",
    }));
    const { result, unmount } = render(load);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.messages).toHaveLength(6);
    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("q4");
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW);
      await sendDone;
    });
    expect(result.current.errorCode).toBeNull();
    expect(result.current.adopted).toBe(true);
    expect(result.current.messages[result.current.messages.length - 1]).toEqual({ role: "assistant", text: "the full answer", seq: 8 });
    expect(result.current.historyTruncated).toBe(true);
    unmount();
  });

  it("a failed send the read plane never stored keeps its row: a truncated keyed read without it inside its window is not adopted", async () => {
    // cm-A's transport throws before admission (a failed row with Retry); cm-B then stalls.
    const ids = ["cm-A", "cm-B"];
    let sends = 0;
    let seeded = false;
    const load = vi.fn(async (): Promise<HistoryLoadResult> => ({
      messages: [
        { role: "user", text: "q3", seq: 5, clientMessageId: "cm-3" },
        { role: "assistant", text: "a3", seq: 6 },
        { role: "user", text: "qB", seq: 7, clientMessageId: "cm-B" },
        { role: "assistant", text: "B's answer", seq: 8 },
      ],
      truncated: true,
      order: "desc",
    }));
    const adapters: AgentInvokeAdapters = {
      storage: { load: () => "t-2858", save: () => {} },
      generateId: () => ids.shift() ?? "cm-x",
      transport: (req) => {
        sends += 1;
        if (sends === 1) throw new Error("network down");
        return halfDead(req);
      },
      history: {
        load: async () => {
          if (!seeded) {
            seeded = true;
            return { messages: SEEDED };
          }
          return load();
        },
      },
    };
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-2858", adapters }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await result.current.send("qA");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.sendStates["cm-A"]).toBe("failed");
    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("qB");
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW * STALL_RECOVERY_DEFAULTS.probeAttempts);
      await sendDone;
    });
    expect(load).toHaveBeenCalled();
    expect(result.current.adopted).toBe(false);
    expect(result.current.messages.some((m) => m.role === "user" && m.clientMessageId === "cm-A")).toBe(true);
    unmount();
  });

  it("a keyless truncated ascending read is never adopted: the turn ends STREAM_STALLED after its probes", async () => {
    const load = vi.fn(async (): Promise<HistoryLoadResult> => ({
      messages: [
        { role: "user", text: "q1", seq: 1 },
        { role: "assistant", text: "a1", seq: 2 },
        { role: "user", text: "q2", seq: 3 },
        { role: "assistant", text: "a2", seq: 4 },
        { role: "user", text: "q3", seq: 5 },
        { role: "assistant", text: "a3", seq: 6 },
        { role: "user", text: "q4", seq: 7 },
        { role: "assistant", text: "an answer", seq: 8 },
      ],
      truncated: true,
      order: "asc",
    }));
    const { result, unmount } = render(load);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("q4");
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW * STALL_RECOVERY_DEFAULTS.probeAttempts);
      await sendDone;
    });
    expect(result.current.adopted).toBe(false);
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.STREAM_STALLED);
    unmount();
  });
});
