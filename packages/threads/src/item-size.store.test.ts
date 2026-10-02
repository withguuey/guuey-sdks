/**
 * guuey#1794 — a turn near DynamoDB's 400 KB item limit. The store sizes every
 * row of a turn by the binding's row budget before it writes any: an oversized
 * tool-call value is stored as the elided marker, and a turn that still cannot
 * fit is written as one failure row (or refused) — never in part.
 *
 * Runs over `withItemSizeLimit(new InMemoryThreadPersistence())`: a port that
 * declares the DynamoDB row budget and REJECTS a row over 400 KB the way
 * DynamoDB does, so a row the store fails to bound fails here as it would in
 * production.
 */
import { describe, expect, it } from "vitest";
import type { AgMessage, AgReduceResult, JsonValue } from "@silverprotocol/core";
import { AgProviderMeta, readStoredAgMessage } from "@silverprotocol/core";
import {
  agMessageToBoundedRow,
  agMessageToRow,
  classifyStoredRow,
  DYNAMODB_ROW_BUDGET_BYTES,
  dynamoItemBytes,
  ELIDED_VALUE_KEY,
  STORED_TURN_TOO_LARGE_CODE,
  STORED_TURN_UNSTORABLE_NUMBER_CODE,
  StoredRowTooLargeError,
  StoredRowUnstorableNumberError,
  ThreadStore,
  type ThreadRow,
} from "./index.js";
import { InMemoryThreadPersistence } from "./in-memory.js";
import { withItemSizeLimit } from "./testing/contract-suite.js";

function threadRow(id: string): ThreadRow {
  const now = "2026-10-02T00:00:00.000Z";
  return {
    id,
    userId: "g_abc",
    appId: "app_1",
    servingRegion: "us-east-1",
    title: "New thread",
    status: "active",
    pinned: false,
    lastSeq: 0,
    lastMessageAt: now,
    lastMessagePreview: "",
    threadMode: "single",
    createdAt: now,
    updatedAt: now,
  };
}

async function setup(limited = true) {
  const mem = new InMemoryThreadPersistence();
  const store = new ThreadStore(limited ? withItemSizeLimit(mem) : mem);
  await mem.createThread(threadRow("t1"));
  return { mem, store };
}

const jsonBytes = (v: JsonValue): number => Buffer.byteLength(JSON.stringify(v), "utf8");

/** A stored row's `content`, read back as the AgMessage it holds. */
function storedMessage(content: unknown): AgMessage {
  const msg = readStoredAgMessage(content).value;
  if (msg === undefined) throw new Error("row content is not a stored AgMessage");
  return msg;
}

/** A `ggui_render`-shaped input of about `kb` KB. */
function bigInput(kb: number): JsonValue {
  return { props: { data: "x".repeat(kb * 1000) } };
}

function renderMessage(input: JsonValue, extra: Partial<AgMessage> = {}): AgMessage {
  return {
    id: "m0",
    role: "assistant",
    turnId: "turn1",
    threadId: "t1",
    content: [
      { type: "text", text: "Drawing it.", phase: "interim" },
      { type: "tool-call", toolCallId: "call_1", name: "ggui_render", input },
    ],
    ...extra,
  };
}

function answer(text: string): AgMessage {
  return { id: "m1", role: "assistant", turnId: "turn1", threadId: "t1", content: [{ type: "text", text }] };
}

function fold(messages: AgMessage[], artifacts: AgReduceResult["artifacts"] = []): AgReduceResult {
  return {
    messages,
    artifacts,
    memory: [],
    turns: [{ turnId: "turn1", threadId: "t1", finishReason: "stop" }],
    state: { step: 1 },
  };
}

const smallCard = { artifactId: "a1", turnId: "turn1", threadId: "t1", parts: [{ type: "text" as const, text: "{}" }] };

