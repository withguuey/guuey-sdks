// @vitest-environment jsdom
/**
 * guuey#524 (pass-3 correction 4) — the `surfaceContext` invoke-body field
 * is RETIRED: first-party provenance is stamped CONFIG-SIDE by the pod,
 * never body-carried, because a body field is client-CLAIMED — any embed
 * could assert a trusted surface. These are the forward pins (the
 * retired-wire guard, same posture as the cli wire-mirror sync tests):
 * the body must never grow the field back, whatever a caller passes.
 * History: the field shipped as guuey#398 and lived one launch runway.
 */
import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, InvokeRequest, UseAgentInvokeOptions } from "./types.js";

const APP_ID = "app-ctx";

function capturingAdapters() {
  const bodies: unknown[] = [];
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => "cmid-ctx",
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      bodies.push(req.body);
      yield 'event: done\ndata: {"stopReason":"end_turn"}\n\n';
    },
  };
  return { adapters, bodies };
}

describe("useAgentInvoke — surfaceContext is retired from the wire (guuey#524)", () => {
  it("the invoke body never carries surfaceContext", async () => {
    const { adapters, bodies } = capturingAdapters();
    const { result } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example/agent/invoke", appId: APP_ID, adapters }),
    );
    await act(async () => {
      await result.current.send("hello");
    });
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0] as Record<string, never>)).not.toContain("surfaceContext");
  });

  it("the options type refuses the retired field — no caller can quietly resurrect it", () => {
    // Compile-time pin: `surfaceContext` is not assignable to the options.
    // A resurrection would make this a silent excess-property PASS in some
    // spread positions, so pin the type relation itself.
    type Retired = "surfaceContext" extends keyof UseAgentInvokeOptions ? true : false;
    const retired: Retired = false;
    expect(retired).toBe(false);
  });
});
