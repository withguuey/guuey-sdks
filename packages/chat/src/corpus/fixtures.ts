/**
 * The fixture corpus — the DEFINITION of "comfortably readable" (spec §8).
 *
 * Every fixture is a recorded `InvokeTurnEvent[]` sequence driven through
 * the real `@silverprotocol/core` Reducer (see `drive.ts`); the corpus test
 * asserts each fixture's spec-named property plus a full plan snapshot.
 *
 * THE STANDING RULE (see README.md): a new weird transcript found in
 * production becomes a fixture BEFORE its fix lands. The corpus only grows.
 */
import { Reducer, type AgEvent } from "@silverprotocol/core";
import type { InvokeTurnEvent } from "@guuey/agent-client";
import type { TranscriptInputs } from "../types.js";
import {
  boot,
  doneEvent,
  driveTurn,
  frame,
  seqSource,
  session,
  textPart,
  toolPart,
} from "./drive.js";

// The ggui render shapes below mirror mcp-apps-host's own capture-derived
// test fixtures (synthetic ids, production shape — ggui-render.test.ts).
const GGUI_RESOURCE_URI = "ui://ggui/render/render_00000000-0000-4000-8000-300000000001/c0ffee";
const GGUI_META_KEY = "ai.ggui/render";
const GGUI_SLICE = {
  sessionId: "render_00000000-0000-4000-8000-300000000001",
  appId: "APP00000",
  runtimeUrl: "https://dev.mcp.sandbox.ggui.ai/_ggui/iframe-runtime.js",
  wsUrl: "wss://dev.mcp.sandbox.ggui.ai/ws",
  wsToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  expiresAt: "2026-07-29T11:07:58.000Z",
  lastSequence: 0,
  propsJson: "{}",
};

/** 1. forty-tools — grouping caps the visual rows; keys stable. */
export function fortyTools(): { full: TranscriptInputs; midStream: TranscriptInputs } {
  const build = (count: number, settled: boolean): InvokeTurnEvent[] => {
    const s = seqSource();
    const events: InvokeTurnEvent[] = [session, frame(boot(s), { status: "thinking" })];
    for (let i = 1; i <= count; i++) {
      events.push(
        frame(toolPart(s, `t${i}`, `step_${i}`), { status: "using-tool", activeTool: `step_${i}` }),
      );
    }
    if (settled) {
      events.push(frame(textPart(s, "x", "All done."), { status: "responding", activeTool: null, text: "All done." }));
      events.push(doneEvent);
    }
    return events;
  };
  return {
    full: driveTurn(build(40, true), { userText: "run the batch" }),
    midStream: driveTurn(build(20, false), { userText: "run the batch" }),
  };
}

/** 2. midstream-tool-failure — tool 3 of 5 fails; badge without unroll. */
export function midstreamToolFailure(): TranscriptInputs {
  const s = seqSource();
  const events: InvokeTurnEvent[] = [session, frame(boot(s), { status: "thinking" })];
  for (let i = 1; i <= 5; i++) {
    events.push(
      frame(
        toolPart(s, `t${i}`, `step_${i}`, i === 3 ? { outcome: "error", errorText: "boom" } : {}),
        { status: "using-tool", activeTool: `step_${i}` },
      ),
    );
  }
  events.push(frame(textPart(s, "x", "Partial results in."), { status: "responding", activeTool: null, text: "Partial results in." }));
  events.push(doneEvent);
  return driveTurn(events, { userText: "sweep it" });
}

/** 3. cold-start — R12 escalation at 0 / 2.5 s / 15 s inputs. */
export function coldStart(elapsedMs: number): TranscriptInputs {
  return driveTurn([], { userText: "hi", finalStatus: "connecting", statusElapsedMs: elapsedMs });
}

/** 4. consent-gate — R10 pending → answered collapse. */
export function consentGate(state: "pending" | "answered"): TranscriptInputs {
  const s = seqSource();
  const events: InvokeTurnEvent[] = [
    session,
    frame(boot(s), { status: "thinking" }),
    { kind: "profile-consent", request: { appId: "app-1", requested: "read" } },
    frame(textPart(s, "x", "May I use your profile?"), { status: "responding", text: "May I use your profile?" }),
    doneEvent,
  ];
  return driveTurn(events, { userText: "book my usual", promptState: state });
}

