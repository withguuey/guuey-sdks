// @vitest-environment jsdom
/**
 * guuey#186 Gap 4: the hook accepts an external AbortSignal, composed with
 * its internal per-turn controller — a host lifecycle (route change, dialog
 * close) can stop a turn without holding the hook's own `abort()`.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

const APP_ID = "app-signal";

/**
 * Adapters whose transport yields one text frame, then parks until the
 * request's signal aborts — the external-abort scenario needs a turn that is
 * genuinely in flight when the host pulls the plug.
 */
function makeAdapters(sentRequests: InvokeRequest[]): AgentInvokeAdapters {
  return {
    storage: { load: () => null, save: () => {} },
    generateId: () => "cmid-test",
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      sentRequests.push(req);
      yield 'event: message\ndata: {"type":"text","text":"partial"}\n\n';
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) resolve();
        else req.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      req.signal.throwIfAborted();
    },
  };
}

describe("useAgentInvoke external AbortSignal", () => {
  it("aborts the in-flight turn when the external signal fires", async () => {
    const external = new AbortController();
    const sentRequests: InvokeRequest[] = [];
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({
        endpointUrl: "https://pod.example.com",
        appId: APP_ID,
        adapters: makeAdapters(sentRequests),
        signal: external.signal,
      }),
    );

    let sendDone: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hello");
      // Let the transport open and yield its first frame.
      await waitFor(() => expect(sentRequests).toHaveLength(1));
    });
    expect(result.current.status).not.toBe("ready");

    await act(async () => {
      external.abort();
      await sendDone;
    });

    // The turn settled as an abort settles it: back to ready, no error
    // surfaced (an aborted turn is the user's choice, not a failure).
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
    expect(sentRequests[0].signal.aborted).toBe(true);
    unmount();
  });

  it("refuses a send when the external signal is already aborted — no request is made", async () => {
    const external = new AbortController();
    external.abort();
    const sentRequests: InvokeRequest[] = [];
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({
        endpointUrl: "https://pod.example.com",
        appId: APP_ID,
        adapters: makeAdapters(sentRequests),
        signal: external.signal,
      }),
    );

    await act(async () => {
      await result.current.send("hello");
    });

    expect(sentRequests).toHaveLength(0);
    expect(result.current.status).toBe("ready");
    unmount();
  });

  it("leaves the hook's own abort()/reset() authority intact beside the external signal", async () => {
    const external = new AbortController();
    const sentRequests: InvokeRequest[] = [];
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({
        endpointUrl: "https://pod.example.com",
        appId: APP_ID,
        adapters: makeAdapters(sentRequests),
        signal: external.signal,
      }),
    );

    let sendDone: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hello");
      await waitFor(() => expect(sentRequests).toHaveLength(1));
    });
    await act(async () => {
      result.current.abort();
      await sendDone;
    });

    expect(result.current.status).toBe("ready");
    // The external signal was never aborted — only the per-turn controller.
    expect(external.signal.aborted).toBe(false);
    unmount();
  });
});
