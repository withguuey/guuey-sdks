// @vitest-environment jsdom
/**
 * The transcript-renderer signals (guuey#135 wave 3b): `aborted`, `adopted`
 * (its adoption arm is asserted in `useAgentInvoke.stall.test.ts`, where the
 * #192 machinery lives), and the R0 optimistic-send ledger — `sendStates`
 * keyed by the `clientMessageId` now carried on live-sent user messages.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

const APP_ID = "app-signals";

const frame = (event: string, data: object) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A transport the test feeds one frame at a time (`null` closes the stream). */
function gatedAdapters(ids: string[] = ["cmid-1", "cmid-2"]) {
  let release!: (f: string | null) => void;
  const queue: Promise<string | null>[] = [];
  const arm = () => {
    queue.push(
      new Promise<string | null>((r) => {
        release = r;
      }),
    );
  };
  arm();
  const feed = async (f: string | null) => {
    const r = release;
    arm();
    await act(async () => {
      r(f);
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  let idIndex = 0;
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => ids[idIndex++] ?? `cmid-${idIndex}`,
    // Respects the abort signal the way a real fetch transport does — an
    // aborted turn's pending read unwinds instead of suspending forever.
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      const aborted = new Promise<null>((resolve) => {
        req.signal.addEventListener("abort", () => resolve(null), { once: true });
      });
      for (let i = 0; ; i++) {
        const f = await Promise.race([queue[i], aborted]);
        if (f === null || req.signal.aborted) {
          req.signal.throwIfAborted();
          return;
        }
        yield f;
      }
    },
  };
  return { adapters, feed };
}

describe("useAgentInvoke transcript signals", () => {
  it("ledgers the send: 'sending' until the session frame admits the turn, then absent (= sent)", async () => {
    const { adapters, feed } = gatedAdapters();
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );
    let sendDone: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hello");
      await Promise.resolve();
    });
    // Optimistic: the user entry carries the id, the ledger says sending.
    expect(result.current.messages[0]).toEqual({
      role: "user",
      text: "hello",
      clientMessageId: "cmid-1",
    });
    expect(result.current.sendStates).toEqual({ "cmid-1": "sending" });

    await feed(frame("session", { threadId: "t1" }));
    // Admitted: the entry is REMOVED — absent means sent.
    expect(result.current.sendStates).toEqual({});

    await feed(null);
    await act(async () => {
      await sendDone!;
    });
    unmount();
  });

  it("marks the send 'failed' when the turn errors BEFORE admission — the message never disappears", async () => {
    const adapters: AgentInvokeAdapters = {
      storage: { load: () => null, save: () => {} },
      generateId: () => "cmid-fail",
      // Rejects before any frame — the pod was never reached.
      // eslint-disable-next-line require-yield
      transport: async function* (): AsyncGenerator<string> {
        throw new TypeError("Failed to fetch");
      },
    };
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );
    await act(async () => {
      await result.current.send("are you there?");
    });
    expect(result.current.sendStates).toEqual({ "cmid-fail": "failed" });
    // The optimistic user message is still in the transcript (R0's invariant).
    expect(result.current.messages[0]).toEqual({
      role: "user",
      text: "are you there?",
      clientMessageId: "cmid-fail",
    });
    expect(result.current.error).not.toBeNull();
    expect(result.current.aborted).toBe(false);
    unmount();
  });

  it("sets `aborted` on a user abort (partial kept), and the next send clears it", async () => {
    const { adapters, feed } = gatedAdapters();
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );
    let sendDone: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("long story please");
      await Promise.resolve();
    });
    await feed(frame("session", { threadId: "t1" }));
    await feed(frame("message", { type: "text.delta", id: "b1", delta: "Once upon", seq: 1 }));
    await act(async () => {
      result.current.abort();
      await sendDone!;
    });
    expect(result.current.aborted).toBe(true);
    // The partial is kept as the last assistant message.
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Once upon" });

    // A fresh send clears the flag before anything streams.
    await act(async () => {
      void result.current.send("again");
      await Promise.resolve();
    });
    expect(result.current.aborted).toBe(false);
    unmount();
  });

  it("a pre-admission abort clears the 'sending' entry — a cancelled turn is not a failed send", async () => {
    const { adapters } = gatedAdapters(["cmid-cancel"]);
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );
    let sendDone: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("never mind");
      await Promise.resolve();
    });
    expect(result.current.sendStates).toEqual({ "cmid-cancel": "sending" });
    await act(async () => {
      result.current.abort();
      await sendDone!;
    });
    expect(result.current.sendStates).toEqual({});
    expect(result.current.aborted).toBe(true);
    unmount();
  });

  it("reset() clears aborted, adopted, and the send ledger", async () => {
    const adapters: AgentInvokeAdapters = {
      storage: { load: () => null, save: () => {} },
      generateId: () => "cmid-reset",
      // eslint-disable-next-line require-yield
      transport: async function* (): AsyncGenerator<string> {
        throw new TypeError("Failed to fetch");
      },
    };
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );
    await act(async () => {
      await result.current.send("doomed");
    });
    expect(result.current.sendStates).toEqual({ "cmid-reset": "failed" });
    act(() => {
      result.current.reset();
    });
    expect(result.current.sendStates).toEqual({});
    expect(result.current.aborted).toBe(false);
    expect(result.current.adopted).toBe(false);
    unmount();
  });
});