/** 5. bypass-text-only — plan identical to a silver stream carrying only text. */
export function bypassVsSilver(): { bypass: TranscriptInputs; silver: TranscriptInputs } {
  const bypassEvents: InvokeTurnEvent[] = [
    session,
    frame([], { status: "responding", text: "Hello!" }),
    doneEvent,
  ];
  const s = seqSource();
  const silverEvents: InvokeTurnEvent[] = [
    session,
    frame(boot(s), { status: "thinking" }),
    frame(textPart(s, "x", "Hello!"), { status: "responding", text: "Hello!" }),
    doneEvent,
  ];
  return {
    bypass: driveTurn(bypassEvents, { userText: "hey" }),
    silver: driveTurn(silverEvents, { userText: "hey" }),
  };
}

/** 6. giant-json-result — 2 MB result: capped, labeled, plan stays cheap. */
export function giantJsonResult(): TranscriptInputs {
  const s = seqSource();
  const giant = { blob: "x".repeat(2_000_000) };
  const events: InvokeTurnEvent[] = [
    session,
    frame(boot(s), { status: "thinking" }),
    frame(toolPart(s, "t1", "export_dataset", { structuredContent: giant }), {
      status: "using-tool",
      activeTool: "export_dataset",
    }),
    frame(textPart(s, "x", "Exported."), { status: "responding", activeTool: null, text: "Exported." }),
    doneEvent,
  ];
  return driveTurn(events, { userText: "export everything" });
}

/** 7. view-never-handshakes — no-handshake on BOTH channels, channel-aware labels. */
export function viewNeverHandshakes(): TranscriptInputs {
  const s = seqSource();
  const events: InvokeTurnEvent[] = [
    session,
    frame(boot(s), { status: "thinking" }),
    frame(
      toolPart(s, "tInline", "render_form", {
        uiData: { uri: "ui://forms/1", mimeType: "text/html", text: "<p>form</p>" },
        content: [],
      }),
      { status: "using-tool", activeTool: "render_form" },
    ),
    frame(
      toolPart(s, "tGgui", "ggui_render", {
        uiData: { sessionId: GGUI_SLICE.sessionId, resourceUri: GGUI_RESOURCE_URI, action: "create" },
        content: [],
        _meta: { [GGUI_META_KEY]: GGUI_SLICE },
      }),
      { status: "using-tool", activeTool: "ggui_render" },
    ),
    doneEvent,
  ];
  return driveTurn(events, {
    userText: "show me",
    viewPhases: { "view.tInline": "no-handshake", "view.tGgui": "no-handshake" },
  });
}

/** 8. aborted-mid-stream — partial kept + Stopped.; no orphaned spinner. */
export function abortedMidStream(): TranscriptInputs {
  const s = seqSource();
  const events: InvokeTurnEvent[] = [
    session,
    frame(boot(s), { status: "thinking" }),
    frame(textPart(s, "x", "I was saying"), { status: "responding", text: "I was saying" }),
    // The never-finished tool: start + args, no tool.done — then the abort.
    frame(
      [
        { type: "tool.start", toolCallId: "t9", name: "slow_tool", seq: s() },
        { type: "tool.args.assembled", toolCallId: "t9", input: {}, seq: s() },
      ],
      { status: "using-tool", activeTool: "slow_tool", text: "I was saying" },
    ),
  ];
  return driveTurn(events, { userText: "go on", aborted: true });
}

/** 9. history-dead-locators — one dead card beside a healthy locator card. */
export function historyDeadLocators(): TranscriptInputs {
  const s = seqSource();
  const events: InvokeTurnEvent[] = [
    session,
    frame(boot(s), { status: "thinking" }),
    frame(textPart(s, "x", "Welcome back."), { status: "responding", text: "Welcome back." }),
    doneEvent,
  ];
  return driveTurn(events, {
    userText: "hi again",
    historyCards: [
      {
        seq: 1,
        at: "2026-08-15T00:00:00Z",
        cardSnapshot: {
          parts: [
            { type: "tool-result", toolCallId: "c1", content: [], uiData: { resourceUri: "ui://ggui/render/old/1" } },
          ],
        },
      },
      { seq: 2, at: "2026-08-15T00:01:00Z", cardSnapshot: { note: "meta was stripped; no locator survived" } },
    ],
  });
}

