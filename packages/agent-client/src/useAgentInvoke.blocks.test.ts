// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke";
import type { AgentInvokeAdapters, InvokeRequest, UseAgentInvokeOptions } from "./types";

const APP_ID = "app-blocks";

/** SSE frame carrying a single AgEvent object (the pod's silver-mode shape). */
const silverFrame = (delta: string, seq: number) =>
  `event: message\ndata: ${JSON.stringify({ type: "text.delta", id: "b1", delta, seq })}\n\n`;
/** SSE frame carrying a bypass-mode SDKMessage (NOT an AgEvent). */
const bypassFrame = (text: string) =>
  `event: message\ndata: ${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n\n`;

function makeAdapters(frames: string[]): AgentInvokeAdapters {
  const store: Record<string, string> = {};
  return {
    storage: {
      load: (k) => (k in store ? store[k] : null),
      save: (k, v) => {
        store[k] = v;
      },
    },
    generateId: () => "cmid-test",
    transport: async function* (_req: InvokeRequest): AsyncGenerator<string> {
      yield "event: session\ndata: {\"threadId\":\"t1\"}\n\n";
      for (const f of frames) yield f;
      yield "event: done\ndata: {}\n\n";
    },
  };
}

function mount(frames: string[], extra?: Partial<UseAgentInvokeOptions>) {
  const adapters = makeAdapters(frames);
  return renderHook(() =>
    useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters, ...extra }),
  );
}

describe("useAgentInvoke preserveBlocks", () => {
  it("keeps reduceResult null when preserveBlocks is off (default)", async () => {
    const { result, unmount } = mount([silverFrame("Hello ", 1), silverFrame("World", 2)]);
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.reduceResult).toBeNull();
    // Text surface still renders from the silver text.delta frames.
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Hello World" });
    unmount();
  });

  it("folds silver frames into a non-null reduceResult while keeping the text surface byte-identical", async () => {
    const frames = [silverFrame("Hello ", 1), silverFrame("World", 2)];
    const off = mount(frames);
    await act(async () => {
      await off.result.current.send("hi");
    });
    const textOff = off.result.current.messages;
    off.unmount();

    const on = mount(frames, { preserveBlocks: true });
    await act(async () => {
      await on.result.current.send("hi");
    });
    // Byte-identical text surface with preserveBlocks on.
    expect(on.result.current.messages).toEqual(textOff);
    // Reducer produced a real fold once a valid AgEvent arrived.
    expect(on.result.current.reduceResult).not.toBeNull();
    on.unmount();
  });

  it("stays null in bypass mode even with preserveBlocks on (reducer is silver-only)", async () => {
    const { result, unmount } = mount([bypassFrame("Hi "), bypassFrame("there")], {
      preserveBlocks: true,
    });
    await act(async () => {
      await result.current.send("hi");
    });
    // Bypass SDKMessage frames never validate as AgEvents → no fold.
    expect(result.current.reduceResult).toBeNull();
    // But the text surface still renders (bypass text extraction unaffected).
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Hi there" });
    unmount();
  });

  it("reset() re-creates the reducer → reduceResult returns to null", async () => {
    const { result, unmount } = mount([silverFrame("Hello", 1)], { preserveBlocks: true });
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.reduceResult).not.toBeNull();
    await act(async () => {
      result.current.reset();
    });
    expect(result.current.reduceResult).toBeNull();
    unmount();
  });
});
