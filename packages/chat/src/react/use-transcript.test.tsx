// @vitest-environment jsdom
/**
 * The renderer-state owner + the live assembler: toggle semantics (a
 * default-expanded item's first toggle collapses it), phase round-trips,
 * the in-flight/aborted source split, and the R10 prompt ledger.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook , cleanup } from "@testing-library/react";
import type { UseAgentInvokeReturn } from "@guuey/agent-client";
import { Reducer, type AgHitlAnswer, type AgPausedAsk, type AgReduceResult } from "@silverprotocol/core";
import { calmPolicy, debugPolicy } from "../policy.js";
import type { ChatDebugEvent, TranscriptInputs } from "../types.js";
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

  it("onDebugEvent fires under debug — phase transitions, unknown blocks, the recovered marker — and calm ignores it", () => {
    const events: ChatDebugEvent[] = [];
    const sink = (ev: ChatDebugEvent): void => {
      events.push(ev);
    };
    const inputs = baseInputs({
      adopted: true,
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

    // Debug policy: all three event kinds reach the sink.
    const { result } = renderHook(() =>
      useTranscript({ inputs, policy: debugPolicy(), onDebugEvent: sink }),
    );
    expect(events.some((e) => e.type === "turn-recovered")).toBe(true);
    const view = result.current.plan.items.find((i) => i.kind === "view");
    act(() => result.current.onViewPhase(view!.key, "connected"));
    // A repeat of the SAME phase does not re-fire; the reader-less locator's
    // "expired" settle emitted its own phase event alongside.
    act(() => result.current.onViewPhase(view!.key, "connected"));
    const phases = events.filter((e) => e.type === "view-phase");
    expect(phases.filter((e) => e.phase === "connected")).toHaveLength(1);
    expect(phases.some((e) => e.phase === "expired")).toBe(true);

    // An R15 sighting emits once per key, and a re-render does not re-fire.
    const reducer = new Reducer();
    const unknownEvents: import("@silverprotocol/core").AgEvent[] = [
      { type: "turn.start", threadId: "t", turnId: "turn-u", seq: 0 },
      { type: "message.start", id: "m", role: "assistant", turnId: "turn-u", threadId: "t", seq: 1 },
      {
        type: "content.block",
        block: { type: "provider-raw", vendor: "futurecorp", raw: { x: 1 } },
        turnId: "turn-u",
        seq: 2,
      },
    ];
    for (const ev of unknownEvents) reducer.push(ev);
    const events2: ChatDebugEvent[] = [];
    const unknown = renderHook(() =>
      useTranscript({
        inputs: baseInputs({ result: reducer.result(), messages: [{ role: "user", text: "?" }] }),
        policy: debugPolicy(),
        onDebugEvent: (ev) => {
          events2.push(ev);
        },
      }),
    );
    expect(events2.filter((e) => e.type === "unknown-block")).toHaveLength(1);
    unknown.rerender();
    expect(events2.filter((e) => e.type === "unknown-block")).toHaveLength(1);

    // Calm: the same inputs produce ZERO sink calls (spec §5's row).
    const calmEvents: ChatDebugEvent[] = [];
    const calm = renderHook(() =>
      useTranscript({
        inputs,
        policy: calmPolicy(),
        onDebugEvent: (ev) => {
          calmEvents.push(ev);
        },
      }),
    );
    const calmView = calm.result.current.plan.items.find((i) => i.kind === "view");
    act(() => calm.result.current.onViewPhase(calmView!.key, "connected"));
    expect(calmEvents).toHaveLength(0);
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

  it("lifts the pod's consent ask from the FOLD (guuey#207): a paused turn with declared grantModes → a pending hitl prompt; answering ledgers the pick", () => {
    const ask: AgPausedAsk = {
      askId: "profile-consent:app-1:t1",
      kind: "approval",
      message: "App wants to read your guuey profile.",
      grantModes: [
        { id: "always", label: "Always allow" },
        { id: "once", label: "Allow this chat" },
      ],
    };
    const reduceResult: AgReduceResult = {
      messages: [],
      artifacts: [],
      memory: [],
      turns: [
        { turnId: `${ask.askId}#turn`, threadId: "t1", finishReason: "paused", outcome: { type: "paused", asks: [ask] } },
      ],
    };
    const { result } = renderHook(() => useTranscriptInputs(invokeReturn({ reduceResult })));
    expect(result.current.inputs.prompts).toEqual([
      expect.objectContaining({ kind: "hitl", id: ask.askId, state: "pending", ask }),
    ]);
    let answer: AgHitlAnswer | undefined;
    act(() => {
      answer = result.current.answerHitlPrompt(ask, { grantModeId: "once" });
    });
    // The built answer is spec-valid and ready for the host's relay.
    expect(answer).toEqual({ askId: ask.askId, status: "resolved", grantModeId: "once" });
    expect(result.current.inputs.prompts[0]).toMatchObject({ kind: "hitl", state: "resolved", grantModeId: "once" });
  });
});
