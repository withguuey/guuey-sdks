// @vitest-environment jsdom
/**
 * The per-turn status lifecycle (guuey#91): `useAgentInvoke` derives
 * `status` + `activeTool` purely from the SSE frames it already consumes.
 * The transport below is GATED — each frame is released by the test — so
 * every intermediate state is observable, which is exactly what a burst-mode
 * pod (today's reality) collapses and a streaming pod will stretch out.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

const APP_ID = "app-status";

const frame = (event: string, data: object) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A transport the test feeds one frame at a time. */
function gatedAdapters() {
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
      // Let the hook's loop consume the frame and flush state.
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => "cmid-status",
    transport: async function* (_req: InvokeRequest): AsyncGenerator<string> {
      for (let i = 0; ; i++) {
        const f = await queue[i];
        if (f === null) return;
        yield f;
      }
    },
  };
  return { adapters, feed };
}

describe("useAgentInvoke status lifecycle", () => {
  it("walks connecting → thinking → using-tool → thinking → responding → ready on a silver turn", async () => {
    const { adapters, feed } = gatedAdapters();
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );
    expect(result.current.status).toBe("ready");

    let sendDone: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hi");
      await Promise.resolve();
    });
    expect(result.current.status).toBe("connecting");

    await feed(frame("session", { threadId: "t1" }));
    expect(result.current.status).toBe("thinking");

    await feed(frame("message", { type: "tool.start", toolCallId: "c1", name: "mcp__ggui__ggui_render", seq: 1 }));
    expect(result.current.status).toBe("using-tool");
    expect(result.current.activeTool).toBe("mcp__ggui__ggui_render");

    await feed(frame("message", { type: "tool.done", toolCallId: "c1", seq: 2 }));
    expect(result.current.status).toBe("thinking");
    expect(result.current.activeTool).toBeNull();

    await feed(frame("message", { type: "text.delta", id: "b1", delta: "Hello", seq: 3 }));
    expect(result.current.status).toBe("responding");

    await feed(frame("done", {}));
    await feed(null);
    await act(async () => {
      await sendDone!;
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.activeTool).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Hello" });
    unmount();
  });

  it("maps bypass assistant frames to responding", async () => {
    const { adapters, feed } = gatedAdapters();
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );
    let sendDone: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hi");
      await Promise.resolve();
    });
    await feed(frame("session", { threadId: "t1" }));
    await feed(
      frame("message", { type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } }),
    );
    expect(result.current.status).toBe("responding");
    await feed(null);
    await act(async () => {
      await sendDone!;
    });
    expect(result.current.status).toBe("ready");
    unmount();
  });

  it("returns to ready after a transport failure (error keeps its own channel)", async () => {
    const adapters: AgentInvokeAdapters = {
      storage: { load: () => null, save: () => {} },
      generateId: () => "cmid-status",
      // eslint-disable-next-line require-yield
      transport: async function* (): AsyncGenerator<string> {
        throw new Error("boom");
      },
    };
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBe("boom");
    unmount();
  });

  it("blocks a second send while a turn is in flight", async () => {
    const { adapters, feed } = gatedAdapters();
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );
    let sendDone: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("first");
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.send("second"); // no-op: status !== 'ready'
    });
    // Only the first turn's user message (+ its placeholder) exists — carrying
    // the turn's clientMessageId (the R0 send-lifecycle join, guuey#135 3b).
    expect(result.current.messages.filter((m) => m.role === "user")).toEqual([
      { role: "user", text: "first", clientMessageId: "cmid-status" },
    ]);
    await feed(null);
    await act(async () => {
      await sendDone!;
    });
    unmount();
  });
});
