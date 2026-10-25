/**
 * A stored message may leave its ANSWER out of `content` because the row's
 * `text` carries the same words: the answer block's `text` is the elided
 * marker (`{ "com.guuey/elided": { bytes } }`) in place of the string. The
 * readers read such an answer from the row's `text`, and only then: a message
 * with no answer at all reads as it always has, whatever the row's `text` says.
 *
 * Every word here is synthetic.
 */
import { describe, expect, it } from "vitest";
import type { AgMessage, JsonValue } from "@silverprotocol/core";
import {
  ELIDED_VALUE_KEY,
  agMessageToRow,
  isElidedAnswerBlock,
  reassembleFold,
  rowToAgMessage,
  storedTextParts,
} from "./fold-rows.js";
import { InMemoryThreadPersistence } from "./in-memory.js";
import type { ThreadMessageRow } from "./rows.js";
import { ThreadStore } from "./store.js";
import { classifyStoredRow } from "./stored-row.js";

const NARRATION = "Looking that up now.";
const ANSWER = "Here is the answer.";

/** The marker an elided string is stored as. */
const marker = (s: string): JsonValue => ({ [ELIDED_VALUE_KEY]: { bytes: Buffer.byteLength(JSON.stringify(s), "utf8") } });

/** A stored message: narration, then the answer (the shape a reply with narration stores). */
const message = (content: AgMessage["content"]): AgMessage => ({ id: "m1", role: "assistant", threadId: "t1", content });
const withNarration = message([
  { type: "text", text: NARRATION, phase: "interim" },
  { type: "text", text: ANSWER },
]);
const answerOnly = message([{ type: "text", text: ANSWER }]);

/**
 * `msg`'s stored content with its answer blocks elided: each non-narration
 * text block's `text` replaced by the marker, the way a writer that leaves out
 * the answer's second copy stores it.
 */
function elided(msg: AgMessage): JsonValue {
  const plain: JsonValue = JSON.parse(JSON.stringify(msg));
  if (plain === null || typeof plain !== "object" || Array.isArray(plain)) throw new Error("not a message");
  const blocks = plain["content"];
  if (!Array.isArray(blocks)) throw new Error("no content");
  return {
    ...plain,
    content: blocks.map((b) =>
      b !== null && typeof b === "object" && !Array.isArray(b) && b["type"] === "text" && b["phase"] !== "interim" && typeof b["text"] === "string"
        ? { ...b, text: marker(b["text"]) }
        : b,
    ),
  };
}

const ctx = { threadId: "t1", userId: "u1", seq: 1, at: "2026-10-01T00:00:01.000Z", clientMessageId: "c1#agent#0" };