/** 10. empty-turn — done with no text/blocks: no empty bubble. */
export function emptyTurn(): TranscriptInputs {
  const s = seqSource();
  return driveTurn([session, frame(boot(s), { status: "thinking" }), doneEvent], { userText: "ping" });
}

/** 11. unknown-block-storm — R15 labeled rows; nothing blank, nothing raw. */
export function unknownBlockStorm(): TranscriptInputs {
  const s = seqSource();
  const bootEvents = boot(s);
  const storm: AgEvent[] = [0, 1, 2].map((i) => ({
    type: "content.block",
    block: { type: "provider-raw", vendor: "futurecorp", raw: { shape: i, payload: "??" } },
    seq: s(),
  }));
  const events: InvokeTurnEvent[] = [
    session,
    frame(bootEvents, { status: "thinking" }),
    frame(storm, { status: "responding" }),
    doneEvent,
  ];
  return driveTurn(events, { userText: "what is this" });
}

/** 12. interleaved-media-code-citations — R7/R8/R9 ordering in one turn. */
export function interleavedMediaCodeCitations(): TranscriptInputs {
  const s = seqSource();
  const bootEvents = boot(s);
  const blocks: AgEvent[] = [
    {
      type: "content.block",
      block: { type: "image", source: { type: "url", url: "https://cdn.example/chart.png", mediaType: "image/png" } },
      seq: s(),
    },
    { type: "content.block", block: { type: "code", language: "python", code: "print('hi')" }, seq: s() },
    { type: "content.block", block: { type: "search-result", url: "https://a.example", title: "A" }, seq: s() },
    { type: "content.block", block: { type: "search-result", url: "https://b.example", title: "B" }, seq: s() },
  ];
  const events: InvokeTurnEvent[] = [
    session,
    frame(bootEvents, { status: "thinking" }),
    frame(blocks, { status: "responding" }),
    frame(textPart(s, "x", "Sources above."), { status: "responding", text: "Sources above." }),
    doneEvent,
  ];
  return driveTurn(events, { userText: "chart + code + sources" });
}

/** 13. saturated-then-served — the retry is invisible; only R12 waiting shows. */
export function saturatedThenServed(): { waiting: TranscriptInputs; served: TranscriptInputs } {
  const s = seqSource();
  const events: InvokeTurnEvent[] = [
    session,
    frame(boot(s), { status: "thinking" }),
    frame(textPart(s, "x", "Served after the invisible retry."), { status: "responding", text: "Served after the invisible retry." }),
    doneEvent,
  ];
  return {
    waiting: driveTurn([], { userText: "hi", finalStatus: "connecting", statusElapsedMs: 3000 }),
    served: driveTurn(events, { userText: "hi" }),
  };
}

/** 14. reasoning-heavy — calm collapses to one line; debug expands. */
export function reasoningHeavy(): TranscriptInputs {
  const s = seqSource();
  const bootEvents = boot(s);
  const reasoning: AgEvent[] = [
    { type: "reasoning.start", id: "r1", seq: s() },
    { type: "reasoning.delta", id: "r1", delta: "Considering all twelve constraints at length… ".repeat(20), seq: s() },
    { type: "reasoning.end", id: "r1", seq: s() },
  ];
  const events: InvokeTurnEvent[] = [
    session,
    frame(bootEvents, { status: "thinking" }),
    frame(reasoning, { status: "thinking" }),
    frame(textPart(s, "x", "Thursday works."), { status: "responding", text: "Thursday works." }),
    doneEvent,
  ];
  return driveTurn(events, { userText: "which day?" });
}

/** 15. tools-around-a-view — the group SPLITS at the view's position. */
export function toolsAroundAView(): TranscriptInputs {
  const s = seqSource();
  const events: InvokeTurnEvent[] = [session, frame(boot(s), { status: "thinking" })];
  for (const id of ["t1", "t2"]) {
    events.push(frame(toolPart(s, id, `prep_${id}`), { status: "using-tool", activeTool: `prep_${id}` }));
  }
  events.push(
    frame(
      toolPart(s, "t3", "ggui_render", {
        uiData: { uri: "ui://cards/slot-picker", mimeType: "text/html", text: "<div>picker</div>" },
        content: [],
      }),
      { status: "using-tool", activeTool: "ggui_render" },
    ),
  );
  for (const id of ["t4", "t5"]) {
    events.push(frame(toolPart(s, id, `post_${id}`), { status: "using-tool", activeTool: `post_${id}` }));
  }
  events.push(doneEvent);
  return driveTurn(events, { userText: "pick a slot" });
}

