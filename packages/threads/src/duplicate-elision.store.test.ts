/**
 * A message row over its row budget leaves out a pure duplicate first: a
 * tool-result's inline UI resource (`uiData` `{ uri, text }`) that a card row
 * of the same turn carries whole. Only then are tool-call values elided.
 *
 * The readers that turn stored rows back into a thread never read a message
 * row's `uiData` text: the transcript's text and narration come from the text
 * blocks, and the card is drawn from the card row's snapshot. So an elided row
 * reads back as the same thread, and the card row is where the resource is.
 */
import { describe, expect, it } from "vitest";
import type { AgMessage, AgReduceResult, JsonValue } from "@silverprotocol/core";
import { readStoredAgMessage } from "@silverprotocol/core";
import {
  agArtifactToCardRow,
  agMessageToBoundedRow,
  agMessageToRow,
  cardUiDataByCallId,
  classifyStoredRow,
  ELIDED_VALUE_KEY,
  storedTextParts,
  ThreadStore,
  type RowBudget,
  type ThreadMessageRow,
  type ThreadRow,
} from "./index.js";
import { InMemoryThreadPersistence } from "./in-memory.js";
import { withItemSizeLimit } from "./testing/contract-suite.js";

const AT = "2026-10-02T00:00:00.000Z";

function threadRow(id: string): ThreadRow {
  return {
    id,
    userId: "g_abc",
    appId: "app_1",
    servingRegion: "us-east-1",
    title: "New thread",
    status: "active",
    pinned: false,
    lastSeq: 0,
    lastMessageAt: AT,
    lastMessagePreview: "",
    threadMode: "single",
    createdAt: AT,
    updatedAt: AT,
  };
}

async function setup() {
  const mem = new InMemoryThreadPersistence();
  const store = new ThreadStore(withItemSizeLimit(mem));
  await mem.createThread(threadRow("t1"));
  return { mem, store };
}

const jsonBytes = (v: JsonValue): number => Buffer.byteLength(JSON.stringify(v), "utf8");

/** An inline UI resource whose text is about `kb` KB. */
function resource(kb: number, tag = "a"): JsonValue {
  return { uri: "ui://cards/report", mimeType: "text/html", text: `<div>${tag.repeat(kb * 1000)}</div>` };
}

/** One assistant message: narration, a tool call with an input of about `inputKb` KB, its UI result, and the answer. */
function appMessage(inputKb: number, uiData: JsonValue): AgMessage {
  return {
    id: "m0",
    role: "assistant",
    turnId: "turn1",
    threadId: "t1",
    content: [
      { type: "text", text: "Building the report.", phase: "interim" },
      { type: "tool-call", toolCallId: "call_ui", name: "show_report", input: { rows: "r".repeat(inputKb * 1000) } },
      { type: "tool-result", toolCallId: "call_ui", content: [], uiData },
      { type: "text", text: "Here is the report." },
    ],
  };
}

function fold(messages: AgMessage[]): AgReduceResult {
  return { messages, artifacts: [], memory: [], turns: [{ turnId: "turn1", threadId: "t1", finishReason: "stop" }] };
}

function storedMessage(content: unknown): AgMessage {
  const msg = readStoredAgMessage(content).value;
  if (msg === undefined) throw new Error("row content is not a stored AgMessage");
  return msg;
}

/** The stored message with each elided `uiData` replaced by the card rows' copy for its call. */
function restoreFromCards(message: AgMessage, cardRows: readonly ThreadMessageRow[]): AgMessage {
  const cards = cardUiDataByCallId(cardRows);
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== "tool-result" || block.uiData === null || typeof block.uiData !== "object" || Array.isArray(block.uiData)) {
        return block;
      }
      if (!(ELIDED_VALUE_KEY in block.uiData)) return block;
      const copy = cards.get(block.toolCallId)?.[0];
      if (copy === undefined) throw new Error(`no card row carries ${block.toolCallId}`);
      return { ...block, uiData: copy.uiData };
    }),
  };
}

