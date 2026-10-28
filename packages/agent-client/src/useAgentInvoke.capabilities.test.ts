// @vitest-environment jsdom
/**
 * The advertised AgJSON client capabilities are read at SEND time, like
 * `pageContext` and `mode`: a consumer whose capabilities change between
 * turns advertises the new set on the next turn, without `send` changing
 * identity while the hook is idle.
 */
import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AgClientCapabilities } from "@silverprotocol/core";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

const APP_ID = "app-capabilities";
const VIEW_TURNS: AgClientCapabilities = { hitl: { ask: true, grantModes: true }, uiResources: { viewMessageTurns: true } };

function capturingAdapters() {
  const bodies: unknown[] = [];
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => "cmid-capabilities",
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      bodies.push(req.body);
      yield 'event: done\ndata: {"stopReason":"end_turn"}\n\n';
    },
  };
  return { adapters, bodies };
}

describe("useAgentInvoke — capabilities are read at send time", () => {
  it("a capabilities change while idle rides the NEXT turn, and send keeps its identity", async () => {
    const { adapters, bodies } = capturingAdapters();
    const { result, rerender, unmount } = renderHook(
      ({ caps }: { caps: AgClientCapabilities | undefined }) =>
        useAgentInvoke({
          endpointUrl: "https://pod.example.com",
          appId: APP_ID,
          adapters,
          ...(caps !== undefined ? { capabilities: caps } : {}),
        }),
      { initialProps: { caps: undefined as AgClientCapabilities | undefined } },
    );
    await act(async () => {
      await result.current.send("first");
    });
    expect(bodies[0]).not.toHaveProperty("capabilities");

    const idleSend = result.current.send;
    rerender({ caps: VIEW_TURNS });
    expect(result.current.send).toBe(idleSend);
    await act(async () => {
      await result.current.send("second");
    });
    expect(bodies[1]).toMatchObject({ capabilities: VIEW_TURNS });

    rerender({ caps: undefined });
    await act(async () => {
      await result.current.send("third");
    });
    expect(bodies[2]).not.toHaveProperty("capabilities");
    unmount();
  });
});
