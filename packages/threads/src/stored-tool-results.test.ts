/**
 * guuey#2487: a tool result that carries no UI resource (an in-process SDK
 * tool's `structuredContent`, or its text alone) is stored inside its turn's
 * message rows, but no card row stands for it, so a reader that only reads
 * card rows can not find it after a reload. These pins read it back from the
 * rows a fold stores TODAY, with no change to the writer: the stored data is
 * already there, so threads written before this reader existed read the same.
 *
 * The turn is folded the way the Claude facet folds an in-process tool call:
 * the call in the assistant message, the result in its own `role: "tool"`
 * message (`<toolCallId>:result`), so the call and its result are stored on
 * different rows.
 */
import { describe, expect, it } from "vitest";
import { AgProviderMeta, Reducer, type AgEvent, type AgMessage, type AgReduceResult, type JsonValue } from "@silverprotocol/core";
import { InMemoryThreadPersistence } from "./in-memory.js";
import {
  cardRowToAgArtifact,
  ELIDED_VALUE_KEY,
  storedToolCallViews,
  storedToolResultCallIds,
  storedToolResults,
  toolResultCarriesUi,
  uiCardArtifactsFromMessages,
} from "./fold-rows.js";
import type { ThreadMessageRow } from "./rows.js";
import { ThreadStore } from "./store.js";
import { withItemSizeLimit } from "./testing/contract-suite.js";

const THREAD = "t2487";
const USER = "g_2487";

/** One tool call's turn, the facet's event order: the call, the message closes, the adopted result, the answer. */
function toolTurn(args: {
  toolCallId: string;
  name: string;
  structuredContent?: JsonValue;
  uiData?: JsonValue;
  meta?: { [key: string]: JsonValue };
  content?: Extract<AgMessage["content"][number], { type: "tool-result" }>["content"];
  text: string;
}): AgEvent[] {
  const turnId = `turn_${args.toolCallId}`;
  const callMessage = `msg_${args.toolCallId}`;
  const answerMessage = `answer_${args.toolCallId}`;
  return [
    { type: "turn.start", seq: 0, turnId, threadId: THREAD },
    { type: "message.start", seq: 1, id: callMessage, turnId, threadId: THREAD, role: "assistant" },
    { type: "tool.start", seq: 2, turnId, toolCallId: args.toolCallId, name: args.name, index: 0, messageId: callMessage, providerExecuted: false },
    { type: "tool.args.assembled", seq: 3, toolCallId: args.toolCallId, input: {} },
    { type: "message.end", seq: 4, id: callMessage },
    {
      type: "tool.done",
      seq: 5,
      turnId,
      toolCallId: args.toolCallId,
      content: args.content ?? [{ type: "text", text: args.text }],
      outcome: "ok",
      isError: false,
      messageId: `${args.toolCallId}:result`,
      ...(args.structuredContent !== undefined ? { structuredContent: args.structuredContent } : {}),
      ...(args.uiData !== undefined ? { uiData: args.uiData } : {}),
      ...(args.meta !== undefined ? { _meta: args.meta } : {}),
    },
    { type: "message.start", seq: 6, id: answerMessage, turnId, threadId: THREAD, role: "assistant" },
    { type: "text.start", seq: 7, id: `${answerMessage}:text:0`, messageId: answerMessage },
    { type: "text.delta", seq: 8, id: `${answerMessage}:text:0`, messageId: answerMessage, delta: "Opened it." },
    { type: "text.end", seq: 9, id: `${answerMessage}:text:0`, messageId: answerMessage },
    { type: "message.end", seq: 10, id: answerMessage },
    { type: "turn.done", seq: 11, turnId, outcome: { type: "success" }, finishReason: "stop" },
  ];
}

/** The rows a fold of `events` stores, through the store as a pod stores a turn. */
async function storedRows(events: AgEvent[]): Promise<ThreadMessageRow[]> {
  const db = new InMemoryThreadPersistence();
  const store = new ThreadStore(db);
  const threadId = await store.ensureThread({ userId: USER, appId: "app_2487", region: "us-east-1" });
  const reducer = new Reducer();
  for (const e of events) reducer.push(e);
  await store.appendFold({ threadId, userId: USER, fold: reducer.result(), clientMessageIdBase: "u1" });
  return (await db.listRecentMessages(threadId, 50)).slice().sort((a, b) => a.seq - b.seq);
}

