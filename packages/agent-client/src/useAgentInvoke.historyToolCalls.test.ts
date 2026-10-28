// @vitest-environment jsdom
/**
 * guuey#2388: the hook surfaces the stored tool calls a history read carries
 * (`historyToolCalls`), beside #2487's `historyToolResults`, at every site
 * that seeds or clears history: the mount load, the stall watchdog's
 * adoption, `reset()` and an app switch. `null` means not asked, or not
 * honoured by every page of the read: the kit then draws no tool rows, which
 * is today's reload. Each option asks only its own entry, so a host asking
 * results alone keeps #2487's request and gets `historyToolCalls: null`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { STALL_RECOVERY_DEFAULTS, useAgentInvoke } from "./useAgentInvoke.js";
import { createWebAdapters } from "./web-adapters.js";
import type {
  AgentInvokeAdapters,
  HistoryLoadResult,
  HistoryToolCall,
  HistoryToolResult,
  InvokeRequest,
} from "./types.js";

const CALL: HistoryToolCall = {
  seq: 2,
  at: "2026-10-28T00:00:02.000Z",
  call: { toolCallId: "toolu_find", name: "mcp__travel__find_flights", title: "Find flights", input: { from: "ICN", to: "SFO" } },
};
const RESULT: HistoryToolResult = {
  seq: 3,
  at: "2026-10-28T00:00:03.000Z",
  toolCallId: "toolu_find",
  toolName: "mcp__travel__find_flights",
  block: { type: "tool-result", toolCallId: "toolu_find", content: [], structuredContent: { flights: [] } },
  structuredContent: { flights: [] },
};

function adapters(load: (tid: string) => Promise<HistoryLoadResult>, transport?: AgentInvokeAdapters["transport"]): AgentInvokeAdapters {
  return {
    storage: { load: () => "t1", save: () => {} },
    generateId: () => "cm-x",
    transport: transport ?? async function* () {},
    history: { load },
  };
}

function render(load: (tid: string) => Promise<HistoryLoadResult>) {
  return renderHook(() => useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-1", adapters: adapters(load) }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useAgentInvoke — historyToolCalls (guuey#2388)", () => {
  it("the mount load surfaces the calls beside an unchanged historyToolResults", async () => {
    const { result } = render(async () => ({ messages: [{ role: "user", text: "q", seq: 1 }], toolResults: [RESULT], toolCalls: [CALL] }));
    await waitFor(() => expect(result.current.historyToolCalls).toEqual([CALL]));
    expect(result.current.historyToolResults).toEqual([RESULT]);
  });

  it("an honoured read with no calls is [] (asked and honoured), not null", async () => {
    const { result } = render(async () => ({ messages: [{ role: "user", text: "q", seq: 1 }], toolCalls: [] }));
    await waitFor(() => expect(result.current.historyToolCalls).toEqual([]));
  });

  it("is null before any load, and stays null when the load carries no calls (not asked, or not honoured)", async () => {
    const { result } = render(async () => ({ messages: [{ role: "user", text: "q", seq: 1 }], toolResults: [RESULT] }));
    expect(result.current.historyToolCalls).toBeNull();
    await waitFor(() => expect(result.current.historyToolResults).toEqual([RESULT]));
    expect(result.current.historyToolCalls).toBeNull();
  });

  it("reset() clears it back to null, beside historyToolResults back to []", async () => {
    const { result } = render(async () => ({ messages: [{ role: "user", text: "q", seq: 1 }], toolResults: [RESULT], toolCalls: [CALL] }));
    await waitFor(() => expect(result.current.historyToolCalls).toHaveLength(1));
    act(() => result.current.reset());
    expect(result.current.historyToolCalls).toBeNull();
    expect(result.current.historyToolResults).toEqual([]);
  });

  it("an app switch clears it back to null", async () => {
    const withCalls = vi.fn(async (): Promise<HistoryLoadResult> => ({ messages: [{ role: "user", text: "q", seq: 1 }], toolResults: [RESULT], toolCalls: [CALL] }));
    const empty = vi.fn(async (): Promise<HistoryLoadResult> => ({ messages: [] }));
    const { result, rerender } = renderHook(
      ({ appId }: { appId: string }) =>
        useAgentInvoke({ endpointUrl: "https://pod.example.com", appId, adapters: adapters(appId === "app-1" ? withCalls : empty) }),
      { initialProps: { appId: "app-1" } },
    );
    await waitFor(() => expect(result.current.historyToolCalls).toHaveLength(1));
    rerender({ appId: "app-2" });
    await waitFor(() => expect(empty).toHaveBeenCalled());
    expect(result.current.historyToolCalls).toBeNull();
    expect(result.current.historyToolResults).toEqual([]);
  });

  it("the stall watchdog's adoption takes the adopted read's calls, beside its results", async () => {
    vi.useFakeTimers();
    const SESSION = 'event: session\ndata: {"threadId":"t1"}\n\n';
    const PARTIAL = 'event: message\ndata: {"type":"text.delta","delta":"partial "}\n\n';
    async function* halfDead(req: InvokeRequest): AsyncGenerator<string> {
      yield SESSION;
      yield PARTIAL;
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) resolve();
        else req.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      req.signal.throwIfAborted();
    }
    let seeded = false;
    const load = async (): Promise<HistoryLoadResult> => {
      if (!seeded) {
        seeded = true;
        return { messages: [] };
      }
      return {
        messages: [
          { role: "user", text: "hi", seq: 1, clientMessageId: "cm-x" },
          { role: "assistant", text: "the full answer", seq: 4 },
        ],
        toolResults: [RESULT],
        toolCalls: [CALL],
      };
    };
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-1", adapters: adapters(load, halfDead) }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.historyToolCalls).toBeNull();
    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = result.current.send("hi");
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_RECOVERY_DEFAULTS.windowMs);
      await sendDone;
    });
    expect(result.current.adopted).toBe(true);
    expect(result.current.historyToolCalls).toEqual([CALL]);
    expect(result.current.historyToolResults).toEqual([RESULT]);
    unmount();
  });
});

/**
 * Owed by name (MX): asking results alone must never ask calls, and must never
 * surface a non-null `historyToolCalls`. The request is #2487's, byte for byte.
 */
describe("createWebAdapters + useAgentInvoke — results alone (MX)", () => {
  it("sends …&include=toolResults and no other include, and historyToolCalls stays null", async () => {
    const body = {
      rows: [
        { seq: 1, at: "2026-10-28T00:00:01.000Z", kind: "text", authorRole: "user", text: "q" },
        {
          seq: 3,
          at: "2026-10-28T00:00:03.000Z",
          kind: "text",
          authorRole: "agent",
          text: null,
          toolResults: [{ toolCallId: "toolu_find", toolName: "mcp__travel__find_flights", block: RESULT.block }],
        },
      ],
      nextToken: null,
      thread: {},
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(body), { status: 200 }));
    const web = createWebAdapters({
      apiBaseUrl: "https://api.example.com/v1",
      getGuestSecret: () => "0123456789abcdef".repeat(4),
      includeToolCalls: false,
      fetchImpl,
    });
    const history = web.history;
    if (!history) throw new Error("history adapter not installed");
    const { result } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-1", adapters: { ...web, storage: { load: () => "t1", save: () => {} }, history } }),
    );
    await waitFor(() => expect(result.current.historyToolResults).toHaveLength(1));
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://api.example.com/v1/threads/t1/messages?limit=100&order=desc&include=toolResults",
    ]);
    expect(result.current.historyToolCalls).toBeNull();
  });
});