describe("storedTextParts reads an elided answer from the row's text", () => {
  it("a stored message with every block in place reads exactly as without the row's text, even when the text says otherwise", () => {
    for (const msg of [withNarration, answerOnly]) {
      const row = agMessageToRow(msg, ctx);
      expect(storedTextParts(row.content, row.text)).toEqual(storedTextParts(row.content));
      expect(storedTextParts(row.content, "Some other words.")).toEqual(storedTextParts(row.content));
    }
  });

  it("an elided answer reads as its unelided twin: the same answer, narration and model bytes", () => {
    for (const msg of [withNarration, answerOnly]) {
      const row = agMessageToRow(msg, ctx);
      expect(storedTextParts(elided(msg), row.text)).toEqual(storedTextParts(row.content));
    }
    expect(storedTextParts(elided(withNarration), ANSWER)).toEqual({
      answer: ANSWER,
      narration: [NARRATION],
      all: `${NARRATION}\n\n${ANSWER}`,
    });
  });

  it("content stored as a JSON string (an AppSync writer) reads the same way", () => {
    expect(storedTextParts(JSON.stringify(elided(withNarration)), ANSWER)).toEqual(storedTextParts(elided(withNarration), ANSWER));
  });

  it("a MISSING answer is never an elided one: a narration-only message keeps its empty answer, whatever the row's text", () => {
    const narrationOnly = message([{ type: "text", text: NARRATION, phase: "interim" }]);
    expect(storedTextParts(narrationOnly, ANSWER)).toEqual({ answer: "", narration: [NARRATION], all: NARRATION });
    expect(storedTextParts(message([]), ANSWER)).toEqual({ answer: "", narration: [], all: "" });
    expect(storedTextParts(message([{ type: "text", text: "" }]), ANSWER)).toEqual({ answer: "", narration: [], all: "" });
  });

  it("an elided tool-call input is not an elided answer: the row's text is not read", () => {
    const call = message([{ type: "tool-call", toolCallId: "call_1", name: "render", input: marker("{}") }]);
    expect(storedTextParts(call, ANSWER)).toEqual({ answer: "", narration: [], all: "" });
  });

  it("an elided answer on a row with no text reads an empty answer, and the narration stays", () => {
    expect(storedTextParts(elided(withNarration), undefined)).toEqual({ answer: "", narration: [NARRATION], all: NARRATION });
  });

  it("the answer stands where the first answer block stood, once, around the narration", () => {
    const between = message([
      { type: "text", text: NARRATION, phase: "interim" },
      { type: "text", text: "First part." },
      { type: "text", text: "Second part." },
      { type: "text", text: "Wrapping up.", phase: "interim" },
    ]);
    const row = agMessageToRow(between, ctx);
    expect(row.text).toBe("First part.\n\nSecond part.");
    expect(storedTextParts(elided(between), row.text)).toEqual(storedTextParts(row.content));
    // An answer block left in place beside an elided one is not read twice: the row's text holds both.
    const half: JsonValue = {
      id: "m1",
      role: "assistant",
      threadId: "t1",
      content: [{ type: "text", text: "First part." }, { type: "text", text: marker("Second part.") }],
    };
    expect(storedTextParts(half, row.text)).toEqual({ answer: row.text, narration: [], all: row.text });
    // The same with the elided block first: the answer block after it is left out, never read twice.
    const halfFirst: JsonValue = {
      id: "m1",
      role: "assistant",
      threadId: "t1",
      content: [{ type: "text", text: marker("First part.") }, { type: "text", text: "Second part." }],
    };
    expect(storedTextParts(halfFirst, row.text)).toEqual({ answer: row.text, narration: [], all: row.text });
  });

  it("with narration between two answer blocks, the answer stands at the FIRST one, and the narration after it", () => {
    const text = "A\n\nB";
    const split = (first: JsonValue, second: JsonValue): JsonValue => ({
      id: "m1",
      role: "assistant",
      threadId: "t1",
      content: [{ type: "text", text: first }, { type: "text", text: "N", phase: "interim" }, { type: "text", text: second }],
    });
    // Both answer blocks elided: the answer goes to the first, not the last.
    expect(storedTextParts(split(marker("A"), marker("B")), text)).toEqual({ answer: text, narration: ["N"], all: "A\n\nB\n\nN" });
    // A plain answer block before an elided one is the first answer block, not the first ELIDED one.
    expect(storedTextParts(split("A", marker("B")), text)).toEqual({ answer: text, narration: ["N"], all: "A\n\nB\n\nN" });
  });

  it("a block this reader cannot read, stored before an elided answer, leaves the answer in its place", () => {
    // A newer writer's block type: core's lenient reader leaves it out.
    const stored = (answer: JsonValue): JsonValue => ({
      id: "m1",
      role: "assistant",
      threadId: "t1",
      content: [{ type: "future-block" }, { type: "text", text: answer }, { type: "text", text: NARRATION, phase: "interim" }],
    });
    expect(storedTextParts(stored(marker(ANSWER)), ANSWER)).toEqual(storedTextParts(stored(ANSWER)));
    expect(storedTextParts(stored(marker(ANSWER)), ANSWER)).toEqual({
      answer: ANSWER,
      narration: [NARRATION],
      all: `${ANSWER}\n\n${NARRATION}`,
    });
  });

  it("an answer block core cannot read is not where the answer goes: the answer stays where the elided block stood", () => {
    // `phase` must be a string, so core's reader leaves the first block out, as it does in the unelided twin.
    const stored = (answer: JsonValue): JsonValue => ({
      id: "m1",
      role: "assistant",
      threadId: "t1",
      content: [{ type: "text", text: "Unreadable.", phase: 5 }, { type: "text", text: answer }, { type: "text", text: NARRATION, phase: "interim" }],
    });
    expect(storedTextParts(stored(marker(ANSWER)), ANSWER)).toEqual(storedTextParts(stored(ANSWER)));
    expect(storedTextParts(stored(marker(ANSWER)), ANSWER)).toEqual({
      answer: ANSWER,
      narration: [NARRATION],
      all: `${ANSWER}\n\n${NARRATION}`,
    });
  });

  it("an empty answer block before the narration is not where the answer goes", () => {
    const stored = (answer: JsonValue): JsonValue => ({
      id: "m1",
      role: "assistant",
      threadId: "t1",
      content: [{ type: "text", text: "" }, { type: "text", text: NARRATION, phase: "interim" }, { type: "text", text: answer }],
    });
    expect(storedTextParts(stored(marker(ANSWER)), ANSWER)).toEqual(storedTextParts(stored(ANSWER)));
    expect(storedTextParts(stored(marker(ANSWER)), ANSWER)?.all).toBe(`${NARRATION}\n\n${ANSWER}`);
  });

  it("a narration block is never an elided answer: the row's text holds no narration", () => {
    expect(isElidedAnswerBlock({ type: "text", text: marker(NARRATION), phase: "interim" })).toBe(false);
    expect(isElidedAnswerBlock({ type: "text", text: marker(ANSWER) })).toBe(true);
    expect(isElidedAnswerBlock({ type: "text", text: marker(ANSWER), phase: "final" })).toBe(true);
    for (const notOne of [{ type: "text", text: ANSWER }, { type: "text", text: { other: 1 } }, { type: "reasoning", text: marker(ANSWER) }, null, ANSWER, [marker(ANSWER)]]) {
      expect(isElidedAnswerBlock(notOne)).toBe(false);
    }
  });
});