/** 16. user-send-failure — R0 failed state with retry; never disappears. */
export function userSendFailure(): TranscriptInputs {
  return driveTurn([], {
    userText: "did this go through?",
    clientMessageId: "cm-1",
    finalStatus: "ready",
    sendStates: { "cm-1": "failed" },
  });
}

/**
 * 19. persisted-plus-live — the turn-scoped fold composition (portal's
 * persisted-overlay data model): a persisted prefix the session's Reducer
 * never saw + a session fold covering the trailing turns, one settled (its
 * card ALSO persisted — the dedupe case) and one live with a running tool.
 */
export function persistedPlusLive(): TranscriptInputs {
  const reducer = new Reducer();
  let seq = 0;
  const s = (): number => seq++;
  const push = (events: AgEvent[]): void => {
    for (const ev of events) reducer.push(ev);
  };
  // Session turn A (settled — turn.done carries the outcome):
  push([
    { type: "turn.start", threadId: "thread-corpus", turnId: "turn-a", seq: s() },
    { type: "message.start", id: "msg-a", role: "assistant", turnId: "turn-a", threadId: "thread-corpus", seq: s() },
    { type: "text.start", id: "ta", seq: s() },
    { type: "text.delta", id: "ta", delta: "Booked the second option.", seq: s() },
    { type: "text.end", id: "ta", seq: s() },
    { type: "tool.start", toolCallId: "tA", name: "ggui_render", seq: s() },
    {
      type: "tool.done",
      toolCallId: "tA",
      content: [],
      outcome: "ok",
      uiData: { sessionId: GGUI_SLICE.sessionId, resourceUri: GGUI_RESOURCE_URI, action: "create" },
      _meta: { [GGUI_META_KEY]: GGUI_SLICE },
      seq: s(),
    },
    { type: "turn.done", turnId: "turn-a", outcome: { type: "success" }, seq: s() },
  ]);
  // Session turn B (live — no turn.done yet): one completed tool already in
  // the fold, a second still active (the fold materializes a tool-call at
  // `tool.done`; the ACTIVE call is the status line's job, not a row).
  push([
    { type: "turn.start", threadId: "thread-corpus", turnId: "turn-b", seq: s() },
    { type: "message.start", id: "msg-b", role: "assistant", turnId: "turn-b", threadId: "thread-corpus", seq: s() },
    { type: "tool.start", toolCallId: "tB", name: "load_booking", turnId: "turn-b", seq: s() },
    { type: "tool.args.assembled", toolCallId: "tB", input: { id: "second" }, turnId: "turn-b", seq: s() },
    {
      type: "tool.done",
      toolCallId: "tB",
      content: [{ type: "text", text: "loaded" }],
      outcome: "ok",
      turnId: "turn-b",
      seq: s(),
    },
  ]);
  return {
    result: reducer.result(),
    assistantText: "",
    status: "using-tool",
    statusElapsedMs: 0,
    activeTool: "check_calendar",
    error: null,
    prompts: [],
    // The flat transcript: one PERSISTED turn the fold never saw, then the
    // session turns (turn A's settled text row is present — the thread
    // viewer's liveTail/refetch carries it; turn B is in flight, no row).
    messages: [
      { role: "user", text: "plan my trip" },
      { role: "assistant", text: "Here are some options." },
      { role: "user", text: "book the second one" },
      { role: "assistant", text: "Booked the second option." },
      { role: "user", text: "now move it to Thursday" },
    ],
    historyCards: [
      // An OLD persisted card (pre-session) — must render.
      {
        seq: 1,
        at: "2026-08-15T00:00:00Z",
        cardSnapshot: {
          parts: [
            { type: "tool-result", toolCallId: "old1", content: [], uiData: { resourceUri: "ui://ggui/render/old/1" } },
          ],
        },
      },
      // Turn A's card, ALSO persisted by the read plane — the live fold's
      // mount owns this identity; the snapshot must dedupe away.
      {
        seq: 5,
        at: "2026-08-15T00:05:00Z",
        cardSnapshot: {
          parts: [
            { type: "tool-result", toolCallId: "tA", content: [], uiData: { resourceUri: GGUI_RESOURCE_URI } },
          ],
        },
      },
    ],
  };
}