describe("ThreadStore.appendFold: a UI resource its card row carries is left out of the message row first", () => {
  it("stores the message row's uiData as the elided marker, keeps the tool input whole, and the card row carries the resource", async () => {
    const { mem, store } = await setup();
    const uiData = resource(250);
    const msg = appMessage(150, uiData);
    const res = await store.appendFold({ threadId: "t1", userId: "g_abc", fold: fold([msg]), clientMessageIdBase: "cmid" });

    expect(res.messageSeqs).toEqual([1]);
    expect(res.artifactSeqs).toEqual([2]);
    expect(res.unstorable).toBeUndefined();
    expect(res.elidedToolInputs).toEqual([
      { seq: 1, toolCallId: "call_ui", name: "show_report", field: "uiData", reason: "size", bytes: jsonBytes(uiData) },
    ]);

    const rows = await mem.listRecentMessages("t1", 10);
    const messageRow = rows.find((r) => r.seq === 1)!;
    const cardRow = rows.find((r) => r.seq === 2)!;
    const stored = storedMessage(messageRow.content);
    expect(stored.content[1]).toEqual(msg.content[1]);
    expect(stored.content[2]).toEqual({ type: "tool-result", toolCallId: "call_ui", content: [], uiData: { [ELIDED_VALUE_KEY]: { bytes: jsonBytes(uiData) } } });
    expect(cardRow).toMatchObject({ kind: "card", toolName: "show_report" });
    expect(cardUiDataByCallId([cardRow]).get("call_ui")).toEqual([{ name: "show_report", uiData }]);

    // The card row restores the message whole.
    expect(restoreFromCards(stored, [cardRow])).toEqual(agMessageToRow(msg, { threadId: "t1", userId: "g_abc", seq: 1, at: AT, clientMessageId: "c" }).content);
  });

  it("reads back as the same thread: text, narration, the model's view and the row's class are those of the unelided row", async () => {
    const { mem, store } = await setup();
    const msg = appMessage(150, resource(250));
    await store.appendFold({ threadId: "t1", userId: "g_abc", fold: fold([msg]), clientMessageIdBase: "cmid" });
    const messageRow = (await mem.listRecentMessages("t1", 10)).find((r) => r.seq === 1)!;
    const unelided = agMessageToRow(msg, { threadId: "t1", userId: "g_abc", seq: 1, at: AT, clientMessageId: messageRow.clientMessageId });

    expect(messageRow.text).toBe(unelided.text);
    expect(storedTextParts(messageRow.content, messageRow.text)).toEqual(storedTextParts(unelided.content, unelided.text));
    expect(storedTextParts(JSON.stringify(messageRow.content), messageRow.text)).toEqual(storedTextParts(unelided.content, unelided.text));
    expect(classifyStoredRow(messageRow)).toEqual(classifyStoredRow(unelided));
    expect(readStoredAgMessage(messageRow.content).reports).toEqual([]);
    const history = await store.loadHistory("t1");
    expect(history.map((h) => h.text)).toEqual([storedTextParts(unelided.content, unelided.text)?.all]);
  });

  it("elides the tool input instead when the card row's resource differs from the message row's", async () => {
    const { mem, store } = await setup();
    const msg = appMessage(150, resource(250, "a"));
    const other: AgReduceResult["artifacts"][number] = {
      artifactId: "m0#ui#2",
      turnId: "turn1",
      threadId: "t1",
      parts: [{ type: "tool-result", toolCallId: "call_ui", content: [], uiData: resource(250, "b") }],
    };
    const res = await store.appendFold({
      threadId: "t1",
      userId: "g_abc",
      fold: { ...fold([msg]), artifacts: [other] },
      clientMessageIdBase: "cmid",
    });

    expect(res.elidedToolInputs.map((e) => e.field)).toEqual(["input"]);
    const stored = storedMessage((await mem.listRecentMessages("t1", 10)).find((r) => r.seq === 1)!.content);
    expect(stored.content[2]).toEqual(msg.content[2]);
  });
});

