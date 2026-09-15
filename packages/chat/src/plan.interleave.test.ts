/**
 * guuey#1333 — the transcript interleaves chronologically on a LIVE session.
 *
 * ## The bug, stated precisely
 *
 * In a fully live session the transcript is assembled from two DISJOINT
 * lists: `inputs.messages` holds the user rows, the fold holds the agent
 * turns. The wire sends no user message into the fold (three real captures:
 * 3/0, 1/0, 6/0 assistant/user), so the two lists share no member at all.
 * With nothing to interleave on, the planner paired them BY ARRAY INDEX —
 * which is not a lossy bridge that occasionally slips, it is a positional
 * GUESS. When the counts line up it looks ordered by coincidence; when they
 * do not, the lists concatenate: every user message, then every agent turn.
 *
 * Two ordinary things break the counts, and the founder hit both in one
 * session: an unprompted WELCOME CARD (an agent turn with no user row) and a
 * CARD CHIP CLICK (an action minted on the live channel and drained by
 * `ggui_consume` — agent-facing by design, so no user row is ever sent).
 *
 * The first `describe` replays his transcript literally. The second is the
 * N-1 fallback arm, named rather than implied: an older assembler across the
 * npm boundary stamps nothing, and the planner must keep its previous
 * behaviour exactly.
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { DisplayItem, TranscriptMessage } from "./types.js";

/** A fold of N agent turns, one per turnId — the live shape (no user rows). */
function foldOfTurns(texts: readonly string[]): AgReduceResult {
  return {
    messages: texts.map((text, i) => ({
      id: `m${i}`,
      role: "assistant" as const,
      turnId: `turn${i}`,
      content: [{ type: "text" as const, text }],
    })),
    artifacts: [],
    memory: [],
    turns: texts.map((_, i) => ({
      turnId: `turn${i}`,
      threadId: "thread1",
      outcome: { type: "success" as const },
    })),
  };
}

function plan(messages: readonly TranscriptMessage[], result: AgReduceResult): DisplayItem[] {
  return planTranscript(
    {
      result,
      assistantText: "",
      status: "ready",
      statusElapsedMs: 0,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [...messages],
    },
    calmPolicy(),
  ).items;
}

/** The rendered shape as a reader sees it: role per row, in order. */
const shape = (items: DisplayItem[]): string[] =>
  items.filter((i) => i.kind === "user" || i.kind === "text").map((i) => (i.kind === "user" ? "user" : "agent"));

const textOf = (items: DisplayItem[]): string[] =>
  items
    .filter((i) => i.kind === "user" || i.kind === "text")
    .map((i) => (i.kind === "user" ? i.text : i.text));

/**
 * The founder's session, verbatim (guuey#1333):
 *   (me) hey / (agent) welcome card / (me) [chip click] / (agent) text /
 *   (me) i build something cool / (agent) answer
 * Two user ROWS exist — the chip click sends none — against three agent turns.
 */
const WELCOME = "welcome card";
const CHIP_ANSWER = "where we invest";
const ANSWER = "that sounds cool";
const FOUNDER_FOLD = foldOfTurns([WELCOME, CHIP_ANSWER, ANSWER]);
const FOUNDER_USERS: TranscriptMessage[] = [
  // "hey" was sent before any agent turn had arrived.
  { role: "user", text: "hey", precedingTurnCount: 0 },
  // By the time this was sent, the welcome card AND the chip answer had
  // arrived — two turns, one of which never had a user row of its own.
  { role: "user", text: "i build something cool", precedingTurnCount: 2 },
];

