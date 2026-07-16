// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke";
import type {
  AgentInvokeAdapters,
  HistoryLoadResult,
  InvokeRequest,
} from "./types";

const APP_ID = "app-cards";
const THREAD_KEY = `guuey:thread:${APP_ID}`;

const CARD = { artifactId: "a1", turnId: "t1", data: { n: 1 } };

function makeAdapters(
  store: Record<string, string>,
  historyResult: HistoryLoadResult,
): AgentInvokeAdapters {
  return {
    storage: {
      load: (k) => (k in store ? store[k] : null),
      save: (k, v) => {
        store[k] = v;
      },
    },
    generateId: () => "cmid-test",
    transport: async function* (_req: InvokeRequest): AsyncGenerator<string> {
      yield "event: done\ndata: {}\n\n";
    },
    history: {
      load: async () => historyResult,
    },
  };
}

describe("useAgentInvoke historyCards", () => {
  it("surfaces persisted cards from a rehydrated transcript", async () => {
    const store: Record<string, string> = { [THREAD_KEY]: "t1" };
    const adapters = makeAdapters(store, {
      messages: [{ role: "assistant", text: "here" }],
      cards: [{ seq: 2, at: "2026-07-16T00:00:02Z", cardSnapshot: CARD }],
    });
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters, preserveBlocks: true }),
    );
    await waitFor(() =>
      expect(result.current.historyCards).toEqual([
        { seq: 2, at: "2026-07-16T00:00:02Z", cardSnapshot: CARD },
      ]),
    );
    // Text surface still seeds from the same load.
    expect(result.current.messages).toEqual([{ role: "assistant", text: "here" }]);
    unmount();
  });

  it("stays [] when the history result carries no cards (text-only adapter)", async () => {
    const store: Record<string, string> = { [THREAD_KEY]: "t1" };
    const adapters = makeAdapters(store, { messages: [{ role: "assistant", text: "here" }] });
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters }),
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.historyCards).toEqual([]);
    unmount();
  });

  it("reset() clears historyCards back to []", async () => {
    const store: Record<string, string> = { [THREAD_KEY]: "t1" };
    const adapters = makeAdapters(store, {
      messages: [{ role: "assistant", text: "here" }],
      cards: [{ seq: 2, at: "2026-07-16T00:00:02Z", cardSnapshot: CARD }],
    });
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters, preserveBlocks: true }),
    );
    await waitFor(() => expect(result.current.historyCards).toHaveLength(1));
    await act(async () => {
      result.current.reset();
    });
    expect(result.current.historyCards).toEqual([]);
    unmount();
  });
});
