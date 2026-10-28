/**
 * Tool results with no UI resource, rehydrated from the transcript read
 * (guuey#2487): a host that drew an attachment from an in-process tool's
 * result live (matched by the tool's name) can draw it again after a reload.
 *
 * Across a rolling release, both directions:
 * - an OLDER client (its `fetchThreadHistory` frozen in
 *   `fixtures/fetch-thread-history.prev.ts`) never asks for tool results, and
 *   reads a newer read plane's rows that carry them exactly as before;
 * - the CURRENT client asking an OLDER read plane (which ignores `include`)
 *   gets `toolResults: []` and everything else unchanged.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  fetchThreadHistory,
  threadHistoryRowsToToolResults,
  type ThreadHistoryRow,
} from "./history.js";
import { fetchThreadHistory as fetchThreadHistoryPrev } from "./fixtures/fetch-thread-history.prev.js";
import type { JsonValue } from "@silverprotocol/core";

const BLOCK = {
  type: "tool-result",
  toolCallId: "toolu_open_review",
  content: [{ type: "text", text: '{"card":"inbox"}' }],
  outcome: "ok",
  isError: false,
  structuredContent: { card: "inbox" },
};

/** The issue's thread as an older read plane serves it: text rows only. */
const OLD_ROWS: ThreadHistoryRow[] = [
  { seq: 1, at: "2026-10-18T10:37:00Z", kind: "text", authorRole: "user", text: "Open my review" },
  { seq: 2, at: "2026-10-18T10:37:01Z", kind: "text", authorRole: "agent", text: null },
  { seq: 3, at: "2026-10-18T10:37:02Z", kind: "text", authorRole: "agent", text: null },
  { seq: 4, at: "2026-10-18T10:37:03Z", kind: "text", authorRole: "agent", text: "Here is your inbox." },
];

/** The same thread from a read plane that was asked for tool results. */
const NEW_ROWS: ThreadHistoryRow[] = OLD_ROWS.map((row) =>
  row.seq === 3
    ? { ...row, toolResults: [{ toolCallId: "toolu_open_review", toolName: "mcp__inbox__open_review", block: BLOCK }] }
    : row,
);

function serving(rows: ThreadHistoryRow[]) {
  return vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ rows, nextToken: null, thread: {} }), { status: 200 }));
}

const opts = { baseUrl: "https://api.example.com/v1", threadId: "t1", includeCards: true };

