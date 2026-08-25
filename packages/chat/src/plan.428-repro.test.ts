/**
 * guuey#428 pins — a resumed render-bearing turn keeps its user bubble
 * across every card geometry the release store actually exhibits (rows
 * pulled live during the hunt). The plan was EXONERATED by these — the
 * live drop turned out to be the read plane's GSI-eventual-consistency
 * window (see publicApi handler.ts, the #428 base-table read) — but the
 * geometries stay pinned so the plan can never regress into the same face.
 */
import { describe, expect, it } from "vitest";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { TranscriptInputs, TranscriptPlan } from "./types.js";

const CARD = (seq: number) => ({
  seq,
  at: `2026-08-25T03:0${seq % 10}:00Z`,
  cardSnapshot: {
    artifactId: `a${seq}`,
    parts: [
      {
        type: "tool-result",
        toolCallId: `toolu_${seq}`,
        content: [],
        uiData: { resourceUri: `ui://slots/${seq}`, uri: `ui://slots/${seq}`, mimeType: "text/html", text: "<p>slots</p>" },
      },
    ],
  },
});

function inputs(messages: TranscriptInputs["messages"], cards: Array<ReturnType<typeof CARD>>): TranscriptInputs {
  return {
    result: null, assistantText: "", status: "ready", statusElapsedMs: 0,
    activeTool: null, error: null, prompts: [], messages, historyCards: cards,
    sendStates: {}, aborted: false, adopted: false,
  };
}

const userTexts = (plan: TranscriptPlan): string[] =>
  plan.items.flatMap((i) => (i.kind === "user" ? [i.text] : []));

describe("guuey#428 — resumed render-bearing turn keeps its user bubble", () => {
  it("card AFTER the trailing text (real release row shape: text seq 8, card seq 9)", () => {
    const plan = planTranscript(inputs(
      [
        { role: "user", text: "want to make a reservation", seq: 1 },
        { role: "assistant", text: "Sure — when?", seq: 2 },
        { role: "user", text: "show me Thursday's open slots", seq: 3 },
        { role: "assistant", text: "Here's the open slots 🎉", seq: 8 },
      ],
      [CARD(9)],
    ), calmPolicy({ view: { timeoutMs: 8000, presentation: 'chips' } }), {});
    expect(userTexts(plan)).toEqual([
      "want to make a reservation",
      "show me Thursday's open slots",
    ]);
  });

  it("card BETWEEN u2 and the trailing text (stream order: card lands before the final text)", () => {
    const plan = planTranscript(inputs(
      [
        { role: "user", text: "want to make a reservation", seq: 1 },
        { role: "assistant", text: "Sure — when?", seq: 2 },
        { role: "user", text: "show me Thursday's open slots", seq: 3 },
        { role: "assistant", text: "Here's the open slots 🎉", seq: 8 },
      ],
      [CARD(5)],
    ), calmPolicy({ view: { timeoutMs: 8000, presentation: 'chips' } }), {});
    expect(userTexts(plan)).toEqual([
      "want to make a reservation",
      "show me Thursday's open slots",
    ]);
  });

  it("turn-1 card seq below u2 (the splice-before-u2 geometry)", () => {
    const plan = planTranscript(inputs(
      [
        { role: "user", text: "menu please", seq: 1 },
        { role: "assistant", text: "here", seq: 4 },
        { role: "user", text: "book thursday", seq: 5 },
        { role: "assistant", text: "done", seq: 6 },
      ],
      [CARD(3)],
    ), calmPolicy({ view: { timeoutMs: 8000, presentation: 'chips' } }), {});
    expect(userTexts(plan)).toEqual(["menu please", "book thursday"]);
  });
});

  it("THE REAL SHAPE: trailing unanswered user turn behind a card (rows 1..10 verbatim)", () => {
    const plan = planTranscript(inputs(
      [
        { role: "user", text: "want to make a reservation", seq: 1 },
        { role: "assistant", text: "Here's our menu at Mill Street", seq: 6 },
        { role: "assistant", text: "Take a look above and pick a service", seq: 8 },
        { role: "user", text: "show me Thursday's open slots", seq: 10 },
      ],
      [CARD(9)],
    ), calmPolicy({ view: { timeoutMs: 8000, presentation: 'chips' } }), {});
    expect(userTexts(plan)).toEqual([
      "want to make a reservation",
      "show me Thursday's open slots",
    ]);
  });
