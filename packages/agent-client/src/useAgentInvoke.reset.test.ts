// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke";
import type { AgentInvokeAdapters, InvokeRequest } from "./types";

const APP_ID = "app-reset";
const THREAD_KEY = `guuey:thread:${APP_ID}`;

function makeAdapters(store: Record<string, string>, sentBodies: unknown[]): AgentInvokeAdapters {
  return {
    storage: {
      load: (k) => (k in store ? store[k] : null),
      save: (k, v) => {
        store[k] = v;
      },
    },
    generateId: () => "cmid-test",
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      sentBodies.push(req.body);
      yield "event: done\ndata: {}\n\n";
    },
  };
}

describe("useAgentInvoke reset()", () => {
  it("forgets the thread identity so the next send starts a fresh thread", async () => {
    const store: Record<string, string> = { [THREAD_KEY]: "old-thread" };
    const sentBodies: unknown[] = [];
    const adapters = makeAdapters(store, sentBodies);

    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );

    // The persisted threadId hydrates asynchronously on mount.
    await waitFor(() => expect(result.current.threadId).toBe("old-thread"));

    // reset() must clear the in-memory AND persisted thread identity.
    await act(async () => {
      result.current.reset();
    });
    expect(result.current.threadId).toBeNull();
    expect(store[THREAD_KEY]).toBe("");

    // The next send() must NOT replay the old thread id — it starts fresh.
    await act(async () => {
      await result.current.send("hello");
    });
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toMatchObject({ input: "hello", clientMessageId: "cmid-test" });
    expect(sentBodies[0]).not.toHaveProperty("threadId");

    unmount();
  });
});
