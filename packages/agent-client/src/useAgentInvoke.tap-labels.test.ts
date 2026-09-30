// @vitest-environment jsdom
/**
 * guuey#2031 — a card tap's turn carries the tap's own words beside the
 * directive: `send(input, { clientMessageId, tapLabels })` puts BOTH on the
 * optimistic user row and on the invoke body, under one id, and the writer
 * contract runs at the one send path (a list that breaks it rides neither).
 * `newClientMessageId()` mints an id with the host's own generator, so a host
 * can name a pending row before it sends.
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

const DIRECTIVE = '<ggui_directive kind="user-action">\n  <session_id>render_s1</session_id>\n</ggui_directive>';

function capturingAdapters() {
  const bodies: unknown[] = [];
  let n = 0;
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => `cmid-${++n}`,
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      bodies.push(req.body);
      yield 'event: done\ndata: {"stopReason":"end_turn"}\n\n';
    },
  };
  return { adapters, bodies };
}

function hook(adapters: AgentInvokeAdapters) {
  return renderHook(() => useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-tap", adapters }));
}

describe("useAgentInvoke — a tap's labels ride the send (guuey#2031)", () => {
  it("send(input, { clientMessageId, tapLabels }) puts both on the optimistic row and on the body", async () => {
    const { adapters, bodies } = capturingAdapters();
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send(DIRECTIVE, { clientMessageId: "tap-1", tapLabels: ["What are your opening hours?", null] });
    });
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      text: DIRECTIVE,
      clientMessageId: "tap-1",
      tapLabels: ["What are your opening hours?", null],
    });
    expect(bodies[0]).toMatchObject({ input: DIRECTIVE, clientMessageId: "tap-1", tapLabels: ["What are your opening hours?", null] });
    unmount();
  });

  it("the writer contract runs at send: a list that breaks it rides neither the row nor the body; the id still does", async () => {
    const { adapters, bodies } = capturingAdapters();
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send(DIRECTIVE, { clientMessageId: "tap-2", tapLabels: Array.from({ length: 9 }, (_, i) => `Chip ${i}`) });
    });
    expect(result.current.messages[0]).toMatchObject({ clientMessageId: "tap-2" });
    expect(Object.keys(result.current.messages[0] ?? {})).not.toContain("tapLabels");
    expect(bodies[0]).toMatchObject({ clientMessageId: "tap-2" });
    expect(Object.keys(bodies[0] as Record<string, never>)).not.toContain("tapLabels");
    unmount();
  });

  it("a plain send is exactly as before: the id from the host's generator, no tapLabels key anywhere", async () => {
    const { adapters, bodies } = capturingAdapters();
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    expect(result.current.messages[0]).toEqual({ role: "user", text: "hello", clientMessageId: "cmid-1", precedingTurnCount: 0 });
    expect(bodies[0]).toEqual({ input: "hello", clientMessageId: "cmid-1" });
    unmount();
  });

  it("newClientMessageId() mints with the host's own generator", () => {
    const { adapters } = capturingAdapters();
    const { result, unmount } = hook(adapters);
    expect(result.current.newClientMessageId?.()).toBe("cmid-1");
    expect(result.current.newClientMessageId?.()).toBe("cmid-2");
    unmount();
  });
});

describe("useAgentInvoke — a refused send never reads as sent under the id its host minted (guuey#2031)", () => {
  it("a refused send with a host-minted id: sendStates names that id failed, and nothing else is written", async () => {
    const { adapters, bodies } = capturingAdapters();
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("   ", { clientMessageId: "tap-refused" });
    });
    expect(result.current.sendStates).toEqual({ "tap-refused": "failed" });
    expect(result.current.messages).toEqual([]);
    expect(bodies).toEqual([]);
    unmount();
  });

  it("a send refused because a turn is in flight: the host-minted id reads failed", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const adapters: AgentInvokeAdapters = {
      storage: { load: () => null, save: () => {} },
      generateId: () => "cmid-first",
      transport: async function* (): AsyncGenerator<string> {
        await held;
        yield 'event: session\ndata: {"threadId":"t-1"}\n\n';
        yield 'event: done\ndata: {"stopReason":"end_turn"}\n\n';
      },
    };
    const { result, unmount } = hook(adapters);
    let first: Promise<void> | undefined;
    act(() => {
      first = result.current.send("first");
    });
    await waitFor(() => expect(result.current.status).not.toBe("ready"));
    await act(async () => {
      await result.current.send(DIRECTIVE, { clientMessageId: "tap-busy" });
    });
    expect(result.current.sendStates["tap-busy"]).toBe("failed");
    await act(async () => {
      release();
      await first;
    });
    unmount();
  });

  it("a refused plain send writes nothing: there is no id a host holds", async () => {
    const { adapters } = capturingAdapters();
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("   ");
    });
    expect(result.current.sendStates).toEqual({});
    unmount();
  });
});

describe("useAgentInvoke — an abort while the send waits for the stored thread id unwinds it", () => {
  it("no sending entry, no empty reply bubble, the abort surfaced, and the external abort listener removed", async () => {
    let loaded: (id: string | null) => void = () => {};
    const external = new AbortController();
    const removed = vi.spyOn(external.signal, "removeEventListener");
    const bodies: unknown[] = [];
    const adapters: AgentInvokeAdapters = {
      storage: { load: () => new Promise<string | null>((resolve) => (loaded = resolve)), save: () => {} },
      generateId: () => "cmid-h",
      transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
        bodies.push(req.body);
        yield 'event: done\ndata: {"stopReason":"end_turn"}\n\n';
      },
    };
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-hydrate", adapters, signal: external.signal }),
    );
    let sending: Promise<void> | undefined;
    act(() => {
      sending = result.current.send("hello", { clientMessageId: "tap-h" });
    });
    // Parked on the stored thread id: the optimistic row and the sending entry are up.
    expect(result.current.sendStates).toEqual({ "tap-h": "sending" });
    act(() => {
      result.current.abort();
    });
    await act(async () => {
      loaded(null);
      await sending;
    });
    expect(result.current.sendStates).toEqual({});
    expect(result.current.messages).toEqual([{ role: "user", text: "hello", clientMessageId: "tap-h", precedingTurnCount: 0 }]);
    expect(result.current.aborted).toBe(true);
    expect(result.current.status).toBe("ready");
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(bodies).toEqual([]);
    unmount();
  });
});
