/**
 * Turn slotting across a turnId VOCABULARY change: a live session whose fold
 * spans a pod roll.
 *
 * Older runtimes stamped ONE turnId for a whole session (`turn_<session>`).
 * Current runtimes stamp one per turn. A widget session that outlives a
 * rolling release keeps its reducer, so its fold can hold turns under the
 * shared id followed by turns under per-turn ids. The planner reads turnId in
 * exactly one place, `foldAssistantSources`: a CHANGE of id between assistant
 * segments opens a new slot, and `result.turns` records without an outcome
 * mark what is live.
 *
 * What this pins, on the only shape where both vocabularies meet the planner:
 *  - the segments of the shared-id turn stay ONE slot, in order;
 *  - the first per-turn id after it opens its own slot, and so does each one
 *    after that, with no user row between them in the fold;
 *  - the users' `precedingTurnCount` stamps (which count `result.turns`)
 *    land each question above its own answer;
 *  - mid-flight, only the open per-turn turn is live; the closed shared-id
 *    turn stays settled.
 *
 * Out of scope, stated rather than implied: two turns BOTH under the shared id
 * with no user row between them cannot be told apart in a live fold, because
 * the old id carries no boundary and the reducer keeps one record for it. That
 * needs a runtime still emitting the shared id, and the per-turn id makes it
 * unreachable for new turns. Flat history rows never enter this path: they
 * carry no turnId and group by conversational order.
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { DisplayItem, TranscriptInputs, TranscriptMessage } from "./types.js";

const SHARED = "turn_sess-9f2c";
const text = (t: string) => [{ type: "text" as const, text: t }];

function rolledFold(openLast: boolean): AgReduceResult {
  return {
    messages: [
      // The old runtime: one turn, two assistant segments around a tool result, all under the shared id.
      { id: "m1", role: "assistant", turnId: SHARED, content: text("old answer, part one") },
      { id: "m2", role: "tool", turnId: SHARED, content: [] },
      { id: "m3", role: "assistant", turnId: SHARED, content: text("old answer, part two") },
      // The pod rolled: every turn from here has its own id.
      { id: "m4", role: "assistant", turnId: "turn-7a01", content: text("new answer two") },
      { id: "m5", role: "assistant", turnId: "turn-7a02", content: text("new answer three") },
    ],
    artifacts: [],
    memory: [],
    turns: [
      { turnId: SHARED, threadId: "t1", outcome: { type: "success" } },
      { turnId: "turn-7a01", threadId: "t1", outcome: { type: "success" } },
      openLast ? { turnId: "turn-7a02", threadId: "t1" } : { turnId: "turn-7a02", threadId: "t1", outcome: { type: "success" } },
    ],
  };
}

const USERS: TranscriptMessage[] = [
  { role: "user", text: "first question", precedingTurnCount: 0 },
  { role: "user", text: "second question", precedingTurnCount: 1 },
  { role: "user", text: "third question", precedingTurnCount: 2 },
];

function plan(result: AgReduceResult, status: TranscriptInputs["status"]): DisplayItem[] {
  return planTranscript(
    { result, assistantText: "", status, statusElapsedMs: 0, activeTool: null, error: null, prompts: [], messages: [...USERS] },
    calmPolicy(),
  ).items;
}

const rows = (items: DisplayItem[]): string[] =>
  items.filter((i) => i.kind === "user" || i.kind === "text").map((i) => (i.kind === "user" ? `user: ${i.text}` : `agent: ${i.text}`));

describe("turn slotting across a pod roll (shared session turnId, then per-turn ids)", () => {
  it("the shared-id turn stays one slot, each per-turn id opens its own, and every question sits above its answer", () => {
    expect(rows(plan(rolledFold(false), "ready"))).toEqual([
      "user: first question",
      "agent: old answer, part one",
      "agent: old answer, part two",
      "user: second question",
      "agent: new answer two",
      "user: third question",
      "agent: new answer three",
    ]);
  });

  it("mid-flight, only the open per-turn turn is live; the closed shared-id turn and the settled one are not", () => {
    const items = plan(rolledFold(true), "responding");
    expect(rows(items)).toEqual([
      "user: first question",
      "agent: old answer, part one",
      "agent: old answer, part two",
      "user: second question",
      "agent: new answer two",
      "user: third question",
      "agent: new answer three",
    ]);
    const live = items.flatMap((i) => (i.kind === "text" && i.streaming ? [i.text] : []));
    expect(live).toEqual(["new answer three"]);
  });
});