describe("guuey#1333 — a live session interleaves chronologically", () => {
  it("renders the founder's transcript in the order it happened", () => {
    expect(textOf(plan(FOUNDER_USERS, FOUNDER_FOLD))).toEqual([
      "hey",
      WELCOME,
      CHIP_ANSWER,
      "i build something cool",
      ANSWER,
    ]);
  });

  it("never renders an answer under a question it does not answer", () => {
    // The face of the bug: role-grouped, every user then every agent.
    expect(shape(plan(FOUNDER_USERS, FOUNDER_FOLD))).not.toEqual([
      "user",
      "user",
      "agent",
      "agent",
      "agent",
    ]);
    expect(shape(plan(FOUNDER_USERS, FOUNDER_FOLD))).toEqual([
      "user",
      "agent",
      "agent",
      "user",
      "agent",
    ]);
  });

  it("an unprompted welcome card does not consume the first user's slot", () => {
    // One turn, one user, but the turn PRECEDED the user.
    const users: TranscriptMessage[] = [{ role: "user", text: "hey", precedingTurnCount: 1 }];
    expect(textOf(plan(users, foldOfTurns([WELCOME])))).toEqual([WELCOME, "hey"]);
  });

  it("a user still waiting on a reply closes the transcript", () => {
    const users: TranscriptMessage[] = [
      { role: "user", text: "first", precedingTurnCount: 0 },
      { role: "user", text: "second", precedingTurnCount: 1 },
    ];
    expect(textOf(plan(users, foldOfTurns([ANSWER])))).toEqual(["first", ANSWER, "second"]);
  });
});

describe("guuey#1333 — the N-1 fallback: an assembler that stamps nothing", () => {
  // NAMED, not implied by a fixture that happens to omit the field. The
  // cohort is lockstep, but an external host upgrades on its own schedule
  // and can run a NEW @guuey/chat against an OLD @guuey/agent-client. That
  // arm must keep the previous behaviour exactly -- it is what every host on
  // 0.23.x runs until they upgrade.
  const unstamped: TranscriptMessage[] = [
    { role: "user", text: "hey" },
    { role: "user", text: "i build something cool" },
  ];

  it("falls back to index pairing, unchanged", () => {
    expect(textOf(plan(unstamped, FOUNDER_FOLD))).toEqual([
      "hey",
      WELCOME,
      "i build something cool",
      CHIP_ANSWER,
      ANSWER,
    ]);
  });

  it("is chosen per-transcript, so a partially stamped list still merges", () => {
    // A stamped assembler that omits the field on one row (a rehydrated
    // prefix row, say) must not silently drop back to index pairing for the
    // whole transcript -- the unstamped row falls back to its own index.
    const mixed: TranscriptMessage[] = [
      { role: "user", text: "hey" },
      { role: "user", text: "i build something cool", precedingTurnCount: 2 },
    ];
    expect(textOf(plan(mixed, FOUNDER_FOLD))).toEqual([
      "hey",
      WELCOME,
      CHIP_ANSWER,
      "i build something cool",
      ANSWER,
    ]);
  });
});

describe("guuey#1333 — a REHYDRATED session containing a welcome card", () => {
  // The question main raised, and it is the fallback arm's blind spot: a
  // bound hello (#1183's bootstrap door) is a PLATFORM feature, so any app
  // carrying one is count-mismatched from its first exchange. That same
  // welcome card is in the HISTORY after a reload — and rehydrated rows carry
  // no `precedingTurnCount`, so the planner takes the index-pairing fallback.
  // If that fallback mis-pairs, the fix repairs the path he reported and
  // leaves the path he hits next, while testing green.
  //
  // The rehydrated shape: `messages` carries BOTH roles (the read plane
  // replays the whole conversation) and there is no live fold.
  const rehydrated: TranscriptMessage[] = [
    { role: "assistant", text: WELCOME, seq: 1 },
    { role: "user", text: "hey", seq: 2 },
    { role: "assistant", text: ANSWER, seq: 3 },
  ];

  function planFlat(messages: readonly TranscriptMessage[]): DisplayItem[] {
    return planTranscript(
      {
        result: null,
        assistantText: "",
        status: "ready",
        statusElapsedMs: 0,
        activeTool: null,
        error: null,
        prompts: [],
        messages: [...messages],
      },
      calmPolicy(),
    ).items;
  }

  it("renders the reloaded transcript in the order it happened", () => {
    expect(textOf(planFlat(rehydrated))).toEqual([WELCOME, "hey", ANSWER]);
  });
});
