// @vitest-environment jsdom
/**
 * The renderer-state owner + the live assembler: toggle semantics (a
 * default-expanded item's first toggle collapses it), phase round-trips,
 * the in-flight/aborted source split, and the R10 prompt ledger.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook , cleanup } from "@testing-library/react";
import type { UseAgentInvokeReturn } from "@guuey/agent-client";
import { calmPolicy } from "../policy.js";
import type { TranscriptInputs } from "../types.js";
import { useTranscript, useTranscriptInputs } from "./use-transcript.js";

afterEach(cleanup);

function baseInputs(over: Partial<TranscriptInputs> = {}): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello there" },
    ],
    ...over,
  };
}

describe("useTranscript", () => {
  it("toggle flips the item's CURRENT resolved state, both directions", () => {
    const { result } = renderHook(() =>
      useTranscript({ inputs: baseInputs(), policy: calmPolicy() }),
    );
    const textItem = result.current.plan.items.find((i) => i.kind === "text");
    expect(textItem?.expanded).toBe(true); // policy default for text

    act(() => result.current.toggle(textItem!.key));
    expect(result.current.plan.items.find((i) => i.kind === "text")?.expanded).toBe(false);

    act(() => result.current.toggle(textItem!.key));
    expect(result.current.plan.items.find((i) => i.kind === "text")?.expanded).toBe(true);
  });

  it("onViewPhase round-trips into the next plan's R6 state", () => {
    const inputs = baseInputs({
      historyCards: [
        {
          seq: 1,
          at: "2026-08-15T00:00:00Z",
          cardSnapshot: {
            parts: [
              {
                type: "tool-result",
                toolCallId: "c1",
                content: [],
                uiData: { resourceUri: "ui://app/1" },
              },
            ],
          },
        },
      ],
    });
    const { result } = renderHook(() => useTranscript({ inputs, policy: calmPolicy() }));
    const view = result.current.plan.items.find((i) => i.kind === "view");
    expect(view).toBeDefined();
    expect(view!.kind === "view" && view!.phase).toBe("negotiating");

    act(() => result.current.onViewPhase(view!.key, "connected"));
    const after = result.current.plan.items.find((i) => i.kind === "view");
    expect(after!.kind === "view" && after!.phase).toBe("connected");
  });

  it("locator mounts without a reader settle to 'expired' (labeled, never blank)", async () => {
    const inputs = baseInputs({
      historyCards: [
        {
          seq: 1,
          at: "2026-08-15T00:00:00Z",
          cardSnapshot: {
            parts: [
              {
                type: "tool-result",
                toolCallId: "c1",
                content: [],
                uiData: { resourceUri: "ui://app/1" },
              },
            ],
          },
        },
      ],
    });
    const { result } = renderHook(() => useTranscript({ inputs, policy: calmPolicy() }));
    await act(async () => {
      await Promise.resolve();
    });
    const view = result.current.plan.items.find((i) => i.kind === "view");
    expect(result.current.resolvedMounts.get(view!.key)).toBe("expired");
  });
});

function invokeReturn(over: Partial<UseAgentInvokeReturn> = {}): UseAgentInvokeReturn {
  return {
    messages: [
      { role: "user", text: "hi", clientMessageId: "cm-1" },
      { role: "assistant", text: "partial answer" },
    ],
    send: vi.fn(async () => {}),
    status: "responding",
    activeTool: null,
    error: null,
    errorCode: null,
    threadId: "t1",
    abort: vi.fn(),
    reset: vi.fn(),
    reduceResult: null,
    historyCards: [],
    profileConsentRequest: null,
    clearProfileConsentRequest: vi.fn(),
    profileLinkRequest: null,
    clearProfileLinkRequest: vi.fn(),
    aborted: false,
    adopted: false,
    sendStates: {},
    ...over,
  };
}

describe("useTranscriptInputs (the live assembler)", () => {
  it("moves the trailing in-flight assistant entry to assistantText", () => {
    const { result } = renderHook(() => useTranscriptInputs(invokeReturn()));
    expect(result.current.inputs.assistantText).toBe("partial answer");
    expect(result.current.inputs.messages).toEqual([
      { role: "user", text: "hi", clientMessageId: "cm-1" },
    ]);
  });

  it("keeps settled turns settled when ready, and routes the abort-kept partial as stopped", () => {
    const ready = renderHook(() => useTranscriptInputs(invokeReturn({ status: "ready" })));
    // Ready + not aborted: the last assistant entry is a SETTLED reply.
    expect(ready.result.current.inputs.assistantText).toBe("");
    expect(ready.result.current.inputs.messages).toHaveLength(2);

    const aborted = renderHook(() =>
      useTranscriptInputs(invokeReturn({ status: "ready", aborted: true })),
    );
    expect(aborted.result.current.inputs.assistantText).toBe("partial answer");
    expect(aborted.result.current.inputs.aborted).toBe(true);
  });

  it("maps error + errorCode into the single error input", () => {
    const { result } = renderHook(() =>
      useTranscriptInputs(invokeReturn({ error: "boom", errorCode: "TIMEOUT" })),
    );
    expect(result.current.inputs.error).toEqual({ message: "boom", code: "TIMEOUT" });
  });

  it("ledgers a consent ask: pending on arrival, answered via resolvePrompt, dismissed on silent clear", () => {
    const cleared = vi.fn();
    const { result, rerender } = renderHook(
      ({ invoke }: { invoke: UseAgentInvokeReturn }) => useTranscriptInputs(invoke),
      {
        initialProps: {
          invoke: invokeReturn({
            profileConsentRequest: { appId: "app-1", requested: "read" },
            clearProfileConsentRequest: cleared,
          }),
        },
      },
    );
    expect(result.current.inputs.prompts).toEqual([
      expect.objectContaining({ kind: "consent", state: "pending", appId: "app-1" }),
    ]);

    const id = result.current.inputs.prompts[0].id;
    act(() => result.current.resolvePrompt(id, "answered"));
    expect(result.current.inputs.prompts[0].state).toBe("answered");
    expect(cleared).toHaveBeenCalled();

    // A NEW ask arrives and then vanishes without a recorded action → dismissed.
    rerender({
      invoke: invokeReturn({
        profileConsentRequest: { appId: "app-2", requested: "read-write" },
        clearProfileConsentRequest: cleared,
      }),
    });
    expect(result.current.inputs.prompts).toHaveLength(2);
    rerender({ invoke: invokeReturn({ profileConsentRequest: null }) });
    expect(result.current.inputs.prompts[1].state).toBe("dismissed");
    // The answered record is untouched.
    expect(result.current.inputs.prompts[0].state).toBe("answered");
  });
});