describe("threadHistoryRowsToToolResults", () => {
  it("the issue's repro: the result is handed to the host by name, with its structuredContent and position", () => {
    expect(threadHistoryRowsToToolResults(NEW_ROWS)).toEqual([
      {
        seq: 3,
        at: "2026-10-18T10:37:02Z",
        toolCallId: "toolu_open_review",
        toolName: "mcp__inbox__open_review",
        block: BLOCK,
        structuredContent: { card: "inbox" },
      },
    ]);
  });

  it("a text-only result has no structuredContent key; a result the read plane could not name has no toolName key", () => {
    const textOnly = { type: "tool-result", toolCallId: "toolu_sign_up", content: [{ type: "text", text: "Signed up." }] };
    const [result] = threadHistoryRowsToToolResults([
      { seq: 5, at: "x", kind: "text", authorRole: "agent", text: null, toolResults: [{ toolCallId: "toolu_sign_up", block: textOnly }] },
    ]);
    expect(result).toEqual({ seq: 5, at: "x", toolCallId: "toolu_sign_up", block: textOnly });
  });

  it("drops what no writer produced: a missing id, a block that is not a tool result or names another call, a non-text row", () => {
    const row = (toolResults: ThreadHistoryRow["toolResults"], kind = "text"): ThreadHistoryRow => ({
      seq: 1,
      at: "x",
      kind,
      authorRole: "agent",
      text: null,
      toolResults,
    });
    expect(
      threadHistoryRowsToToolResults([
        row(null),
        row([{ toolName: "t", block: BLOCK }]),
        row([{ toolCallId: "", block: BLOCK }]),
        row([{ toolCallId: "toolu_open_review", block: null }]),
        row([{ toolCallId: "toolu_open_review", block: [BLOCK] }]),
        row([{ toolCallId: "toolu_open_review", block: { ...BLOCK, type: "tool-call" } }]),
        row([{ toolCallId: "another_call", block: BLOCK }]),
        row([{ toolCallId: "toolu_open_review", block: BLOCK }], "card"),
      ]),
    ).toEqual([]);
  });

  it("reads the block through AgJSON's stored reader: a block it cannot read at all drops that entry, never the list", () => {
    // A block whose own fields do not read (here `isError` is not a boolean)
    // is no tool result this client can hand on: that entry maps to nothing
    // and its neighbour still reads.
    const unreadable = { ...BLOCK, toolCallId: "toolu_broken", isError: "yes" };
    const results = threadHistoryRowsToToolResults([
      {
        seq: 3,
        at: "x",
        kind: "text",
        authorRole: "agent",
        text: null,
        toolResults: [
          { toolCallId: "toolu_broken", block: unreadable },
          { toolCallId: "toolu_open_review", block: BLOCK },
        ],
      },
    ]);
    expect(results.map((r) => r.toolCallId)).toEqual(["toolu_open_review"]);
    // Typed as the tool-result block: its fields read without a cast.
    const [first] = results;
    expect(first?.block.type).toBe("tool-result");
    expect(first?.block.outcome).toBe("ok");
    expect(first?.block.content[0]?.type).toBe("text");
  });

  it("a later release's content part, or outcome, leaves out only that part: the entry and its structuredContent stay", () => {
    // N-1 forward: a newer writer's tool result may carry a content part type,
    // or an outcome value, this client's closed sets do not hold. The stored
    // reader would omit the whole block; this reader leaves out only what it
    // cannot read, so the host still gets the result it draws from.
    const later: JsonValue = {
      ...BLOCK,
      toolCallId: "toolu_later",
      content: [{ type: "text", text: "kept" }, { type: "block-from-a-later-release", x: 1 }, { type: "text", text: "also kept" }],
      outcome: "outcome-from-a-later-release",
      laterField: { kept: true },
    };
    const [result] = threadHistoryRowsToToolResults([
      { seq: 3, at: "x", kind: "text", authorRole: "agent", text: null, toolResults: [{ toolCallId: "toolu_later", toolName: "mcp__inbox__open_review", block: later }] },
    ]);
    expect(result).toEqual({
      seq: 3,
      at: "x",
      toolCallId: "toolu_later",
      toolName: "mcp__inbox__open_review",
      block: {
        type: "tool-result",
        toolCallId: "toolu_later",
        content: [{ type: "text", text: "kept" }, { type: "text", text: "also kept" }],
        isError: false,
        structuredContent: { card: "inbox" },
        laterField: { kept: true },
      },
      structuredContent: { card: "inbox" },
    });
    // A readable outcome is kept when only a part is left out.
    const [partOnly] = threadHistoryRowsToToolResults([
      {
        seq: 4,
        at: "x",
        kind: "text",
        authorRole: "agent",
        text: null,
        toolResults: [{ toolCallId: "toolu_open_review", block: { ...BLOCK, content: [{ type: "block-from-a-later-release" }] } }],
      },
    ]);
    expect(partOnly?.block).toEqual({ ...BLOCK, content: [] });
  });

  it("a toolName that is not a string, off the wire, reads as no name", () => {
    const wire: ThreadHistoryRow[] = JSON.parse(
      JSON.stringify([{ seq: 1, at: "x", kind: "text", authorRole: "agent", text: null, toolResults: [{ toolCallId: "toolu_open_review", toolName: 7, block: BLOCK }] }]),
    );
    const [result] = threadHistoryRowsToToolResults(wire);
    expect(result?.toolCallId).toBe("toolu_open_review");
    expect(result).not.toHaveProperty("toolName");
  });
});