/** 17. stalled-then-adopted — #192: calm identical, debug carries the marker. */
export function stalledThenAdopted(): { adopted: TranscriptInputs; streamed: TranscriptInputs } {
  const build = (): InvokeTurnEvent[] => {
    const s = seqSource();
    return [
      session,
      frame(boot(s), { status: "thinking" }),
      frame(textPart(s, "x", "Booked for Thursday afternoon."), { status: "responding", text: "Booked for Thursday afternoon." }),
      doneEvent,
    ];
  };
  return {
    adopted: driveTurn(build(), { userText: "move my booking", adopted: true }),
    streamed: driveTurn(build(), { userText: "move my booking" }),
  };
}

/**
 * 20. hitl-grant-modes (spec draft.2, silverprotocol#16) — a paused turn's
 * PERSISTED ask declares three asker-scoped accept variants. Driven through
 * the real Reducer: the declaration the card renders from is
 * `turn.done.outcome:"paused".asks[]`, exactly what a late-joining client
 * sees. Ids are deliberately arbitrary strings — display must key off
 * label/description, never id semantics.
 */
export function hitlGrantModes(): TranscriptInputs {
  const reducer = new Reducer();
  let seq = 0;
  const s = (): number => seq++;
  const events: AgEvent[] = [
    { type: "turn.start", threadId: "thread-hitl", turnId: "turn-h", seq: s() },
    { type: "message.start", id: "msg-h", role: "assistant", turnId: "turn-h", threadId: "thread-hitl", seq: s() },
    { type: "text.start", id: "th", seq: s() },
    { type: "text.delta", id: "th", delta: "I can remember this preference.", seq: s() },
    { type: "text.end", id: "th", seq: s() },
    {
      type: "turn.done",
      turnId: "turn-h",
      outcome: {
        type: "paused",
        asks: [
          {
            askId: "ask-remember-1",
            kind: "approval",
            message: "Remember your seating preference?",
            grantModes: [
              { id: "m.durable", label: "Always", description: "Keep it for every future chat" },
              { id: "m.scoped", label: "Just this chat" },
            ],
            requestState: "rs-bytes-1",
          },
        ],
      },
      seq: s(),
    },
  ];
  for (const ev of events) reducer.push(ev);
  return {
    result: reducer.result(),
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [], // the test composes these via hitlPromptsFromFold + the answer ledger
    messages: [{ role: "user", text: "book my usual seat" }],
  };
}

/**
 * 21. notice-rows (spec draft.2) — both arrival paths: a flat adapter
 * notice (the portal self-hosted mapping) and a fold-borne framework
 * notice (the claude informational promotion). Labeled, non-conversational,
 * never agent-voiced; provenance shows only under debug.
 */
export function noticeRows(): TranscriptInputs {
  const reducer = new Reducer();
  let seq = 0;
  const s = (): number => seq++;
  const events: AgEvent[] = [
    { type: "turn.start", threadId: "thread-n", turnId: "turn-n", seq: s() },
    {
      type: "message.start",
      id: "msg-n0",
      role: "notice",
      noticeSource: "framework",
      turnId: "turn-n",
      threadId: "thread-n",
      seq: s(),
    },
    // The notice's text lands while it is the sole open message, so block
    // routing is unambiguous; the assistant message opens after.
    { type: "text.start", id: "tn0", seq: s() },
    { type: "text.delta", id: "tn0", delta: "Model fell back to concise mode", seq: s() },
    { type: "text.end", id: "tn0", seq: s() },
    { type: "message.end", id: "msg-n0", turnId: "turn-n", seq: s() },
    { type: "message.start", id: "msg-n1", role: "assistant", turnId: "turn-n", threadId: "thread-n", seq: s() },
    { type: "text.start", id: "tn", seq: s() },
    { type: "text.delta", id: "tn", delta: "Done.", seq: s() },
    { type: "text.end", id: "tn", seq: s() },
    { type: "turn.done", turnId: "turn-n", outcome: { type: "success" }, seq: s() },
  ];
  for (const ev of events) reducer.push(ev);
  return {
    result: reducer.result(),
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [
      { role: "notice", text: "Session resumed on a new device", noticeSource: "adapter" },
      { role: "user", text: "hi" },
      { role: "assistant", text: "Done." },
    ],
  };
}
