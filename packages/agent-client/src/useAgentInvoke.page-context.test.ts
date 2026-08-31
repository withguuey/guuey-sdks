// @vitest-environment jsdom
/**
 * guuey#524 v1 — `pageContext` (path + title + optional host context line)
 * rides the invoke BODY per turn; the client's only job is carriage. All
 * trust semantics (untrusted framing, `pageContextPresent`, the
 * ephemeral-turn sink shutdown) are POD-side and pinned there — these pins
 * cover the wire shape and the read-at-send-time freshness (SPA route
 * changes ride the next turn).
 */
import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, InvokeRequest, PageContext } from "./types.js";

const APP_ID = "app-page";

function capturingAdapters() {
  const bodies: unknown[] = [];
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => "cmid-page",
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      bodies.push(req.body);
      yield 'event: done\ndata: {"stopReason":"end_turn"}\n\n';
    },
  };
  return { adapters, bodies };
}

describe("useAgentInvoke — pageContext carriage (guuey#524)", () => {
  it("sends the page block on the body verbatim; the optimistic message stays clean", async () => {
    const { adapters, bodies } = capturingAdapters();
    const page: PageContext = { path: "/pricing", title: "Pricing — Acme", context: "annual toggle visible" };
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters, pageContext: page }),
    );
    await act(async () => {
      await result.current.send("what does this cost?");
    });
    expect(bodies[0]).toMatchObject({ input: "what does this cost?", pageContext: page });
    expect(result.current.messages[0]).toMatchObject({ role: "user", text: "what does this cost?" });
    unmount();
  });

  it("omits the field when absent, and reads the LIVE value at send time (SPA route change)", async () => {
    const { adapters, bodies } = capturingAdapters();
    const { result, rerender, unmount } = renderHook(
      ({ pc }: { pc: PageContext | undefined }) =>
        useAgentInvoke({
          endpointUrl: "https://pod.example.com",
          appId: APP_ID,
          adapters,
          ...(pc !== undefined ? { pageContext: pc } : {}),
        }),
      { initialProps: { pc: undefined as PageContext | undefined } },
    );
    await act(async () => {
      await result.current.send("hi");
    });
    expect(Object.keys(bodies[0] as Record<string, never>)).not.toContain("pageContext");
    // The host navigates; the NEXT turn carries the new page.
    rerender({ pc: { path: "/docs", title: "Docs" } });
    await act(async () => {
      await result.current.send("and here?");
    });
    expect(bodies[1]).toMatchObject({ pageContext: { path: "/docs", title: "Docs" } });
    unmount();
  });
});
