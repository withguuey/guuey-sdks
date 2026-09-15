/**
 * guuey#1333 Test B — **a transcript may only ever GROW AT THE END.**
 *
 * QA's formulation, as a planner-level PROPERTY rather than a snapshot. Test A
 * (`plan.interleave.test.ts`) asserts the final order at first rest; it says
 * nothing about the path there. A fix can land every row in the right place
 * once everything has settled and still have MOVED a row that was already
 * painted — which is the second, distinct defect in QA's evidence: an answer
 * slid down past a question sent 34 seconds after that answer was on screen.
 *
 * The property: plan a conversation at successive resting points; the item
 * list at each step must be a PREFIX of the list at the next. Anything that
 * changes INSIDE the existing prefix is the defect, named by index with both
 * values. Two verdicts, neither able to close the other — QA's runs against
 * the served widget and catches what the planner cannot see; this one runs on
 * every fixture shape, forever.
 *
 * Identity here is the row's CONTENT (kind + visible text) — what a reader
 * watching the screen would see move. The item KEY is deliberately NOT part of
 * this property: key stability is a separate, separately-documented contract
 * (plan.ts's "append-only ordinals"), and it has its own residual violation —
 * a fold source's `a{slot}` ordinal shifts when the flat/fold seam moves. That
 * is a remount concern (a card iframe re-created), not a re-order one, it
 * PREDATES this row, and conflating the two would hide which of them a failure
 * means.
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { DisplayItem, TranscriptInputs, TranscriptMessage } from "./types.js";

/** One resting point in a conversation. */
interface Step {
  readonly label: string;
  readonly messages: readonly TranscriptMessage[];
  readonly result: AgReduceResult | null;
}

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

function planAt(step: Step): DisplayItem[] {
  const inputs: TranscriptInputs = {
    result: step.result,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [...step.messages],
  };
  return planTranscript(inputs, calmPolicy()).items;
}

/** A row's identity for the growth property: what a reader would notice moving. */
const identify = (item: DisplayItem): string => {
  const text = item.kind === "user" || item.kind === "text" ? item.text : "";
  return `${item.kind}${text ? `:${text}` : `#${item.key}`}`;
};

/**
 * Assert every step's rendering is a prefix of the next. Reports the FIRST
 * in-prefix divergence by index with both values, so a failure names the row
 * that moved rather than dumping two lists.
 */
function assertGrowsAtEnd(steps: readonly Step[]): void {
  for (let i = 0; i + 1 < steps.length; i++) {
    const before = planAt(steps[i]!).map(identify);
    const after = planAt(steps[i + 1]!).map(identify);
    expect(
      after.length,
      `"${steps[i + 1]!.label}" is SHORTER than "${steps[i]!.label}" — rows vanished`,
    ).toBeGreaterThanOrEqual(before.length);
    for (let k = 0; k < before.length; k++) {
      expect(
        after[k],
        `"${steps[i]!.label}" -> "${steps[i + 1]!.label}": row ${k} changed under the reader\n` +
          `  was: ${before[k]}\n  now: ${after[k]}`,
      ).toBe(before[k]);
    }
  }
}

const HELLO = "welcome card";
const R1 = "first answer";
const R2 = "second answer";

describe("guuey#1333 Test B — the transcript only grows at the end", () => {
  it("a plain live conversation", () => {
    assertGrowsAtEnd([
      {
        label: "turn 1 settled",
        messages: [{ role: "user", text: "hey", precedingTurnCount: 0 }],
        result: foldOfTurns([R1]),
      },
      {
        label: "turn 2 settled",
        messages: [
          { role: "user", text: "hey", precedingTurnCount: 0 },
          { role: "user", text: "and again", precedingTurnCount: 1 },
        ],
        result: foldOfTurns([R1, R2]),
      },
    ]);
  });

  it("a session that opens with a bound hello (the #1183 shape)", () => {
    assertGrowsAtEnd([
      { label: "hello painted, no user yet", messages: [], result: foldOfTurns([HELLO]) },
      {
        label: "user asks, turn settles",
        messages: [{ role: "user", text: "hey", precedingTurnCount: 1 }],
        result: foldOfTurns([HELLO, R1]),
      },
      {
        label: "second exchange settles",
        messages: [
          { role: "user", text: "hey", precedingTurnCount: 1 },
          { role: "user", text: "and again", precedingTurnCount: 2 },
        ],
        result: foldOfTurns([HELLO, R1, R2]),
      },
    ]);
  });

  it("a user sent while the previous turn is still open, then its answer lands", () => {
    // THE REGRESSION PIN for QA's second defect. Before guuey#1333 this exact
    // progression rendered `hey / and-again / R1` and then
    // `hey / R1 / and-again / R2` -- the answer JUMPED above a question that
    // was already on screen. Measured against the pre-fix planner (7c28f58d6),
    // not argued: `user#u0 | user#u1 | text#a1.t0` became
    // `user#u0 | text#a0.t0 | user#u1 | text#a1.t0`.
    assertGrowsAtEnd([
      {
        label: "sent, answer not yet in the fold",
        messages: [
          { role: "user", text: "hey", precedingTurnCount: 0 },
          { role: "user", text: "and again", precedingTurnCount: 1 },
        ],
        result: foldOfTurns([R1]),
      },
      {
        label: "answer lands",
        messages: [
          { role: "user", text: "hey", precedingTurnCount: 0 },
          { role: "user", text: "and again", precedingTurnCount: 1 },
        ],
        result: foldOfTurns([R1, R2]),
      },
    ]);
  });

  it("a reloaded session that then continues live", () => {
    // The rehydrated prefix must not re-order when a live turn appends.
    const rehydrated: TranscriptMessage[] = [
      { role: "assistant", text: HELLO, seq: 1 },
      { role: "user", text: "hey", seq: 2 },
      { role: "assistant", text: R1, seq: 3 },
    ];
    assertGrowsAtEnd([
      { label: "just reloaded", messages: rehydrated, result: null },
      {
        label: "one more exchange",
        messages: [...rehydrated, { role: "user", text: "and again", seq: 4 }],
        result: null,
      },
    ]);
  });

  it("an unstamped (older assembler) conversation still only grows", () => {
    assertGrowsAtEnd([
      { label: "turn 1", messages: [{ role: "user", text: "hey" }], result: foldOfTurns([R1]) },
      {
        label: "turn 2",
        messages: [
          { role: "user", text: "hey" },
          { role: "user", text: "and again" },
        ],
        result: foldOfTurns([R1, R2]),
      },
    ]);
  });
});
