/**
 * guuey#2557: on a thread reopened from history, the seam between the flat
 * history prefix and the live fold (guuey#982) counted fold SOURCES as user
 * turns. Two shapes broke it:
 *
 *  (a) one user message whose run emits TWO fold turns (a second turnId with
 *      no user row before it, which `foldAssistantSources` splits on). The
 *      seam took both as user turns and sliced the last history answer off
 *      for as long as the fold held them, `ready` included.
 *  (b) one render between `turn.done` and `ready`: the turn's source is no
 *      longer live but the status is still in flight, so the "in-flight turn
 *      before its first frame" +1 fired on top of the source already counted.
 *
 * The rows here are the shapes `useAgentInvoke` hands `useTranscript`: the
 * read plane's rows carry `seq`; `send()` appends the stamped user row and an
 * assistant row it mirrors the streamed text into; the fold holds only agent
 * turns (no user rows on the live wire).
 *
 * The live-session shapes at the bottom pin what this fix must NOT move.
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { DisplayItem, TranscriptInputs, TranscriptMessage } from "./types.js";

/** Three settled turns read back from the read plane. */
const HISTORY: TranscriptMessage[] = [
  { role: "user", text: "Q1", seq: 1 },
  { role: "assistant", text: "A1", seq: 2 },
  { role: "user", text: "Q2", seq: 3 },
  { role: "assistant", text: "A2", seq: 4 },
  { role: "user", text: "Q3", seq: 5 },
  { role: "assistant", text: "A3", seq: 6 },
];

/** A fold turn: its id, the assistant segments it emitted, and whether `turn.done` landed. */
interface FoldTurn {
  id: string;
  texts: string[];
  done: boolean;
}

function fold(turns: FoldTurn[]): AgReduceResult {
  return {
    messages: turns.flatMap((t) =>
      t.texts.map((text, i) => ({
        id: `${t.id}-m${i}`,
        role: "assistant" as const,
        turnId: t.id,
        content: [{ type: "text" as const, text }],
      })),
    ),
    artifacts: [],
    memory: [],
    turns: turns.map((t) =>
      t.done ? { turnId: t.id, threadId: "th", outcome: { type: "success" as const } } : { turnId: t.id, threadId: "th" },
    ),
  };
}