describe("classifyStoredRow reads an elided answer as the row's text", () => {
  const row = (content: ThreadMessageRow["content"], text?: string): ThreadMessageRow => ({
    ...ctx,
    kind: "text",
    authorRole: "agent",
    ...(text !== undefined ? { text } : {}),
    content,
  });

  it("an answer-only message with its answer elided is conversation", () => {
    expect(classifyStoredRow(row(elided(answerOnly), ANSWER))).toEqual({ kind: "conversation" });
  });

  it("a message with no answer blocks, or an empty one, stays blank", () => {
    expect(classifyStoredRow(row(message([]), ANSWER))).toEqual({ kind: "blank" });
    expect(classifyStoredRow(row(message([{ type: "text", text: "" }]), ANSWER))).toEqual({ kind: "blank" });
  });

  it("an elided answer on a row with no text reads as an empty answer: blank alone, conversation beside narration", () => {
    expect(classifyStoredRow(row(elided(answerOnly)))).toEqual({ kind: "blank" });
    expect(classifyStoredRow(row(elided(answerOnly), ""))).toEqual({ kind: "blank" });
    expect(classifyStoredRow(row(elided(withNarration)))).toEqual({ kind: "conversation" });
  });
});

describe("rowToAgMessage and reassembleFold read an elided answer from the row's text", () => {
  it("an elided row reads back as its unelided twin's message", () => {
    for (const msg of [withNarration, answerOnly]) {
      const plain = agMessageToRow(msg, ctx);
      expect(rowToAgMessage({ ...plain, content: elided(msg) })).toEqual(rowToAgMessage(plain));
      expect(rowToAgMessage(plain)).toEqual(msg);
    }
  });

  it("an elided answer block keeps its own fields: provider metadata and a field this reader does not know", () => {
    const stored = (answer: JsonValue): JsonValue => ({
      id: "m1",
      role: "assistant",
      threadId: "t1",
      content: [
        { type: "text", text: NARRATION, phase: "interim" },
        { type: "text", text: answer, providerMetadata: { anthropic: { citations: ["c1"] } }, "x-future": { kept: true } },
      ],
    });
    const plain: ThreadMessageRow = { ...ctx, kind: "text", authorRole: "agent", text: ANSWER, content: stored(ANSWER) };
    const read = rowToAgMessage({ ...plain, content: stored(marker(ANSWER)) });
    expect(read).toEqual(rowToAgMessage(plain));
    // The twin really carries both fields, so the equality above is about them.
    expect(read.content[1]).toEqual({
      type: "text",
      text: ANSWER,
      providerMetadata: { anthropic: { citations: ["c1"] } },
      "x-future": { kept: true },
    });
  });

  it("the reassembled fold of elided rows is the fold of their unelided twins", () => {
    const plainRows = [withNarration, answerOnly].map((msg, i) =>
      agMessageToRow({ ...msg, id: `m${i + 1}` }, { ...ctx, seq: i + 1, clientMessageId: `c${i + 1}` }),
    );
    const elidedRows = plainRows.map((r) => {
      const msg = rowToAgMessage(r);
      return { ...r, content: elided(msg) };
    });
    expect(reassembleFold(elidedRows, undefined)).toEqual(reassembleFold(plainRows, undefined));
    expect(reassembleFold(plainRows, undefined).messages.map((m) => m.content)).toEqual([withNarration.content, answerOnly.content]);
  });
});

describe("loadHistory replays an elided answer from the row's text", () => {
  it("each elided row replays the bytes its unelided twin replays; a row stored before any elision replays unchanged", async () => {
    const db = new InMemoryThreadPersistence();
    const twins = [withNarration, answerOnly];
    let seq = 0;
    for (const msg of twins) {
      const plain = agMessageToRow(msg, { ...ctx, seq: ++seq, clientMessageId: `c${seq}` });
      await db.putMessage(plain);
      await db.putMessage({ ...plain, seq: ++seq, clientMessageId: `c${seq}`, content: elided(msg) });
    }
    const history = await new ThreadStore(db).loadHistory("t1");
    const full = `${NARRATION}\n\n${ANSWER}`;
    expect(history.map((h) => h.text)).toEqual([full, full, ANSWER, ANSWER]);
  });
});
