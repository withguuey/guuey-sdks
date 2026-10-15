/**
 * guuey#2400 — a reloaded card keeps its place INSIDE its turn.
 *
 * The read plane stores a card row where it was drawn in the turn: a turn
 * drawn live as [text, text, card, text] is stored with the card's seq
 * between the second and the closing text. The flat (reloaded) surface
 * merges a turn's assistant rows into one slot, and a history card used to
 * anchor only on the next NEWER user row, so it always landed after the
 * whole turn — below the closing text it introduces. Live and reload drew
 * the same turn differently.
 *
 * Now a history card anchors on the first seq-bearing item newer than it,
 * an assistant text row or a user row, whichever comes first. Pins are
 * POSITIONAL, and the live fold and the reload of the same turn must agree.
 */
import { Reducer, type AgEvent } from "@silverprotocol/core";
import { describe, expect, it } from "vitest";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { DisplayItem, TranscriptInputs } from "./types.js";

const CARD_URI = "ui://cards/turn-card";
const CARD_UI = { uri: CARD_URI, mimeType: "text/html", text: "<div>card</div>" };

function base(): Omit<TranscriptInputs, "messages" | "result"> {
  return {
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    sendStates: {},
    aborted: false,
    adopted: false,
  };
}

/** The turn as it streams live: text, text, the card's tool, the closing text. */
function liveTurn(): TranscriptInputs {
  const reducer = new Reducer();
  let seq = 0;
  const s = (): number => seq++;
  const text = (id: string, body: string): AgEvent[] => [
    { type: "text.start", id, seq: s() },
    { type: "text.delta", id, delta: body, seq: s() },
    { type: "text.end", id, seq: s() },
  ];
  const events: AgEvent[] = [
    { type: "turn.start", threadId: "thread-2400", turnId: "turn-1", seq: s() },
    { type: "message.start", id: "msg-1", role: "assistant", turnId: "turn-1", threadId: "thread-2400", seq: s() },
    ...text("t1", "Looking that up."),
    ...text("t2", "Here is what I found."),
    { type: "tool.start", toolCallId: "toolu_card", name: "ggui_render", seq: s() },
    { type: "tool.done", toolCallId: "toolu_card", content: [], outcome: "ok", uiData: CARD_UI, seq: s() },
    ...text("t3", "Pick one from the card above."),
    { type: "turn.done", turnId: "turn-1", outcome: { type: "success" }, seq: s() },
  ];
  for (const ev of events) reducer.push(ev);
  return { ...base(), result: reducer.result(), messages: [{ role: "user", text: "find me a slot" }] };
}

/** The same turn reloaded: rows in stored seq order, the card between the texts. */
function reloadedTurn(): TranscriptInputs {
  return {
    ...base(),
    result: null,
    messages: [
      { role: "user", text: "find me a slot", seq: 1 },
      { role: "assistant", text: "Looking that up.", seq: 2 },
      { role: "assistant", text: "Here is what I found.", seq: 3 },
      { role: "assistant", text: "Pick one from the card above.", seq: 5 },
    ],
    historyCards: [
      {
        seq: 4,
        at: "2026-01-01T00:00:04Z",
        cardSnapshot: {
          parts: [{ type: "tool-result", toolCallId: "toolu_card", content: [], uiData: CARD_UI }],
        },
      },
    ],
  };
}

/** The reading order a visitor sees: user bubbles, text rows and cards. */
function face(items: DisplayItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === "user") out.push(`user:${item.text}`);
    if (item.kind === "text") out.push(`text:${item.text}`);
    if (item.kind === "view") out.push("card");
  }
  return out;
}

const EXPECTED = [
  "user:find me a slot",
  "text:Looking that up.",
  "text:Here is what I found.",
  "card",
  "text:Pick one from the card above.",
];

describe("guuey#2400 — a reloaded card keeps its place inside the turn", () => {
  it("live: the card is drawn before the closing text", () => {
    expect(face(planTranscript(liveTurn(), calmPolicy()).items)).toEqual(EXPECTED);
  });

  it("reload: a turn stored as [text, text, card, text] renders the card before the closing text", () => {
    expect(face(planTranscript(reloadedTurn(), calmPolicy()).items)).toEqual(EXPECTED);
  });

  it("live and reload of the same turn agree", () => {
    expect(face(planTranscript(reloadedTurn(), calmPolicy()).items)).toEqual(
      face(planTranscript(liveTurn(), calmPolicy()).items),
    );
  });

  it("an already-stored turn (card seq after the turn's text) still renders, card after the text", () => {
    const inputs = reloadedTurn();
    const keys = planTranscript(
      {
        ...inputs,
        messages: [
          { role: "user", text: "find me a slot", seq: 1 },
          { role: "assistant", text: "Looking that up.", seq: 2 },
          { role: "assistant", text: "Pick one from the card above.", seq: 3 },
          { role: "user", text: "the second", seq: 6 },
        ],
        historyCards: inputs.historyCards!.map((c) => ({ ...c, seq: 4 })),
      },
      calmPolicy(),
    ).items.map((i) => i.key);
    expect(keys.indexOf("card.4")).toBeGreaterThan(keys.indexOf("a0.t1"));
    expect(keys.indexOf("card.4")).toBeLessThan(keys.indexOf("u1"));
  });

  it("two cards inside one turn each keep their own place, ascending", () => {
    const inputs = reloadedTurn();
    const card = inputs.historyCards![0]!;
    const plan = planTranscript(
      {
        ...inputs,
        messages: [
          { role: "user", text: "find me a slot", seq: 1 },
          { role: "assistant", text: "first", seq: 2 },
          { role: "assistant", text: "second", seq: 4 },
          { role: "assistant", text: "third", seq: 6 },
        ],
        historyCards: [
          { ...card, seq: 3, cardSnapshot: { parts: [{ type: "tool-result", toolCallId: "c3", content: [], uiData: { ...CARD_UI, uri: "ui://cards/3" } }] } },
          { ...card, seq: 5, cardSnapshot: { parts: [{ type: "tool-result", toolCallId: "c5", content: [], uiData: { ...CARD_UI, uri: "ui://cards/5" } }] } },
        ],
      },
      calmPolicy(),
    );
    expect(plan.items.map((i) => i.key)).toEqual(["u0", "a0.t0", "card.3", "a0.t1", "card.5", "a0.t2"]);
  });
});