/** `send()`'s optimistic pair: the stamped user row, then the assistant row it streams into. */
function sent(text: string, precedingTurnCount: number, cid: string, streamed = ""): TranscriptMessage[] {
  return [
    { role: "user", text, clientMessageId: cid, precedingTurnCount },
    { role: "assistant", text: streamed },
  ];
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

/** The conversation as it reads: every user bubble and agent text, in order. */
const rows = (items: DisplayItem[]): string[] =>
  items.flatMap((i) => (i.kind === "user" ? [`u:${i.text}`] : i.kind === "text" ? [i.text] : []));

const PAST = ["u:Q1", "A1", "u:Q2", "A2", "u:Q3", "A3"];

describe("guuey#2557 (a): one message, two fold turns, on a reopened thread", () => {
  const messages = [...HISTORY, ...sent("NEW", 0, "c1", "first part")];

  it("the first fold turn, still open: every history turn stays", () => {
    const result = fold([{ id: "t0", texts: ["first part"], done: false }]);
    expect(rows(plan(messages, result, "responding", "first part"))).toEqual([...PAST, "u:NEW", "first part"]);
  });

  it("the second fold turn opens with no user row before it: A3 stays", () => {
    const result = fold([
      { id: "t0", texts: ["first part"], done: true },
      { id: "t1", texts: ["second part"], done: false },
    ]);
    expect(rows(plan(messages, result, "responding", "second part"))).toEqual([
      ...PAST,
      "u:NEW",
      "first part",
      "second part",
    ]);
  });

  it("both fold turns done, status still responding: the order holds", () => {
    const result = fold([
      { id: "t0", texts: ["first part"], done: true },
      { id: "t1", texts: ["second part"], done: true },
    ]);
    expect(rows(plan(messages, result, "responding", "second part"))).toEqual([
      ...PAST,
      "u:NEW",
      "first part",
      "second part",
    ]);
  });

  it("at ready, the plan still holds all three history turns", () => {
    const result = fold([
      { id: "t0", texts: ["first part"], done: true },
      { id: "t1", texts: ["second part"], done: true },
    ]);
    expect(rows(plan(messages, result, "ready"))).toEqual([...PAST, "u:NEW", "first part", "second part"]);
  });

  it("a later send after the two-turn run lands under its own question", () => {
    const later = [...messages, ...sent("NEXT", 2, "c2")];
    const result = fold([
      { id: "t0", texts: ["first part"], done: true },
      { id: "t1", texts: ["second part"], done: true },
      { id: "t2", texts: ["next answer"], done: false },
    ]);
    expect(rows(plan(later, result, "responding", "next answer"))).toEqual([
      ...PAST,
      "u:NEW",
      "first part",
      "second part",
      "u:NEXT",
      "next answer",
    ]);
  });
});

describe("guuey#2557 (b): between turn.done and ready, on a reopened thread", () => {
  const messages = [...HISTORY, ...sent("NEW", 0, "c1", "the answer")];

  it("turn open, streaming: history kept", () => {
    const result = fold([{ id: "t0", texts: ["the answer"], done: false }]);
    expect(rows(plan(messages, result, "responding", "the answer"))).toEqual([...PAST, "u:NEW", "the answer"]);
  });

  it("turn.done landed, status still responding: A3 is not dropped", () => {
    const result = fold([{ id: "t0", texts: ["the answer"], done: true }]);
    expect(rows(plan(messages, result, "responding", "the answer"))).toEqual([...PAST, "u:NEW", "the answer"]);
  });

  it("ready: history kept", () => {
    const result = fold([{ id: "t0", texts: ["the answer"], done: true }]);
    expect(rows(plan(messages, result, "ready"))).toEqual([...PAST, "u:NEW", "the answer"]);
  });
});

describe("guuey#2557: live-session shapes stay as they were", () => {
  it("a fresh thread's first send, before and after its frames", () => {
    const messages = sent("hi", 0, "c1", "hello");
    expect(rows(plan(sent("hi", 0, "c1"), null, "connecting"))).toEqual(["u:hi"]);
    expect(rows(plan(messages, fold([{ id: "t0", texts: ["hello"], done: false }]), "responding", "hello"))).toEqual([
      "u:hi",
      "hello",
    ]);
    expect(rows(plan(messages, fold([{ id: "t0", texts: ["hello"], done: true }]), "responding", "hello"))).toEqual([
      "u:hi",
      "hello",
    ]);
    expect(rows(plan(messages, fold([{ id: "t0", texts: ["hello"], done: true }]), "ready"))).toEqual(["u:hi", "hello"]);
  });

  it("a second send before its first frame, while streaming, and after turn.done", () => {
    const first = sent("one", 0, "c1", "answer one");
    const turn0 = { id: "t0", texts: ["answer one"], done: true };
    expect(rows(plan([...first, ...sent("two", 1, "c2")], fold([turn0]), "connecting"))).toEqual([
      "u:one",
      "answer one",
      "u:two",
    ]);
    const messages = [...first, ...sent("two", 1, "c2", "answer two")];
    expect(
      rows(plan(messages, fold([turn0, { id: "t1", texts: ["answer two"], done: false }]), "responding", "answer two")),
    ).toEqual(["u:one", "answer one", "u:two", "answer two"]);
    expect(
      rows(plan(messages, fold([turn0, { id: "t1", texts: ["answer two"], done: true }]), "responding", "answer two")),
    ).toEqual(["u:one", "answer one", "u:two", "answer two"]);
    expect(rows(plan(messages, fold([turn0, { id: "t1", texts: ["answer two"], done: true }]), "ready"))).toEqual([
      "u:one",
      "answer one",
      "u:two",
      "answer two",
    ]);
  });

  it("guuey#1333's welcome card, then two sends", () => {
    const messages = [...sent("one", 1, "c1", "answer one"), ...sent("two", 2, "c2", "answer two")];
    const result = fold([
      { id: "w", texts: ["welcome"], done: true },
      { id: "t1", texts: ["answer one"], done: true },
      { id: "t2", texts: ["answer two"], done: false },
    ]);
    expect(rows(plan(messages, result, "responding", "answer two"))).toEqual([
      "welcome",
      "u:one",
      "answer one",
      "u:two",
      "answer two",
    ]);
  });

  it("a live session where one message yields two fold turns", () => {
    const messages = [...sent("one", 0, "c1", "part b"), ...sent("two", 2, "c2", "answer two")];
    const result = fold([
      { id: "t0", texts: ["part a"], done: true },
      { id: "t1", texts: ["part b"], done: true },
      { id: "t2", texts: ["answer two"], done: true },
    ]);
    expect(rows(plan(messages, result, "ready"))).toEqual(["u:one", "part a", "part b", "u:two", "answer two"]);
  });

  it("unstamped rows (an older assembler) keep the previous seam on a reopened thread", () => {
    const messages: TranscriptMessage[] = [
      ...HISTORY,
      { role: "user", text: "NEW", clientMessageId: "c1" },
      { role: "assistant", text: "the answer" },
    ];
    expect(rows(plan(messages, fold([{ id: "t0", texts: ["the answer"], done: false }]), "responding", "the answer"))).toEqual([
      ...PAST,
      "u:NEW",
      "the answer",
    ]);
    expect(rows(plan(messages, fold([{ id: "t0", texts: ["the answer"], done: true }]), "ready"))).toEqual([
      ...PAST,
      "u:NEW",
      "the answer",
    ]);
  });

  it("history adopted mid-session, then a new send: the fold's turns are not drawn twice", () => {
    // The stall probe adopted the read plane's copy of two live turns (no
    // stamps), and the fold still holds both; the next send stamps 2.
    const messages = [
      { role: "user" as const, text: "Q1", seq: 1 },
      { role: "assistant" as const, text: "A1", seq: 2 },
      { role: "user" as const, text: "Q2", seq: 3 },
      { role: "assistant" as const, text: "A2", seq: 4 },
      ...sent("Q3", 2, "c3"),
    ];
    const settled = [
      { id: "t0", texts: ["A1"], done: true },
      { id: "t1", texts: ["A2"], done: true },
    ];
    expect(rows(plan(messages, fold(settled), "connecting"))).toEqual(["u:Q1", "A1", "u:Q2", "A2", "u:Q3"]);
    expect(
      rows(plan(messages, fold([...settled, { id: "t2", texts: ["A3"], done: true }]), "responding", "A3")),
    ).toEqual(["u:Q1", "A1", "u:Q2", "A2", "u:Q3", "A3"]);
  });
});