const OPEN_REVIEW = toolTurn({
  toolCallId: "toolu_open_review",
  name: "mcp__inbox__open_review",
  structuredContent: { card: "inbox" },
  meta: { "anthropic/agentOutput": { wsToken: "short-lived" } },
  text: '{"card":"inbox"}',
});

describe("a tool result with no UI resource, read back from the rows a fold stores (guuey#2487)", () => {
  it("the issue's case: no card row, and the result rides its own text row with structuredContent", async () => {
    const rows = await storedRows(OPEN_REVIEW);
    expect(rows.map((r) => r.kind)).toEqual(["text", "text", "text"]);
    expect(rows.some((r) => r.toolName !== undefined)).toBe(false);

    expect(rows.map((r) => storedToolCallViews(r.content, r.text))).toStrictEqual([
      [{ toolCallId: "toolu_open_review", name: "mcp__inbox__open_review", input: {} }],
      [],
      [],
    ]);
    const results = rows.map((r) => storedToolResults(r.content, r.text));
    expect(results[0]).toEqual([]);
    expect(results[2]).toEqual([]);
    expect(results[1]).toHaveLength(1);
    expect(results[1]![0]).toMatchObject({
      type: "tool-result",
      toolCallId: "toolu_open_review",
      structuredContent: { card: "inbox" },
      content: [{ type: "text", text: '{"card":"inbox"}' }],
    });
  });

  it("the stored block is served without its `_meta` (guuey#122's boundary): the writer strips it, the reader never adds one", async () => {
    const rows = await storedRows(OPEN_REVIEW);
    const [block] = storedToolResults(rows[1]!.content, rows[1]!.text);
    expect(block).toBeDefined();
    expect(block).not.toHaveProperty("_meta");
    expect(JSON.stringify(rows[1]!.content)).not.toContain("short-lived");
  });

  it("a text-only result (no structuredContent) reads back too: the host's sign-up tool", async () => {
    const rows = await storedRows(
      toolTurn({ toolCallId: "toolu_sign_up", name: "mcp__guest__sign_up", text: "Signed up." }),
    );
    const results = rows.flatMap((r) => storedToolResults(r.content, r.text));
    expect(results).toEqual([
      { type: "tool-result", toolCallId: "toolu_sign_up", content: [{ type: "text", text: "Signed up." }], outcome: "ok", isError: false },
    ]);
  });

  it("a UI-carrying result is a card row and NOT a stored tool result: one predicate, never both, never neither", async () => {
    const rows = await storedRows(
      toolTurn({
        toolCallId: "toolu_save_cards",
        name: "mcp__elyxs__save_cards",
        structuredContent: { resourceUri: "ui://elyxs/cards/1" },
        text: "saved",
      }),
    );
    const cards = rows.filter((r) => r.kind === "card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.toolName).toBe("mcp__elyxs__save_cards");
    expect(rows.flatMap((r) => storedToolResults(r.content, r.text))).toEqual([]);
  });

  it("the shared predicate: exactly the blocks the card projection takes", () => {
    const withLocator = { type: "tool-result" as const, toolCallId: "a", content: [], structuredContent: { resourceUri: "ui://x/1" } };
    const withResource = { type: "tool-result" as const, toolCallId: "b", content: [], uiData: { uri: "ui://x/2", mimeType: "text/html", text: "<p/>" } };
    const plain = { type: "tool-result" as const, toolCallId: "c", content: [], structuredContent: { card: "inbox" } };
    const elided = { type: "tool-result" as const, toolCallId: "d", content: [], uiData: { [ELIDED_VALUE_KEY]: { bytes: 250_000 } } };
    const viewData = { type: "tool-result" as const, toolCallId: "e", content: [], uiData: { items: [1, 2] }, _meta: { ui: { resourceUri: "ui://x/5" } } };
    expect([withLocator, withResource, plain, elided, viewData].map(toolResultCarriesUi)).toEqual([true, true, false, true, false]);
    const arts = uiCardArtifactsFromMessages([{ id: "m", role: "tool", content: [withLocator, withResource, plain, elided, viewData] }]);
    expect(arts.map((a) => a.artifactId)).toEqual(["m#ui#0", "m#ui#1", "m#ui#3"]);
  });

  it("storedToolResultCallIds names every result a row carries, UI-carrying ones included; storedToolResults only those with no UI resource", () => {
    const render = { type: "tool-result" as const, toolCallId: "r", content: [], structuredContent: { resourceUri: "ui://x/1" } };
    const plain = { type: "tool-result" as const, toolCallId: "p", content: [], structuredContent: { card: "inbox" } };
    const content: AgMessage = { id: "m", role: "tool", content: [render, plain] };
    expect(storedToolResultCallIds(content, undefined)).toEqual(["r", "p"]);
    expect(storedToolResultCallIds(JSON.stringify(content), undefined)).toEqual(["r", "p"]);
    expect(storedToolResults(content, undefined).map((b) => b.toolCallId)).toEqual(["p"]);
    for (const notAMessage of ["answer", "{not json", null, 5, { blocks: [] }, undefined]) {
      expect(storedToolResultCallIds(notAMessage, undefined)).toEqual([]);
    }
  });

  it("content stored as a JSON string (an AppSync writer) reads the same; anything that is not a stored message reads as none", async () => {
    const rows = await storedRows(OPEN_REVIEW);
    const row = rows[1]!;
    expect(storedToolResults(JSON.stringify(row.content), row.text)).toEqual(storedToolResults(row.content, row.text));
    expect(storedToolCallViews(JSON.stringify(rows[0]!.content), rows[0]!.text)).toStrictEqual(storedToolCallViews(rows[0]!.content, rows[0]!.text));
    for (const notAMessage of ["answer", "{not json", JSON.stringify({ kind: "text", text: "x" }), null, 5, { blocks: [] }, undefined]) {
      expect(storedToolResults(notAMessage, undefined)).toEqual([]);
      expect(storedToolCallViews(notAMessage, undefined)).toEqual([]);
    }
  });
});

/** The tool calls a set of stored rows stands for: as a card row, and as a stored tool result. */
function classified(rows: readonly ThreadMessageRow[]): { cards: string[]; results: string[] } {
  const cards: string[] = [];
  for (const row of rows) {
    if (row.kind !== "card") continue;
    for (const part of cardRowToAgArtifact(row)?.parts ?? []) {
      if (part.type === "tool-result") cards.push(part.toolCallId);
    }
  }
  const results = rows.filter((r) => r.kind === "text").flatMap((r) => storedToolResults(r.content, r.text).map((b) => b.toolCallId));
  return { cards, results };
}

/** A UI resource inline, about `kb` KB of HTML. */
function inlineResource(kb: number): JsonValue {
  return { uri: "ui://cards/report", mimeType: "text/html", text: `<div>${"a".repeat(kb * 1000)}</div>` };
}

describe("every stored tool result is a card row or a stored tool result, never both and never neither (guuey#2487)", () => {
  // The write side judges the LIVE block (with `_meta`); the reader judges the
  // STORED one (without it). Each case here is folded and stored the way a pod
  // stores a turn, and read back from the rows alone.
  const cases: Array<{ name: string; events: AgEvent[]; card: boolean }> = [
    {
      // The Claude facet's MCP-Apps routing: any `_meta.ui` sibling sends
      // structuredContent to `uiData` as plain view data. Here `_meta.ui`
      // names no `ui://` locator at all, so nothing live or stored could ever
      // mount a card: a card row for it would draw as an expired chip on every
      // reload. It is a stored tool result.
      name: "view data in uiData, _meta.ui with no ui:// locator",
      events: toolTurn({
        toolCallId: "toolu_show_bare",
        name: "mcp__app__show",
        uiData: { items: [1, 2] },
        meta: { ui: { visibility: ["app"] } },
        text: '{"items":[1,2]}',
      }),
      card: false,
    },
    {
      // The same routing with the locator named only in `_meta.ui`, which the
      // writer strips (guuey#122): the stored row keeps no locator, so a card
      // row for it could not mount after a reload either. Judged by what is
      // stored, it is a stored tool result. (Persisting that locator is a
      // writer change, not a reader one.)
      name: "view data in uiData, its locator only in _meta.ui",
      events: toolTurn({
        toolCallId: "toolu_show",
        name: "mcp__app__show",
        uiData: { items: [1, 2] },
        meta: { ui: { resourceUri: "ui://app/show" } },
        text: '{"items":[1,2]}',
      }),
      card: false,
    },
    {
      // A locator the producer put in `uiData` itself (ggui's render shape) is
      // stored, so it mounts after a reload by a fresh read of the uri.
      name: "a ui:// locator in uiData",
      events: toolTurn({
        toolCallId: "toolu_ui_locator",
        name: "mcp__ggui__render",
        uiData: { sessionId: "render_abc", resourceUri: "ui://ggui/render/abc" },
        meta: { ui: { resourceUri: "ui://ggui/render/abc" } },
        text: "rendered",
      }),
      card: true,
    },
    {
      // A kept-open result whose final omitted the payload: only `_meta.ui`
      // marked it, and `_meta` never persists, so nothing stored could mount it.
      name: "_meta.ui alone, no payload",
      events: toolTurn({
        toolCallId: "toolu_meta_only",
        name: "mcp__app__show",
        meta: { ui: { resourceUri: "ui://app/show" } },
        text: "shown",
      }),
      card: false,
    },
    {
      name: "a ui:// locator in structuredContent (no _meta)",
      events: toolTurn({ toolCallId: "toolu_sc_locator", name: "mcp__elyxs__save_cards", structuredContent: { resourceUri: "ui://elyxs/cards/1" }, text: "saved" }),
      card: true,
    },
    {
      name: "an inline UI resource in uiData",
      events: toolTurn({ toolCallId: "toolu_inline", name: "mcp__app__report", uiData: inlineResource(1), meta: { ui: {} }, text: "report" }),
      card: true,
    },
    {
      name: "a ui:// resource degraded into a provider-raw part",
      events: toolTurn({
        toolCallId: "toolu_raw",
        name: "mcp__app__raw",
        content: [{ type: "provider-raw", vendor: "anthropic", raw: { resource: { uri: "ui://app/raw", mimeType: "text/html", text: "<p/>" } } }],
        text: "",
      }),
      card: true,
    },
    {
      name: "plain structuredContent with _meta that is not UI",
      events: OPEN_REVIEW,
      card: false,
    },
    { name: "text alone", events: toolTurn({ toolCallId: "toolu_text", name: "mcp__guest__sign_up", text: "Signed up." }), card: false },
    { name: "a string uiData", events: toolTurn({ toolCallId: "toolu_str", name: "mcp__app__note", uiData: "done", text: "done" }), card: false },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const rows = await storedRows(c.events);
      // The call a reader names the result by (guuey#2388): its id and raw name, read through the one call reader.
      const started = c.events.flatMap((e) => (e.type === "tool.start" ? [{ toolCallId: e.toolCallId, name: e.name, input: {} }] : []));
      const [call] = rows.flatMap((r) => storedToolCallViews(r.content, r.text));
      expect(call).toBeDefined();
      expect(rows.flatMap((r) => storedToolCallViews(r.content, r.text))).toStrictEqual(started);
      expect(classified(rows)).toEqual(c.card ? { cards: [call!.toolCallId], results: [] } : { cards: [], results: [call!.toolCallId] });
    });
  }

  it("a uiData its card row carries whole, elided from the message row to fit the row budget, stays a card only", async () => {
    const mem = new InMemoryThreadPersistence();
    const store = new ThreadStore(withItemSizeLimit(mem));
    const threadId = await store.ensureThread({ userId: USER, appId: "app_2487", region: "us-east-1" });
    const message: AgMessage = {
      id: "m0",
      role: "assistant",
      turnId: "turn1",
      threadId,
      content: [
        { type: "tool-call", toolCallId: "call_ui", name: "show_report", input: { rows: "r".repeat(150_000) } },
        { type: "tool-result", toolCallId: "call_ui", content: [], uiData: inlineResource(250), _meta: { ui: { resourceUri: "ui://cards/report" } } },
        { type: "text", text: "Here is the report." },
      ],
    };
    const fold: AgReduceResult = { messages: [message], artifacts: [], memory: [], turns: [{ turnId: "turn1", threadId, finishReason: "stop" }] };
    const res = await store.appendFold({ threadId, userId: USER, fold, clientMessageIdBase: "u1" });
    expect(res.elidedToolInputs?.map((e) => e.field)).toEqual(["uiData"]);
    const rows = (await mem.listRecentMessages(threadId, 10)).slice().sort((a, b) => a.seq - b.seq);
    expect(JSON.stringify(rows[0]!.content)).toContain(ELIDED_VALUE_KEY);
    expect(classified(rows)).toEqual({ cards: ["call_ui"], results: [] });
  });
});

