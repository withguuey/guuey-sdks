// @vitest-environment jsdom
/**
 * guuey#2858: the hook says when the history it seeded stopped at its page
 * cap on a newest-first read (`historyTruncated`), so a renderer can say
 * earlier messages are not shown; a whole history, a truncated ascending read
 * (it left the newest out), `reset()` and an app switch leave it false.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, HistoryLoadResult } from "./types.js";

function adapters(load: (tid: string) => Promise<HistoryLoadResult>): AgentInvokeAdapters {
  return {
    storage: { load: () => "t-1", save: () => {} },
    generateId: () => "cm-x",
    transport: async function* () {},
    history: { load },
  };
}

describe("useAgentInvoke — historyTruncated (guuey#2858)", () => {
  it("a truncated read sets it; reset clears it", async () => {
    const load = vi.fn(async (): Promise<HistoryLoadResult> => ({
      messages: [{ role: "user", text: "q", seq: 30 }, { role: "assistant", text: "a", seq: 31 }],
      truncated: true,
      order: "desc",
    }));
    const { result } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-1", adapters: adapters(load) }),
    );
    await waitFor(() => expect(result.current.historyTruncated).toBe(true));
    expect(result.current.messages).toHaveLength(2);
    act(() => result.current.reset());
    expect(result.current.historyTruncated).toBe(false);
  });

  it("a truncated ASCENDING read leaves it false: that read left out the newest rows, not the earliest", async () => {
    const load = vi.fn(async (): Promise<HistoryLoadResult> => ({
      messages: [{ role: "user", text: "q", seq: 1 }, { role: "assistant", text: "a", seq: 2 }],
      truncated: true,
      order: "asc",
    }));
    const { result } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-1", adapters: adapters(load) }),
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.historyTruncated).toBe(false);
  });

  it("a whole read leaves it false", async () => {
    const load = vi.fn(async (): Promise<HistoryLoadResult> => ({ messages: [{ role: "user", text: "q", seq: 1 }] }));
    const { result } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-1", adapters: adapters(load) }),
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.historyTruncated).toBe(false);
  });

  it("an app switch clears it", async () => {
    const load = vi.fn(async (): Promise<HistoryLoadResult> => ({
      messages: [{ role: "user", text: "q", seq: 9 }],
      truncated: true,
      order: "desc",
    }));
    const empty = vi.fn(async (): Promise<HistoryLoadResult> => ({ messages: [] }));
    const { result, rerender } = renderHook(
      ({ appId }: { appId: string }) =>
        useAgentInvoke({ endpointUrl: "https://pod.example.com", appId, adapters: adapters(appId === "app-1" ? load : empty) }),
      { initialProps: { appId: "app-1" } },
    );
    await waitFor(() => expect(result.current.historyTruncated).toBe(true));
    rerender({ appId: "app-2" });
    await waitFor(() => expect(empty).toHaveBeenCalled());
    expect(result.current.historyTruncated).toBe(false);
  });
});
