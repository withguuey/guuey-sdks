// @vitest-environment jsdom
/**
 * The renderer-state owner + the live assembler: toggle semantics (a
 * default-expanded item's first toggle collapses it), phase round-trips,
 * the in-flight/aborted source split, and the R10 prompt ledger.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook , cleanup } from "@testing-library/react";
import type { HistoryLoadResult, UseAgentInvokeReturn } from "@guuey/agent-client";
import { Reducer, type AgHitlAnswer, type AgPausedAsk, type AgReduceResult } from "@silverprotocol/core";
import { calmPolicy, debugPolicy } from "../policy.js";
import type { ChatDebugEvent, TranscriptInputs } from "../types.js";
import { transcriptInputsFromHistory } from "../history-inputs.js";
import { planTranscript } from "../plan.js";
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

  // guuey#408 (the #401-class fail-loud lesson): a WIRED reader's miss
  // names the uri + origin on the debug channel — a never-working
  // transport must not vanish into placeholders. The reader-less arm
  // above stays silent (no read happened, nothing failed).
  it("a wired reader's locator miss emits locator-read-miss with the uri and origin (debug)", async () => {
    const events: ChatDebugEvent[] = [];
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
    const reader = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useTranscript({ inputs, policy: debugPolicy(), reader, onDebugEvent: (e) => events.push(e) }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const view = result.current.plan.items.find((i) => i.kind === "view");
    expect(result.current.resolvedMounts.get(view!.key)).toBe("expired");
    const misses = events.filter((e) => e.type === "locator-read-miss");
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({
      key: view!.key,
      resourceUri: "ui://app/1",
      origin: "history",
    });
  });

  it("a THROWING reader also emits the loud miss (transport failure == miss, still named)", async () => {
    const events: ChatDebugEvent[] = [];
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
                uiData: { resourceUri: "ui://app/2" },
              },
            ],
          },
        },
      ],
    });
    const reader = vi.fn().mockRejectedValue(new Error("gateway 404"));
    const { result } = renderHook(() =>
      useTranscript({ inputs, policy: debugPolicy(), reader, onDebugEvent: (e) => events.push(e) }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const view = result.current.plan.items.find((i) => i.kind === "view");
    expect(result.current.resolvedMounts.get(view!.key)).toBe("expired");
    expect(events.filter((e) => e.type === "locator-read-miss")).toHaveLength(1);
  });
});

function invokeReturn(over: Partial<UseAgentInvokeReturn> = {}): UseAgentInvokeReturn {
  return {
    messages: [
      { role: "user", text: "hi", clientMessageId: "cm-1" },
      { role: "assistant", text: "partial answer" },
    ],
    send: vi.fn(async () => {}),
    newClientMessageId: vi.fn(() => "cm-new"),
    status: "responding",
    activeTool: null,
    error: null,
    errorCode: null,
    threadClosed: null,
    threadId: "t1",
    abort: vi.fn(),
    reset: vi.fn(),
    reduceResult: null,
    historyCards: [],
    historyTruncated: false,
    historyToolResults: [],
    historyToolCalls: null,
    profileLinkRequest: null,
    clearProfileLinkRequest: vi.fn(),
    aborted: false,
    adopted: false,
    sendStates: {},
    acceptedInputKinds: null,
    ...over,
  };
}

/**
 * guuey#1837: a LIVE locator card read while its turn streams can miss on both doors by
 * construction (no pod door on a pre-#209 router; the platform door's card row is written at turn
 * end, before `done`). That miss is held, and the card is read once more when the turn settles.
 */
describe("useTranscript — a live card missed mid-turn is read once more at settle (guuey#1837)", () => {
  const LIVE_URI = "ui://ggui/render/render_live/abc";
  const LIVE_FOLD: AgReduceResult = {
    messages: [
      { id: "msg_1", role: "assistant", content: [{ type: "tool-call", toolCallId: "toolu_1", name: "ggui_render", input: {} }] },
      {
        id: "msg_1_result",
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "toolu_1", content: [], uiData: { resourceUri: LIVE_URI } }],
      },
    ],
    artifacts: [],
    memory: [],
    turns: [],
  };
  const HIT = { channel: "inline" as const, resource: { uri: LIVE_URI, mimeType: "text/html", text: "<p>card</p>" } };
  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const liveView = (plan: { views: readonly { key: string; origin: "live" | "history" }[] }) => {
    const v = plan.views.find((x) => x.origin === "live");
    if (v === undefined) throw new Error("no live view in the plan");
    return v;
  };

  it("a mid-turn miss is not a verdict: nothing settles, and the settled turn's one re-read mounts the card", async () => {
    const reader = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(HIT);
    const { result, rerender } = renderHook(
      ({ status }: { status: TranscriptInputs["status"] }) =>
        useTranscript({ inputs: baseInputs({ result: LIVE_FOLD, status, messages: [{ role: "user", text: "show me" }] }), policy: calmPolicy(), reader }),
      { initialProps: { status: "responding" as TranscriptInputs["status"] } },
    );
    await flush();
    const key = liveView(result.current.plan).key;
    expect(reader).toHaveBeenCalledTimes(1);
    expect(result.current.resolvedMounts.has(key)).toBe(false);
    // Still streaming: no second read however often the plan changes.
    rerender({ status: "responding" });
    await flush();
    expect(reader).toHaveBeenCalledTimes(1);
    rerender({ status: "ready" });
    await flush();
    expect(reader).toHaveBeenCalledTimes(2);
    expect(result.current.resolvedMounts.get(key)).toEqual(HIT);
  });

  it("a miss on the re-read is expired, and the loud miss fires once, on the verdict", async () => {
    const events: ChatDebugEvent[] = [];
    const reader = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ status }: { status: TranscriptInputs["status"] }) =>
        useTranscript({
          inputs: baseInputs({ result: LIVE_FOLD, status, messages: [{ role: "user", text: "show me" }] }),
          policy: debugPolicy(),
          reader,
          onDebugEvent: (e) => events.push(e),
        }),
      { initialProps: { status: "responding" as TranscriptInputs["status"] } },
    );
    await flush();
    expect(events.filter((e) => e.type === "locator-read-miss")).toHaveLength(0);
    rerender({ status: "ready" });
    await flush();
    const key = liveView(result.current.plan).key;
    expect(reader).toHaveBeenCalledTimes(2);
    expect(result.current.resolvedMounts.get(key)).toBe("expired");
    expect(events.filter((e) => e.type === "locator-read-miss")).toHaveLength(1);
    // Never a loop: later plans read nothing more.
    rerender({ status: "ready" });
    await flush();
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("a miss read once the turn has settled is expired at once, exactly as before", async () => {
    const reader = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useTranscript({ inputs: baseInputs({ result: LIVE_FOLD, status: "ready", messages: [{ role: "user", text: "show me" }] }), policy: calmPolicy(), reader }),
    );
    await flush();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(result.current.resolvedMounts.get(liveView(result.current.plan).key)).toBe("expired");
  });
});

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