describe("agMessageToBoundedRow with the turn's card rows", () => {
  const ctx = { threadId: "t1", userId: "g_abc", seq: 4, at: AT, clientMessageId: "c" };
  /** A budget that counts the row's JSON bytes. */
  const budget = (maxBytes: number): RowBudget => ({ maxBytes, bytesOf: (row) => Buffer.byteLength(JSON.stringify(row), "utf8") });
  /** A card row of the turn; `toolName: null` stores none. */
  const cardRow = (uiData: JsonValue, toolCallId = "call_ui", toolName: string | null = "show_report"): ThreadMessageRow =>
    agArtifactToCardRow(
      { artifactId: "m0#ui#2", turnId: "turn1", threadId: "t1", parts: [{ type: "tool-result", toolCallId, content: [], uiData }] },
      { ...ctx, seq: 5 },
      toolName ?? undefined,
    );

  it("is exactly agMessageToRow under the budget, a duplicate resource included", () => {
    const uiData = resource(5);
    const msg = appMessage(1, uiData);
    expect(agMessageToBoundedRow(msg, ctx, budget(100_000), 0, cardUiDataByCallId([cardRow(uiData)]))).toEqual({
      row: agMessageToRow(msg, ctx),
      elided: [],
    });
  });

  it("over the budget, elides the duplicate resource before any tool-call value", () => {
    const uiData = resource(20);
    const msg = appMessage(10, uiData);
    const { row, elided } = agMessageToBoundedRow(msg, ctx, budget(15_000), 0, cardUiDataByCallId([cardRow(uiData)]));
    expect(elided).toEqual([{ toolCallId: "call_ui", name: "show_report", field: "uiData", reason: "size", bytes: jsonBytes(uiData) }]);
    expect(storedMessage(row.content).content[1]).toEqual(msg.content[1]);
  });

  it("keeps a resource whose text differs from the card row's, whose call differs, or whose card row names no tool", () => {
    const uiData = resource(20);
    const msg = appMessage(10, uiData);
    for (const card of [cardRow(resource(20, "b")), cardRow(uiData, "call_other"), cardRow(uiData, "call_ui", null)]) {
      const { elided } = agMessageToBoundedRow(msg, ctx, budget(25_000), 0, cardUiDataByCallId([card]));
      expect(elided.map((e) => e.field)).toEqual(["input"]);
    }
  });

  it("keeps a ui:// locator a card row also carries: only an inline resource with text is a duplicate to elide", () => {
    const locator = { sessionId: "render_1", resourceUri: "ui://ggui/render/render_1/1", action: "create", pad: "p".repeat(20_000) };
    const msg = appMessage(10, locator);
    const { elided } = agMessageToBoundedRow(msg, ctx, budget(25_000), 0, cardUiDataByCallId([cardRow(locator)]));
    expect(elided.map((e) => e.field)).toEqual(["input"]);
  });

  it("never elides a text block: an answer stored twice (row text and content) and its narration stay verbatim", () => {
    const msg: AgMessage = {
      id: "m0",
      role: "assistant",
      turnId: "turn1",
      threadId: "t1",
      content: [
        { type: "text", text: "Here is the report, in full", phase: "interim" },
        { type: "tool-call", toolCallId: "call_ui", name: "show_report", input: { rows: "r".repeat(20_000) } },
        { type: "text", text: "Here is the report." },
      ],
    };
    const { row, elided } = agMessageToBoundedRow(msg, ctx, budget(5_000), 0);
    expect(elided.map((e) => e.field)).toEqual(["input"]);
    const stored = storedMessage(row.content);
    expect([stored.content[0], stored.content[2]]).toEqual([msg.content[0], msg.content[2]]);
    const unbounded = agMessageToRow(msg, ctx);
    expect(storedTextParts(row.content, row.text)).toEqual(storedTextParts(unbounded.content, unbounded.text));
  });
});
