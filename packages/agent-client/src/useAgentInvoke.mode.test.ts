// @vitest-environment jsdom
/**
 * guuey#566/#527 — the client-named agent `mode` rides the invoke BODY per
 * turn; the client's only job is carriage (validation, the fail-soft
 * fallback chain, and the tool subset are ALL pod-side, pinned there).
 * These pins cover the wire shape and the live-ref freshness — a surface's
 * mode can change mid-session (a guest signs in; the host flips rep →
 * agent) and the NEXT turn carries it.
 */
import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

const APP_ID = "app-mode";

function capturingAdapters() {
  const bodies: unknown[] = [];
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => "cmid-mode",
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      bodies.push(req.body);
      yield 'event: done\ndata: {"stopReason":"end_turn"}\n\n';
    },
  };
  return { adapters, bodies };
}

describe("useAgentInvoke — mode carriage (guuey#566)", () => {
  it("sends the mode on the body verbatim", async () => {
    const { adapters, bodies } = capturingAdapters();
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({
        endpointUrl: "https://pod.example.com",
        appId: APP_ID,
        adapters,
        mode: "rep",
      }),
    );
    await act(async () => {
      await result.current.send("hello");
    });
    expect(bodies[0]).toMatchObject({ input: "hello", mode: "rep" });
    unmount();
  });

  it("omits the field when absent, and reads the LIVE value at send time (sign-in flips the mode)", async () => {
    const { adapters, bodies } = capturingAdapters();
    const { result, rerender, unmount } = renderHook(
      ({ mode }: { mode: string | undefined }) =>
        useAgentInvoke({
          endpointUrl: "https://pod.example.com",
          appId: APP_ID,
          adapters,
          ...(mode !== undefined ? { mode } : {}),
        }),
      { initialProps: { mode: undefined as string | undefined } },
    );
    await act(async () => {
      await result.current.send("hi");
    });
    expect(Object.keys(bodies[0] as Record<string, never>)).not.toContain("mode");
    rerender({ mode: "agent" });
    await act(async () => {
      await result.current.send("now signed in");
    });
    expect(bodies[1]).toMatchObject({ mode: "agent" });
    unmount();
  });
});