describe("ThreadStore.appendFold under a row budget (guuey#1794)", () => {
  it("stores a 568 KB tool-call input as the elided marker and lands the whole turn", async () => {
    const { mem, store } = await setup();
    const input = bigInput(568);
    const res = await store.appendFold({
      threadId: "t1",
      userId: "g_abc",
      fold: fold([renderMessage(input), answer("Here it is.")], [smallCard]),
      clientMessageIdBase: "cmid",
    });

    expect(res.messageSeqs).toEqual([1, 2]);
    expect(res.artifactSeqs).toEqual([3]);
    expect(res.elidedToolInputs).toEqual([
      { seq: 1, toolCallId: "call_1", name: "ggui_render", field: "input", reason: "size", bytes: jsonBytes(input) },
    ]);
    expect(res.unstorable).toBeUndefined();

    const rows = await mem.listRecentMessages("t1", 10);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]!.clientMessageId).toBe("cmid#agentTurn");
    const stored = storedMessage(rows[0]!.content);
    expect(stored.content[0]).toEqual({ type: "text", text: "Drawing it.", phase: "interim" });
    expect(stored.content[1]).toEqual({
      type: "tool-call",
      toolCallId: "call_1",
      name: "ggui_render",
      input: { [ELIDED_VALUE_KEY]: { bytes: jsonBytes(input) } },
    });
    // The answer row is untouched.
    expect(rows[1]!.text).toBe("Here it is.");
    expect(rows[1]!.content).toEqual(answer("Here it is."));
    expect(await mem.getSnapshot("t1")).toMatchObject({ workingState: { step: 1 } });
  });

  it("elides the redundant wireInput first and keeps the input verbatim when that is enough", async () => {
    const { mem, store } = await setup();
    const input = bigInput(250);
    const wire = bigInput(250);
    const msg: AgMessage = {
      id: "m0",
      role: "assistant",
      turnId: "turn1",
      threadId: "t1",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          name: "ggui_render",
          input,
          providerMetadata: AgProviderMeta.parse({ wireInput: wire, other: "kept" }),
        },
      ],
    };
    const res = await store.appendFold({ threadId: "t1", userId: "g_abc", fold: fold([msg]), clientMessageIdBase: "cmid" });

    expect(res.elidedToolInputs.map((e) => e.field)).toEqual(["wireInput"]);
    const block = storedMessage((await mem.listRecentMessages("t1", 10))[0]!.content).content[0];
    expect(block).toMatchObject({
      input,
      providerMetadata: { wireInput: { [ELIDED_VALUE_KEY]: { bytes: jsonBytes(wire) } }, other: "kept" },
    });
  });

  it("elides an input whose JSON is under the budget but whose DynamoDB size is not", async () => {
    const { mem, store } = await setup();
    const pairs: JsonValue = Array.from({ length: 40_000 }, () => [1, 2]);
    const msg = renderMessage(pairs);
    const unbounded = agMessageToRow(msg, { threadId: "t1", userId: "g_abc", seq: 1, at: "2026-10-02T00:00:00.000Z", clientMessageId: "c" });
    // A JSON measure would pass this row; DynamoDB would refuse it.
    expect(Buffer.byteLength(JSON.stringify(unbounded), "utf8")).toBeLessThan(DYNAMODB_ROW_BUDGET_BYTES);
    expect(dynamoItemBytes(unbounded)).toBeGreaterThan(409_600);

    const res = await store.appendFold({ threadId: "t1", userId: "g_abc", fold: fold([msg]), clientMessageIdBase: "cmid" });
    expect(res.elidedToolInputs).toHaveLength(1);
    expect(await mem.listRecentMessages("t1", 10)).toHaveLength(1);
  });

  it("writes nothing and throws when a later row cannot fit and no notice is given", async () => {
    const { mem, store } = await setup();
    const err = await store
      .appendFold({
        threadId: "t1",
        userId: "g_abc",
        fold: fold([renderMessage({ q: 1 }), answer("y".repeat(500_000))]),
        clientMessageIdBase: "cmid",
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StoredRowTooLargeError);
    expect(err).toMatchObject({ rowKind: "message", index: 1, maxBytes: DYNAMODB_ROW_BUDGET_BYTES });
    expect(mem.messages).toHaveLength(0);
    expect(mem.threads.get("t1")?.lastSeq).toBe(0);
    expect(await mem.findByClientMessageId("t1", "cmid#agentTurn")).toBeUndefined();
    expect(await mem.getSnapshot("t1")).toBeUndefined();
  });

  it("writes nothing when a card row cannot fit", async () => {
    const { mem, store } = await setup();
    const bigCard = { artifactId: "a1", turnId: "turn1", threadId: "t1", parts: [{ type: "text" as const, text: "z".repeat(450_000) }] };
    const err = await store
      .appendFold({ threadId: "t1", userId: "g_abc", fold: fold([answer("ok")], [bigCard]), clientMessageIdBase: "cmid" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StoredRowTooLargeError);
    expect(err).toMatchObject({ rowKind: "card", index: 0 });
    expect(mem.messages).toHaveLength(0);
    expect(mem.threads.get("t1")?.lastSeq).toBe(0);
  });

  it("stores ONE failure row under the sentinel when a notice is given, and a retry is deduped", async () => {
    const { mem, store } = await setup();
    const args = {
      threadId: "t1",
      userId: "g_abc",
      fold: fold([renderMessage({ q: 1 }), answer("y".repeat(500_000))]),
      clientMessageIdBase: "cmid",
      unstorableNotice: { text: "This answer was too large to save." },
    };
    const res = await store.appendFold(args);

    expect(res.messageSeqs).toEqual([]);
    expect(res.artifactSeqs).toEqual([]);
    expect(res.unstorable).toMatchObject({ seq: 1, rowKind: "message", index: 1, reason: "size", maxBytes: DYNAMODB_ROW_BUDGET_BYTES });
    expect(mem.messages).toHaveLength(1);
    const row = mem.messages[0]!;
    expect(row.clientMessageId).toBe("cmid#agentTurn");
    expect(row.text).toBe("This answer was too large to save.");
    expect(classifyStoredRow(row)).toEqual({ kind: "failure", code: STORED_TURN_TOO_LARGE_CODE });
    expect(await mem.getSnapshot("t1")).toMatchObject({ workingState: { step: 1 } });

    const retry = await store.appendFold(args);
    expect(retry).toMatchObject({ deduped: true, elidedToolInputs: [] });
    expect(mem.messages).toHaveLength(1);
  });

  it("keeps a 568 KB input verbatim on a port that declares no budget", async () => {
    const { mem, store } = await setup(false);
    const input = bigInput(568);
    const res = await store.appendFold({ threadId: "t1", userId: "g_abc", fold: fold([renderMessage(input)]), clientMessageIdBase: "cmid" });
    expect(res.elidedToolInputs).toEqual([]);
    expect(storedMessage(mem.messages[0]!.content).content[1]).toMatchObject({ type: "tool-call", input });
  });
});

