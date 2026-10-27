/**
 * guuey#2676: on a thread reopened from history, the next send's turn drew
 * out of place twice.
 *
 *  1. Before the turn's first frame there is no fold, yet the planner
 *     honoured the sent row's `precedingTurnCount` stamp (0, from `send()`
 *     with no reducer yet) against a fold seam of 0, so the new question
 *     sorted above the last past answer: `Q1 A1 Q2 NEW A2`. With no fold, the
 *     flat list's own order is already right for every row.
 *  2. Between `turn.done` and `ready`, the turn's source is no longer live but
 *     the status is still in flight, so the seam's in-flight +1 fired on top
 *     of the source already counted and dropped A2: `Q1 A1 Q2 NEW NEWA`.
 *
 * The table from the issue, every moment, plus the live-session shapes the
 * fix must leave alone.
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { DisplayItem, TranscriptInputs, TranscriptMessage } from "./types.js";

const PAST: TranscriptMessage[] = [
  { role: "user", text: "Q1", seq: 1 },
  { role: "assistant", text: "A1", seq: 2 },
  { role: "user", text: "Q2", seq: 3 },
  { role: "assistant", text: "A2", seq: 4 },
];

/** What `useAgentInvoke`'s `send()` appends on a thread loaded from history: no reducer yet, so the stamp is 0. */
const SENT: TranscriptMessage = { role: "user", text: "NEW", clientMessageId: "c1", precedingTurnCount: 0 };

function fold(text: string, done: boolean): AgReduceResult {
  return {
    messages: [{ id: "m0", role: "assistant", turnId: "t0", content: [{ type: "text", text }] }],
    artifacts: [],
    memory: [],
    turns: [done ? { turnId: "t0", threadId: "th", outcome: { type: "success" } } : { turnId: "t0", threadId: "th" }],
  };
}

function plan(
  messages: TranscriptMessage[],
  result: AgReduceResult | null,
  status: TranscriptInputs["status"],
  assistantText = "",
): DisplayItem[] {
  return planTranscript(
    { result, assistantText, status, statusElapsedMs: 0, activeTool: null, error: null, prompts: [], messages },
    calmPolicy(),
  ).items;
}

const rows = (items: DisplayItem[]): string[] =>
  items.flatMap((i) => (i.kind === "user" ? [`u:${i.text}`] : i.kind === "text" ? [i.text] : []));

describe("guuey#2676: a reopened thread's next send keeps its place at every moment", () => {
  it("sent, no frame yet: Q1 A1 Q2 A2 NEW", () => {
    expect(rows(plan([...PAST, SENT, { role: "assistant", text: "" }], null, "connecting"))).toEqual([
      "u:Q1",
      "A1",
      "u:Q2",
      "A2",
      "u:NEW",
    ]);
  });

  it("turn open, streaming: Q1 A1 Q2 A2 NEW NEWA", () => {
    const messages = [...PAST, SENT, { role: "assistant" as const, text: "NEWA" }];
    expect(rows(plan(messages, fold("NEWA", false), "responding", "NEWA"))).toEqual([
      "u:Q1",
      "A1",
      "u:Q2",
      "A2",
      "u:NEW",
      "NEWA",
    ]);
  });

  it("turn.done, status still responding: A2 stays", () => {
    const messages = [...PAST, SENT, { role: "assistant" as const, text: "NEWA" }];
    expect(rows(plan(messages, fold("NEWA", true), "responding", "NEWA"))).toEqual([
      "u:Q1",
      "A1",
      "u:Q2",
      "A2",
      "u:NEW",
      "NEWA",
    ]);
  });

  it("ready: Q1 A1 Q2 A2 NEW NEWA", () => {
    const messages = [...PAST, SENT, { role: "assistant" as const, text: "NEWA" }];
    expect(rows(plan(messages, fold("NEWA", true), "ready"))).toEqual(["u:Q1", "A1", "u:Q2", "A2", "u:NEW", "NEWA"]);
  });

  it("a stamped row with no fold and no streamed text yet keeps its key and its place", () => {
    const items = plan([...PAST, SENT], null, "thinking");
    expect(rows(items)).toEqual(["u:Q1", "A1", "u:Q2", "A2", "u:NEW"]);
    expect(items.filter((i) => i.kind === "user").map((i) => i.key)).toEqual(["u0", "u1", "u2"]);
  });
});

describe("guuey#2676: live-session shapes stay as they were", () => {
  it("a fresh thread's first send, before its first frame", () => {
    expect(rows(plan([{ ...SENT, text: "hi" }, { role: "assistant", text: "" }], null, "connecting"))).toEqual(["u:hi"]);
  });

  it("a second send before its first frame, while streaming, and after turn.done", () => {
    const one: TranscriptMessage[] = [
      { role: "user", text: "one", clientMessageId: "c1", precedingTurnCount: 0 },
      { role: "assistant", text: "answer one" },
    ];
    const two = (streamed: string): TranscriptMessage[] => [
      { role: "user", text: "two", clientMessageId: "c2", precedingTurnCount: 1 },
      { role: "assistant", text: streamed },
    ];
    const settled = { id: "t0-m0", role: "assistant" as const, turnId: "t0", content: [{ type: "text" as const, text: "answer one" }] };
    const result = (second: "none" | "open" | "done"): AgReduceResult => ({
      messages:
        second === "none"
          ? [settled]
          : [settled, { id: "t1-m0", role: "assistant", turnId: "t1", content: [{ type: "text", text: "answer two" }] }],
      artifacts: [],
      memory: [],
      turns: [
        { turnId: "t0", threadId: "th", outcome: { type: "success" } },
        ...(second === "none"
          ? []
          : [second === "done" ? { turnId: "t1", threadId: "th", outcome: { type: "success" as const } } : { turnId: "t1", threadId: "th" }]),
      ],
    });
    expect(rows(plan([...one, ...two("")], result("none"), "connecting"))).toEqual(["u:one", "answer one", "u:two"]);
    expect(rows(plan([...one, ...two("answer two")], result("open"), "responding", "answer two"))).toEqual([
      "u:one",
      "answer one",
      "u:two",
      "answer two",
    ]);
    expect(rows(plan([...one, ...two("answer two")], result("done"), "responding", "answer two"))).toEqual([
      "u:one",
      "answer one",
      "u:two",
      "answer two",
    ]);
  });

  it("a reload with no fold plans the flat rows in their own order", () => {
    expect(rows(plan(PAST, null, "ready"))).toEqual(["u:Q1", "A1", "u:Q2", "A2"]);
  });
});