describe("useTranscriptInputs — the truncated-history line (guuey#2858)", () => {
  it("carries the hook's historyTruncated only when it is true, as the history assembler does", () => {
    const truncated = renderHook(() => useTranscriptInputs(invokeReturn({ status: "ready", historyTruncated: true })));
    expect(truncated.result.current.inputs.historyTruncated).toBe(true);
    const whole = renderHook(() => useTranscriptInputs(invokeReturn({ status: "ready" })));
    expect(whole.result.current.inputs).not.toHaveProperty("historyTruncated");
  });
});

/**
 * guuey#2388: the two assemblers carry a history read's tool calls and results
 * under ONE gate (calls asked and honoured), and give deep-equal planner input
 * for the same read, as `history-inputs.ts` promises.
 */
describe("useTranscriptInputs — history tool rows (guuey#2388), assembler equality", () => {
  type Loaded = Extract<HistoryLoadResult, { messages: unknown }>;
  const AT = "2026-10-28T00:00:00.000Z";
  const cardPart = {
    type: "tool-result" as const,
    toolCallId: "toolu_card",
    content: [{ type: "text" as const, text: "shown" }],
    uiData: { uri: "ui://cards/1", mimeType: "text/html", text: "<p>card</p>" },
  };
  const both: Loaded = {
    messages: [
      { role: "user", text: "show me", seq: 1 },
      { role: "assistant", text: "There.", seq: 6 },
    ],
    cards: [{ seq: 3, at: AT, cardSnapshot: { parts: [cardPart] }, toolName: "show_card" }],
    toolCalls: [
      { seq: 2, at: AT, call: { toolCallId: "toolu_card", name: "show_card", input: {} }, card: { seq: 3, result: cardPart } },
      { seq: 4, at: AT, call: { toolCallId: "toolu_look", name: "look_up", input: { q: "x" } } },
    ],
    toolResults: [
      {
        seq: 5,
        at: AT,
        toolCallId: "toolu_look",
        toolName: "look_up",
        block: { type: "tool-result", toolCallId: "toolu_look", content: [{ type: "text", text: "found" }] },
      },
    ],
  };
  const { toolResults: _results, ...callsOnly } = both;
  const { toolCalls: _calls, ...resultsOnly } = both;

  /** The hook's state after the mount load of `load` (the seeding `useAgentInvoke` does). */
  const seeded = (load: Loaded): UseAgentInvokeReturn =>
    invokeReturn({
      status: "ready",
      messages: load.messages,
      historyCards: load.cards ?? [],
      historyToolCalls: load.toolCalls ?? null,
      historyToolResults: load.toolResults ?? [],
    });

  for (const [name, load] of [
    ["calls and results asked", both],
    ["calls only asked", callsOnly],
    ["results only asked", resultsOnly],
  ] as const) {
    it(`${name}: messages, historyCards and historyTools are deep-equal`, () => {
      const live = renderHook(() => useTranscriptInputs(seeded(load))).result.current.inputs;
      const history = transcriptInputsFromHistory(load);
      expect(live.messages).toEqual(history.messages);
      expect(live.historyCards).toEqual(history.historyCards);
      expect(live.historyTools).toEqual(history.historyTools);
      expect(planTranscript(live, calmPolicy()).items).toEqual(planTranscript(history, calmPolicy()).items);
    });
  }

  it("draws no tool rows unless calls were asked and honoured (historyToolCalls null)", () => {
    const live = renderHook(() => useTranscriptInputs(seeded(resultsOnly))).result.current.inputs;
    expect(live).not.toHaveProperty("historyTools");
    expect(planTranscript(live, calmPolicy()).items.some((i) => i.kind === "tool" || i.kind === "data-result")).toBe(false);
  });

  it("carries the read's calls and results when calls were honoured", () => {
    const live = renderHook(() => useTranscriptInputs(seeded(both))).result.current.inputs;
    expect(live.historyTools).toEqual({ calls: both.toolCalls, results: both.toolResults });
    expect(planTranscript(live, calmPolicy()).items.map((i) => i.key)).toEqual([
      "u0",
      "tool.toolu_card",
      "card.3",
      "tool.toolu_look",
      "a0.t0",
    ]);
  });
});
