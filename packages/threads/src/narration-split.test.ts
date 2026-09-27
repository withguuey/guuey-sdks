/**
 * Interim narration splits out of a stored message's ANSWER text, and the
 * model's replayed history stays the same bytes.
 *
 * A text block marked `phase: "interim"` (an OpenAI `commentary` message) is
 * narration, not the answer. The row's `text` (what a reloaded thread, a
 * preview and a hook read) is the answer only. The model's view (`loadHistory`)
 * is EVERY text block, rebuilt from the stored message, exactly the bytes the
 * writer used to put in `text`, for rows written before the split and after it.
 *
 * Both fixtures are REAL stored-row shapes:
 * - `thread-message-row.agjson-draft3.json`: a row written under core 0.6.7,
 *   with no phases (the legacy shape).
 * - `thread-message-rows.openai-commentary.json`: a public live OpenAI
 *   commentary capture folded through core 0.10.0's Reducer, stored as the
 *   writer stored it before the split (its `$source` names the capture).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readStoredAgMessage, type AgMessage, type AgReduceResult, type AgTurnRecord } from "@silverprotocol/core";
import { agMessageToRow, messageFullText, messageNarration, messageText, storedTextParts } from "./fold-rows.js";
import { InMemoryThreadPersistence } from "./in-memory.js";
import type { ThreadMessageRow } from "./rows.js";
import { ThreadStore } from "./store.js";

const isObj = (v: unknown): v is { [k: string]: unknown } => typeof v === "object" && v !== null && !Array.isArray(v);

/** One fixture row, narrowed field by field; its content read through core's stored-record reader. */
function fixtureRow(v: unknown): ThreadMessageRow & { content: AgMessage } {
  if (!isObj(v)) throw new Error("fixture: row is not an object");
  const { threadId, seq, userId, clientMessageId, at, text, content, aiContext } = v;
  if (typeof threadId !== "string" || typeof seq !== "number" || typeof userId !== "string") throw new Error("fixture: row keys");
  if (typeof clientMessageId !== "string" || typeof at !== "string") throw new Error("fixture: row keys");
  if (text !== undefined && typeof text !== "string") throw new Error("fixture: text");
  const read = readStoredAgMessage(content);
  if (read.value === undefined || read.reports.length > 0) throw new Error("fixture: content is not a whole stored AgMessage");
  return {
    threadId,
    seq,
    userId,
    clientMessageId,
    at,
    kind: "text",
    authorRole: "agent",
    ...(text !== undefined ? { text } : {}),
    content: read.value,
    ...(aiContext !== undefined ? { aiContext } : {}),
  };
}

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const LEGACY = fixtureRow(read("thread-message-row.agjson-draft3.json"));
const commentaryDoc = read("thread-message-rows.openai-commentary.json");
if (!isObj(commentaryDoc) || !Array.isArray(commentaryDoc["rows"])) throw new Error("fixture: commentary rows");
const COMMENTARY = commentaryDoc["rows"].map(fixtureRow);

describe("the split, on real stored rows", () => {
  it("the capture really carries narration: three interim messages, then the answer", () => {
    expect(COMMENTARY.map((r) => messageNarration(r.content).length)).toEqual([1, 1, 1, 0]);
    expect(COMMENTARY.map((r) => messageText(r.content))).toEqual(["", "", "", "Final result: `alpha-beta-gamma`"]);
  });

  it("the model's view is byte-identical to what the writer stored before the split, for every row (legacy included)", () => {
    for (const row of [LEGACY, ...COMMENTARY]) {
      expect(storedTextParts(row.content)?.all).toBe(row.text ?? "");
      expect(messageFullText(row.content)).toBe(row.text ?? "");
    }
  });

  it("a legacy row without phases splits into itself: the answer is its text, no narration", () => {
    expect(storedTextParts(LEGACY.content)).toEqual({ answer: LEGACY.text, narration: [], all: LEGACY.text });
  });

  it("the writer now stores the ANSWER as `text`: a narration-only message stores no text; the answer row stores its answer", () => {
    const written = COMMENTARY.map((r) =>
      agMessageToRow(r.content, { threadId: r.threadId, userId: r.userId, seq: r.seq, at: r.at, clientMessageId: r.clientMessageId }),
    );
    expect(written.map((w) => w.text)).toEqual([undefined, undefined, undefined, "Final result: `alpha-beta-gamma`"]);
    // The stored content is untouched: narration keeps its phase, in place.
    expect(written[0]!.content).toEqual(COMMENTARY[0]!.content);
  });

  it("content stored as a JSON string (an AppSync writer) splits the same way; anything that is not a stored AgMessage is null", () => {
    const row = COMMENTARY[0]!;
    expect(storedTextParts(JSON.stringify(row.content))).toEqual(storedTextParts(row.content));
    for (const notAMessage of ["answer", "{not json", JSON.stringify({ kind: "text", text: "x" }), null, 5, { blocks: [] }, undefined]) {
      expect(storedTextParts(notAMessage)).toBeNull();
    }
  });
});

describe("the store: preview and the model's history", () => {
  function foldOf(rows: ReturnType<typeof fixtureRow>[]): AgReduceResult {
    const turns: AgTurnRecord[] = [];
    for (const r of rows) {
      const ai = r.aiContext;
      if (isObj(ai) && typeof ai["turnId"] === "string" && typeof ai["threadId"] === "string") {
        turns.push({ turnId: ai["turnId"], threadId: ai["threadId"] });
      }
    }
    return { messages: rows.map((r) => r.content), artifacts: [], memory: [], turns };
  }

  it("rows stored BEFORE the split replay to the model exactly as stored", async () => {
    const db = new InMemoryThreadPersistence();
    for (const [i, row] of [LEGACY, ...COMMENTARY].entries()) await db.putMessage({ ...row, threadId: "t-mixed", seq: i + 1 });
    const history = await new ThreadStore(db).loadHistory("t-mixed");
    expect(history.map((h) => h.text)).toEqual([LEGACY, ...COMMENTARY].map((r) => r.text ?? null));
  });

  it("rows written AFTER the split replay the same bytes, while their `text` and the thread preview are the answer", async () => {
    const db = new InMemoryThreadPersistence();
    const store = new ThreadStore(db);
    const threadId = await store.ensureThread({ userId: "g_fixture", appId: "app_1", region: "us-east-1" });
    await store.appendFold({ threadId, userId: "g_fixture", fold: foldOf(COMMENTARY), clientMessageIdBase: "cmid-after" });

    const history = await store.loadHistory(threadId);
    expect(history.map((h) => h.text)).toEqual(COMMENTARY.map((r) => r.text ?? null));
    const rows = await db.listRecentMessages(threadId, 10);
    expect(rows.map((r) => r.text)).toEqual([undefined, undefined, undefined, "Final result: `alpha-beta-gamma`"]);
    expect((await db.getThread(threadId))?.lastMessagePreview).toBe("Final result: `alpha-beta-gamma`");
  });

  it("a turn that so far holds only narration leaves the thread preview as it was: narration never becomes the preview", async () => {
    const db = new InMemoryThreadPersistence();
    const store = new ThreadStore(db);
    const threadId = await store.ensureThread({ userId: "g_fixture", appId: "app_1", region: "us-east-1" });
    const before = (await db.getThread(threadId))?.lastMessagePreview;
    await store.appendFold({ threadId, userId: "g_fixture", fold: foldOf(COMMENTARY.slice(0, 3)), clientMessageIdBase: "cmid-narration" });
    expect((await db.getThread(threadId))?.lastMessagePreview).toBe(before);
    expect(before).not.toContain("alpha");
  });
});
