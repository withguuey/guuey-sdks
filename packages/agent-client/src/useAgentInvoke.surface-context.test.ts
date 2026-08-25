// @vitest-environment jsdom
/**
 * guuey#398 — `surfaceContext` rides the invoke BODY (the pod composes it
 * into the model's input); the optimistic user message stays clean. The
 * surface that embeds the chat is the one place that knows where the user
 * is, so the option is per-hook, sent on every turn.
 */
import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

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

describe("useAgentInvoke — surfaceContext (guuey#398)", () => {
  it("sends the context line on the body and keeps the optimistic message clean", async () => {
    const { adapters, bodies } = capturingAdapters();
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({
        endpointUrl: "https://pod.example.com",
        appId: APP_ID,
        adapters,
        surfaceContext: "The user is signed in to the guuey builder console.",
      }),
    );
    await act(async () => {
      await result.current.send("show my agents");
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      input: "show my agents",
      surfaceContext: "The user is signed in to the guuey builder console.",
    });
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      text: "show my agents", // never the composed preamble
    });
    unmount();
  });

  it("omits the field entirely when the option is absent", async () => {
    const { adapters, bodies } = capturingAdapters();
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );
    await act(async () => {
      await result.current.send("hi");
    });
    expect(Object.keys(bodies[0] as Record<string, never>)).not.toContain("surfaceContext");
    unmount();
  });
});