/**
 * A JSON number outside the safe-integer range (a 20-digit id in a tool's input
 * or result, after `JSON.parse`) cannot be stored by a DynamoDB-backed binding:
 * the DocumentClient refuses it client-side. The port below refuses it the same
 * way, so a row the store fails to plan out fails here mid-turn, as it would in
 * production.
 */
/** A 20-digit id as a tool's JSON carries it: parsed, it is already a float above 2^53. */
const BIG_ID = Number("12345678901234567890");

function toolTurn(callInput: JsonValue, structuredContent?: JsonValue): AgMessage[] {
  return [
    answer("Looking it up."),
    {
      id: "m2",
      role: "assistant",
      turnId: "turn1",
      threadId: "t1",
      content: [{ type: "tool-call", toolCallId: "call_9", name: "lookup", input: callInput }],
    },
    {
      id: "m3",
      role: "tool",
      turnId: "turn1",
      threadId: "t1",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_9",
          content: [{ type: "text", text: "found" }],
          ...(structuredContent !== undefined ? { structuredContent } : {}),
        },
      ],
    },
  ];
}

describe("ThreadStore.appendFold and numbers the store cannot hold (guuey#1794)", () => {
  it("elides a tool-call input carrying a 20-digit id and lands the whole turn", async () => {
    const { mem, store } = await setup();
    const callInput = { id: BIG_ID, q: "x" };
    const res = await store.appendFold({
      threadId: "t1",
      userId: "g_abc",
      fold: fold(toolTurn(callInput)),
      clientMessageIdBase: "cmid",
    });

    expect(res.messageSeqs).toEqual([1, 2, 3]);
    expect(res.unstorable).toBeUndefined();
    expect(res.elidedToolInputs).toEqual([
      { seq: 2, toolCallId: "call_9", name: "lookup", field: "input", reason: "number", bytes: jsonBytes(callInput) },
    ]);
    const rows = await mem.listRecentMessages("t1", 10);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(storedMessage(rows[1]!.content).content[0]).toEqual({
      type: "tool-call",
      toolCallId: "call_9",
      name: "lookup",
      input: { [ELIDED_VALUE_KEY]: { bytes: jsonBytes(callInput) } },
    });
  });

  it("elides a tool-call input carrying a magnitude below DynamoDB's 1e-130 floor", async () => {
    const { store } = await setup();
    const res = await store.appendFold({
      threadId: "t1",
      userId: "g_abc",
      fold: fold(toolTurn({ tiny: 1e-200 })),
      clientMessageIdBase: "cmid",
    });
    expect(res.messageSeqs).toEqual([1, 2, 3]);
    expect(res.elidedToolInputs.map((e) => e.reason)).toEqual(["number"]);
  });

  it("stores ONE failure row, never a partial turn, when a tool result carries one, and a retry is deduped", async () => {
    const { mem, store } = await setup();
    const args = {
      threadId: "t1",
      userId: "g_abc",
      fold: fold(toolTurn({ q: "x" }, { id: BIG_ID })),
      clientMessageIdBase: "cmid",
      unstorableNotice: { text: "This reply couldn't be saved." },
    };
    const res = await store.appendFold(args);

    expect(res.messageSeqs).toEqual([]);
    expect(res.unstorable).toEqual({ seq: 1, rowKind: "message", index: 2, reason: "number" });
    expect(mem.messages).toHaveLength(1);
    const row = mem.messages[0]!;
    expect(row.clientMessageId).toBe("cmid#agentTurn");
    expect(row.content).toEqual({
      kind: "text",
      text: "This reply couldn't be saved.",
      error: { code: STORED_TURN_UNSTORABLE_NUMBER_CODE },
    });
    expect(classifyStoredRow(row)).toEqual({ kind: "failure", code: STORED_TURN_UNSTORABLE_NUMBER_CODE });

    const retry = await store.appendFold(args);
    expect(retry).toMatchObject({ deduped: true });
    expect(mem.messages).toHaveLength(1);
  });

  it("writes nothing and throws the refusal without a notice, never naming the number", async () => {
    const { mem, store } = await setup();
    const err = await store
      .appendFold({ threadId: "t1", userId: "g_abc", fold: fold(toolTurn({ q: "x" }, { id: BIG_ID })), clientMessageIdBase: "cmid" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoredRowUnstorableNumberError);
    expect(err).toMatchObject({ rowKind: "message", index: 2 });
    expect((err as Error).message).not.toMatch(/\d{5,}/);
    expect(mem.messages).toHaveLength(0);
    expect(mem.threads.get("t1")?.lastSeq).toBe(0);
  });

  it("writes nothing when a card row carries one", async () => {
    const { mem, store } = await setup();
    const card = { artifactId: "a1", turnId: "turn1", threadId: "t1", parts: [{ type: "data" as const, name: "d", data: { id: BIG_ID } }] };
    const err = await store
      .appendFold({ threadId: "t1", userId: "g_abc", fold: fold([answer("ok")], [card]), clientMessageIdBase: "cmid" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoredRowUnstorableNumberError);
    expect(err).toMatchObject({ rowKind: "card", index: 0 });
    expect(mem.messages).toHaveLength(0);
  });
});

describe("ThreadStore.appendMessage under a row budget (guuey#1794)", () => {
  it("refuses a row carrying a number the store cannot hold before it spends a seq", async () => {
    const { mem, store } = await setup();
    const err = await store
      .appendMessage({ threadId: "t1", userId: "g_abc", role: "user", content: { kind: "text", n: BIG_ID }, clientMessageId: "u1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoredRowUnstorableNumberError);
    expect(err).toMatchObject({ rowKind: "append" });
    expect(mem.threads.get("t1")?.lastSeq).toBe(0);
  });

  it("refuses an oversized row before it spends a seq", async () => {
    const { mem, store } = await setup();
    const err = await store
      .appendMessage({ threadId: "t1", userId: "g_abc", role: "user", content: "u".repeat(450_000), clientMessageId: "u1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoredRowTooLargeError);
    expect(err).toMatchObject({ rowKind: "append" });
    expect(mem.threads.get("t1")?.lastSeq).toBe(0);
    expect(mem.messages).toHaveLength(0);
  });
});

describe("agMessageToBoundedRow", () => {
  it("is exactly agMessageToRow under the budget", () => {
    const msg = renderMessage({ q: 1 });
    const ctx = { threadId: "t1", userId: "g_abc", seq: 4, at: "2026-10-02T00:00:00.000Z", clientMessageId: "c" };
    const budget = { maxBytes: DYNAMODB_ROW_BUDGET_BYTES, bytesOf: dynamoItemBytes };
    expect(agMessageToBoundedRow(msg, ctx, budget, 0)).toEqual({ row: agMessageToRow(msg, ctx), elided: [] });
  });
});
