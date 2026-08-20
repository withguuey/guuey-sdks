/**
 * guuey#306 — users pair with TURNS, never with assistant message SEGMENTS.
 *
 * The production shape (portal's live-instrumented 9-turn Trimly thread):
 * a pod fold emits several assistant messages per turn — thought/text/tool
 * interleave, ~6-8 segments for a generative-card turn. The old plan paired
 * `users[slot]` with per-SEGMENT sources by raw index, so from turn 2 on
 * every user bubble rendered clustered inside turn 1's segment run ("the
 * agent talking to itself"). These pins assert POSITION, not presence:
 * each user bubble renders after the previous turn's items and before its
 * own turn's.
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { TranscriptInputs } from "./types.js";

/** The shoot-thread shape: two turns, the first one multi-segment. */
const MULTI_SEGMENT_FOLD: AgReduceResult = {
  messages: [
    { id: "u1", role: "user", content: [{ type: "text", text: "want to make a reservation" }], turnId: "t1" },
    { id: "a1s1", role: "assistant", content: [{ type: "reasoning", text: "planning…" }], turnId: "t1" },
    { id: "a1s2", role: "assistant", content: [{ type: "text", text: "Let me check availability." }], turnId: "t1" },
    {
      id: "a1s3",
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "toolu_av", name: "ggui_render", input: {} }],
      turnId: "t1",
    },
    {
      id: "a1s3r",
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_av",
          content: [],
          uiData: {
            resourceUri: "ui://ggui/render/r1/wk",
            uri: "ui://ggui/render/r1/wk",
            mimeType: "text/html",
            text: "<p>weekly availability</p>",
          },
        },
      ],
      turnId: "t1",
    },
    { id: "a1s4", role: "assistant", content: [{ type: "text", text: "Here's the week." }], turnId: "t1" },
    { id: "u2", role: "user", content: [{ type: "text", text: "book tuesday 3pm" }], turnId: "t2" },
    { id: "a2s1", role: "assistant", content: [{ type: "text", text: "Booked for Tuesday." }], turnId: "t2" },
  ],
  artifacts: [],
  memory: [],
  turns: [
    { turnId: "t1", threadId: "th1", outcome: { type: "success" } },
    { turnId: "t2", threadId: "th1", outcome: { type: "success" } },
  ],
};

function inputsFor(fold: AgReduceResult, messages: TranscriptInputs["messages"]): TranscriptInputs {
  return {
    result: fold,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages,
    sendStates: {},
    aborted: false,
    adopted: false,
  };
}

/** Index of the first plan item whose key satisfies `test`; -1 when none. */
function firstIndex(keys: string[], test: (key: string) => boolean): number {
  return keys.findIndex(test);
}

describe("guuey#306 — turn-slot pairing (fold path)", () => {
  it("the second user bubble renders AFTER the whole first turn, before the second", () => {
    const plan = planTranscript(
      inputsFor(MULTI_SEGMENT_FOLD, [
        { role: "user", text: "want to make a reservation" },
        { role: "user", text: "book tuesday 3pm" },
      ]),
      calmPolicy(),
      {},
    );
    const keys = plan.items.map((i) => i.key);
    const u0 = firstIndex(keys, (k) => k === "u0");
    const u1 = firstIndex(keys, (k) => k === "u1");
    const firstTurnFirst = firstIndex(keys, (k) => k.startsWith("a0.") || k.startsWith("g.a0."));
    const lastTurnZeroItem = keys.reduce(
      (last, k, i) => (k.startsWith("a0.") || k === "view.toolu_av" || k === "tool.toolu_av" || k.startsWith("g.") ? i : last),
      -1,
    );
    const secondTurnFirst = firstIndex(keys, (k) => k.startsWith("a1."));

    expect(u0).toBeGreaterThanOrEqual(0);
    expect(u1).toBeGreaterThanOrEqual(0);
    expect(secondTurnFirst).toBeGreaterThanOrEqual(0);
    // u0 opens the conversation, before any assistant content.
    expect(u0).toBeLessThan(firstTurnFirst);
    // THE #306 PIN: u1 sits after every first-turn item and before the
    // second turn's content — never clustered inside turn 1's segment run.
    expect(u1).toBeGreaterThan(lastTurnZeroItem);
    expect(u1).toBeLessThan(secondTurnFirst);
  });

  it("segments of one turn form ONE slot — keys stay in the a0.* space", () => {
    const plan = planTranscript(
      inputsFor(MULTI_SEGMENT_FOLD, [
        { role: "user", text: "want to make a reservation" },
        { role: "user", text: "book tuesday 3pm" },
      ]),
      calmPolicy(),
      {},
    );
    const slotPrefixes = new Set(
      plan.items
        .map((i) => i.key)
        .filter((k) => /^a\d+\./.test(k))
        .map((k) => k.split(".")[0]),
    );
    // Two turns ⇒ exactly two assistant slots — not one per segment.
    expect([...slotPrefixes].sort()).toEqual(["a0", "a1"]);
  });
});

describe("guuey#306 — order-derived flat slots (no fold)", () => {
  it("double assistant rows do not drift later user bubbles", () => {
    // Portal's flat receipt shape: an empty/double assistant row per turn
    // used to shift every later user bubble by one slot.
    const plan = planTranscript(
      {
        result: null,
        assistantText: "",
        status: "ready",
        statusElapsedMs: 0,
        activeTool: null,
        error: null,
        prompts: [],
        messages: [
          { role: "user", text: "first" },
          { role: "assistant", text: "reply one, part a" },
          { role: "assistant", text: "reply one, part b" },
          { role: "user", text: "second" },
          { role: "assistant", text: "reply two" },
        ],
        sendStates: {},
        aborted: false,
        adopted: false,
      },
      calmPolicy(),
      {},
    );
    const keys = plan.items.map((i) => i.key);
    const u1 = keys.indexOf("u1");
    const a0Last = keys.reduce((last, k, i) => (k.startsWith("a0.") ? i : last), -1);
    const a1First = keys.findIndex((k) => k.startsWith("a1."));
    expect(u1).toBeGreaterThan(a0Last);
    expect(u1).toBeLessThan(a1First);
    // Both parts of reply one render, inside slot 0.
    const a0Texts = plan.items.filter((i) => i.key.startsWith("a0."));
    expect(a0Texts.length).toBeGreaterThanOrEqual(2);
  });
});