/** The four fields a reader serves for a stored call (guuey#2388), and nothing else core's block carries. */
const VIEW_KEYS = ["input", "name", "title", "toolCallId"];

/** A call block carrying every optional field core 0.12.7 knows, so a view that copied any of them shows it. */
function fullCall(toolCallId: string, name: string): Extract<AgMessage["content"][number], { type: "tool-call" }> {
  return {
    type: "tool-call",
    toolCallId,
    name,
    title: `Title of ${name}`,
    input: { city: "Seoul", days: [1, 2] },
    serverName: "inbox",
    providerExecuted: false,
    signature: "sig-secret",
    provider: "anthropic",
    toolMetadata: { owner: "tool-metadata-secret" },
    itemId: "item_1",
    providerCallIndex: 0,
    uiVisibility: ["model", "app"],
    providerMetadata: AgProviderMeta.parse({ wireInput: { city: "wire-input-copy" } }),
    annotations: { audience: ["assistant"] },
    _meta: { "anthropic/agentOutput": { wsToken: "meta-secret" } },
  };
}

describe("storedToolCallViews: a stored call as a reader serves it (guuey#2388)", () => {
  const message: AgMessage = {
    id: "m_calls",
    role: "assistant",
    content: [
      { type: "text", text: "Looking." },
      fullCall("call_a", "mcp__inbox__open_review"),
      { type: "reasoning", text: "thinking" },
      { type: "tool-call", toolCallId: "call_b", name: "mcp__guest__sign_up", input: "raw" },
      { type: "tool-result", toolCallId: "call_a", content: [{ type: "text", text: "ok" }] },
      fullCall("call_c", "mcp__inbox__close"),
    ],
  };

  it("keeps block order, reads only tool-call blocks, and serves exactly toolCallId, name, title and input", () => {
    expect(storedToolCallViews(message, undefined)).toStrictEqual([
      { toolCallId: "call_a", name: "mcp__inbox__open_review", title: "Title of mcp__inbox__open_review", input: { city: "Seoul", days: [1, 2] } },
      { toolCallId: "call_b", name: "mcp__guest__sign_up", input: "raw" },
      { toolCallId: "call_c", name: "mcp__inbox__close", title: "Title of mcp__inbox__close", input: { city: "Seoul", days: [1, 2] } },
    ]);
  });

  it("never serves providerMetadata, _meta, signature, toolMetadata, uiVisibility or any other field of core's block", () => {
    for (const content of [message, JSON.stringify(message)]) {
      const views = storedToolCallViews(content, undefined);
      expect(views).toHaveLength(3);
      for (const view of views) {
        expect(Object.keys(view).every((key) => VIEW_KEYS.includes(key)), Object.keys(view).join(",")).toBe(true);
        for (const field of ["providerMetadata", "_meta", "signature", "toolMetadata", "uiVisibility"]) {
          expect(view).not.toHaveProperty(field);
        }
      }
      const served = JSON.stringify(views);
      for (const secret of ["sig-secret", "tool-metadata-secret", "wire-input-copy", "meta-secret", "uiVisibility"]) {
        expect(served).not.toContain(secret);
      }
    }
  });

  it("through the real writer: the stored row keeps the call's _meta, the view does not serve it", async () => {
    const mem = new InMemoryThreadPersistence();
    const store = new ThreadStore(mem);
    const threadId = await store.ensureThread({ userId: USER, appId: "app_2388", region: "us-east-1" });
    const stored: AgMessage = { id: "m0", role: "assistant", turnId: "turn1", threadId, content: [fullCall("call_w", "mcp__inbox__open_review")] };
    const fold: AgReduceResult = { messages: [stored], artifacts: [], memory: [], turns: [{ turnId: "turn1", threadId, finishReason: "stop" }] };
    await store.appendFold({ threadId, userId: USER, fold, clientMessageIdBase: "u1" });
    const rows = (await mem.listRecentMessages(threadId, 10)).slice().sort((a, b) => a.seq - b.seq);
    expect(JSON.stringify(rows.map((r) => r.content))).toContain("meta-secret");
    expect(rows.flatMap((r) => storedToolCallViews(r.content, r.text))).toStrictEqual([
      { toolCallId: "call_w", name: "mcp__inbox__open_review", title: "Title of mcp__inbox__open_review", input: { city: "Seoul", days: [1, 2] } },
    ]);
  });
});
