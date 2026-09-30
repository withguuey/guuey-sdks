// @vitest-environment jsdom
/**
 * guuey#2031 — a card tap's turn carries the tap's own words beside the
 * directive: `send(input, { clientMessageId, tapLabels })` puts BOTH on the
 * optimistic user row and on the invoke body, under one id, and the writer
 * contract runs at the one send path (a list that breaks it rides neither).
 * `newClientMessageId()` mints an id with the host's own generator, so a host
 * can name a pending row before it sends.
 */
import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
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
    expect(result.current.newClientMessageId()).toBe("cmid-1");
    expect(result.current.newClientMessageId()).toBe("cmid-2");
    unmount();
  });
});