describe("fetchThreadHistory — includeToolResults", () => {
  it("asks the read plane only when opted in, and only then returns toolResults", async () => {
    const off = serving(NEW_ROWS);
    const plain = await fetchThreadHistory({ ...opts, fetchImpl: off });
    expect(off.mock.calls[0]?.[0]).toBe("https://api.example.com/v1/threads/t1/messages?limit=100&order=desc");
    expect("toolResults" in plain).toBe(false);

    const on = serving(NEW_ROWS);
    const asked = await fetchThreadHistory({ ...opts, includeToolResults: true, fetchImpl: on });
    expect(on.mock.calls[0]?.[0]).toBe("https://api.example.com/v1/threads/t1/messages?limit=100&order=desc&include=toolResults");
    expect("toolResults" in asked && asked.toolResults?.map((r) => r.toolName)).toEqual(["mcp__inbox__open_review"]);
    // The text transcript and the cards are what they were without the ask.
    expect({ ...asked, toolResults: undefined }).toEqual({ ...plain, toolResults: undefined });
  });

  it("the current client asking an older read plane gets toolResults: [] and nothing else changes", async () => {
    const result = await fetchThreadHistory({ ...opts, includeToolResults: true, fetchImpl: serving(OLD_ROWS) });
    const plain = await fetchThreadHistory({ ...opts, fetchImpl: serving(OLD_ROWS) });
    expect(result).toEqual({ ...plain, toolResults: [] });
  });

  it("a newest-first walk (guuey#2858) asks on every page and hands the results back ascending, gathered by seq", async () => {
    // Two desc pages, newest first, the second overlapping the first by one row
    // (a byte cut's overlap): each page asks, each result is read once.
    const pages = [
      { rows: [NEW_ROWS[3]!, NEW_ROWS[2]!], nextToken: "p2", thread: {}, order: "desc" },
      { rows: [NEW_ROWS[2]!, NEW_ROWS[1]!, NEW_ROWS[0]!], nextToken: null, thread: {}, order: "desc" },
    ];
    let page = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(pages[page++]), { status: 200 }));
    const result = await fetchThreadHistory({ ...opts, includeToolResults: true, fetchImpl });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      "https://api.example.com/v1/threads/t1/messages?limit=100&order=desc&include=toolResults",
      "https://api.example.com/v1/threads/t1/messages?limit=100&order=desc&include=toolResults&nextToken=p2",
    ]);
    expect("toolResults" in result && result.toolResults?.map((r) => [r.seq, r.toolName])).toEqual([[3, "mcp__inbox__open_review"]]);
  });

  it("a result a 3.17 card row stands for is handed back once as that card, even when a page edge splits the two", async () => {
    // The rows a 3.17 pod stored for one turn whose result named its ui://
    // locator only in _meta.ui: 3.17 minted the seq 3 card row from that
    // locator and stored the seq 2 result row with _meta stripped, so this
    // release's read plane serves seq 2's result as one with no UI resource.
    // A page that holds both leaves it out; a page edge between them cannot,
    // so the client, which holds every row, does.
    const stored = {
      type: "tool-result",
      toolCallId: "toolu_show_inbox",
      content: [{ type: "text", text: '{"items":[1,2]}' }],
      outcome: "ok",
      isError: false,
      uiData: { items: [1, 2] },
    };
    const at = "2026-10-18T10:37:00.000Z";
    const rows: ThreadHistoryRow[] = [
      { seq: 1, at, kind: "text", authorRole: "agent", text: null },
      {
        seq: 2,
        at,
        kind: "text",
        authorRole: "agent",
        text: null,
        toolResults: [{ toolCallId: "toolu_show_inbox", toolName: "mcp__inbox__show_inbox", block: stored }],
      },
      {
        seq: 3,
        at,
        kind: "card",
        authorRole: "agent",
        text: null,
        toolName: "mcp__inbox__show_inbox",
        cardSnapshot: { artifactId: "toolu_show_inbox:result#ui#0", turnId: "turn_1", threadId: "t1", parts: [stored] },
      },
      { seq: 4, at, kind: "text", authorRole: "agent", text: "Here is your inbox." },
    ];
    // Newest first, two rows a page, split between seq 3 and seq 2.
    const pages = [
      { rows: [rows[3]!, rows[2]!], nextToken: "p2", thread: {}, order: "desc" },
      { rows: [rows[1]!, rows[0]!], nextToken: null, thread: {}, order: "desc" },
    ];
    let page = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(pages[page++]), { status: 200 }));
    const result = await fetchThreadHistory({ ...opts, includeToolResults: true, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect("cards" in result && result.cards?.map((c) => c.seq)).toEqual([3]);
    expect("toolResults" in result && result.toolResults).toEqual([]);
    // The same rows handed to the projection directly read the same way.
    expect(threadHistoryRowsToToolResults(rows)).toEqual([]);
    // A card row for another call leaves this result in place.
    const otherCard = { ...rows[2]!, cardSnapshot: { artifactId: "x", turnId: "turn_1", parts: [{ ...stored, toolCallId: "toolu_other" }] } };
    expect(threadHistoryRowsToToolResults([rows[0]!, rows[1]!, otherCard, rows[3]!]).map((r) => r.toolCallId)).toEqual(["toolu_show_inbox"]);
  });

  it("tool results survive a fetch from another JS realm, like the cards beside them", async () => {
    // A fetch from another realm (Node's fetch under a jsdom suite, a vm or SSR
    // host) builds `res.json()` on that realm's Object.prototype; the walk
    // parses the page from its text, so the block still reads as JSON here.
    const body = JSON.stringify({ rows: NEW_ROWS, nextToken: null, thread: {} });
    const res = new Response(body, { status: 200 });
    Object.defineProperty(res, "json", { value: async () => runInNewContext(`(${body})`) });
    const result = await fetchThreadHistory({ ...opts, includeToolResults: true, fetchImpl: vi.fn(async () => res) });
    expect("toolResults" in result && result.toolResults).toEqual([
      {
        seq: 3,
        at: "2026-10-18T10:37:02Z",
        toolCallId: "toolu_open_review",
        toolName: "mcp__inbox__open_review",
        block: BLOCK,
        structuredContent: { card: "inbox" },
      },
    ]);
  });

  it("an older client reads a newer read plane's rows carrying tool results exactly as it read the older rows", async () => {
    const fromNew = await fetchThreadHistoryPrev({ ...opts, fetchImpl: serving(NEW_ROWS) });
    const fromOld = await fetchThreadHistoryPrev({ ...opts, fetchImpl: serving(OLD_ROWS) });
    expect(fromNew).toEqual(fromOld);
  });
});
