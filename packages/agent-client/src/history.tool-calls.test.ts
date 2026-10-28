/**
 * Stored tool calls, rehydrated from the transcript read (guuey#2388), so a
 * reload can draw the tool rows the live session drew.
 *
 * The read serves them only when asked (`include=toolCalls`), and says it did
 * with an `include` echo on the page. The client draws them only when EVERY
 * page of its walk carried that echo: no echo means none, which is the reload
 * the kit draws today. Across a rolling release, both directions:
 * - this client asking a read plane that predates calls (it serves results,
 *   skips the unknown `toolCalls` entry and sends no echo) gets no calls;
 * - a client that asks for results alone sends #2487's request byte for byte,
 *   and is answered #2487's body.
 *
 * The bodies are the read plane's own recorded envelopes for one thread
 * (`thread-history-tool-envelopes.json`, beside the route that serves them),
 * so the client reads the same bytes the server pins. A consumer's installed
 * copy has no monorepo around it, and those cases skip there.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import {
  fetchThreadHistory,
  threadHistoryRowsToToolCalls,
  TOOL_CALLS_INCLUDE,
  type ThreadHistoryRow,
} from "./history.js";
import type { HistoryLoadResult, HistoryToolCall } from "./types.js";

const BASE = "https://api.example.com/v1";
const ROUTE = `${BASE}/threads/t1/messages`;
const opts = { baseUrl: BASE, threadId: "t1", includeCards: true };

type Transcript = Extract<HistoryLoadResult, { messages: unknown }>;

function transcript(result: HistoryLoadResult): Transcript {
  if ("gone" in result) throw new Error("expected a transcript, got gone");
  return result;
}

/** A fetch that answers each call with the next body, recording the URLs asked. */
function pages(...bodies: string[]) {
  let i = 0;
  return vi.fn(async (_url: string | URL | Request) => {
    const body = bodies[i++];
    if (body === undefined) throw new Error("pages: no body queued");
    return new Response(body, { status: 200 });
  });
}

function urlsOf(fetchImpl: ReturnType<typeof pages>): string[] {
  return fetchImpl.mock.calls.map((call) => String(call[0]));
}

function textRow(seq: number, extra: Partial<ThreadHistoryRow> = {}): ThreadHistoryRow {
  return { seq, at: `2026-10-28T00:00:0${seq}.000Z`, kind: "text", authorRole: "agent", text: null, ...extra };
}

const FIND = { toolCallId: "toolu_find", name: "mcp__travel__find_flights", input: { from: "ICN", to: "SFO" }, title: "Find flights" };

describe("threadHistoryRowsToToolCalls — the lenient reader", () => {
  it("reads each entry field by field, in block order, with its row's position", () => {
    const calls = threadHistoryRowsToToolCalls([
      textRow(2, { toolCalls: [FIND, { toolCallId: "toolu_map", name: "mcp__maps__show_city", input: { city: "SFO" } }] }),
    ]);
    expect(calls).toEqual([
      { seq: 2, at: "2026-10-28T00:00:02.000Z", call: { toolCallId: "toolu_find", name: "mcp__travel__find_flights", title: "Find flights", input: { from: "ICN", to: "SFO" } } },
      { seq: 2, at: "2026-10-28T00:00:02.000Z", call: { toolCallId: "toolu_map", name: "mcp__maps__show_city", input: { city: "SFO" } } },
    ]);
  });

  it("a malformed entry is dropped alone: its neighbours and its row stay", () => {
    const malformed: JsonValue[] = [
      "not an object",
      null,
      [FIND],
      { name: "no_id", input: {} },
      { toolCallId: "", name: "empty_id", input: {} },
      { toolCallId: "toolu_no_name", input: {} },
      { toolCallId: "toolu_empty_name", name: "", input: {} },
      { toolCallId: "toolu_no_input", name: "t" },
      { toolCallId: "toolu_bad_title", name: "t", input: {}, title: 7 },
    ];
    const calls = threadHistoryRowsToToolCalls([
      textRow(2, { toolCalls: [malformed[0]!, FIND, ...malformed.slice(1), { toolCallId: "toolu_last", name: "t", input: null }] }),
    ]);
    expect(calls.map((c) => c.call.toolCallId)).toEqual(["toolu_find", "toolu_last"]);
    expect(calls[1]?.call.input).toBeNull();
  });

  it("a call carrying fields this client does not know (a later uiVisibility value, toolMetadata, any key) still yields", () => {
    const later = { ...FIND, uiVisibility: ["a-later-audience"], toolMetadata: { x: 1 }, providerExecuted: "later", laterField: true };
    const [call] = threadHistoryRowsToToolCalls([textRow(2, { toolCalls: [later] })]);
    expect(call?.call).toEqual({ toolCallId: "toolu_find", name: "mcp__travel__find_flights", title: "Find flights", input: { from: "ICN", to: "SFO" } });
  });

  it("reads calls on text rows only; a duplicate toolCallId keeps the first, as live does", () => {
    const calls = threadHistoryRowsToToolCalls([
      textRow(2, { toolCalls: [FIND] }),
      { ...textRow(3, { toolCalls: [{ ...FIND, toolCallId: "toolu_on_card" }] }), kind: "card" },
      textRow(4, { toolCalls: [{ ...FIND, name: "a_second_copy" }] }),
      textRow(5, { toolCalls: null }),
    ]);
    expect(calls.map((c) => [c.seq, c.call.name])).toEqual([[2, "mcp__travel__find_flights"]]);
  });
});

describe("fetchThreadHistory — the include ask, one param at both options", () => {
  const plain = JSON.stringify({ rows: [], nextToken: null, thread: {} });
  const cases: { name: string; options: { includeToolResults?: boolean; includeToolCalls?: boolean }; include: string | null }[] = [
    { name: "neither (the default)", options: {}, include: null },
    { name: "off + off", options: { includeToolResults: false, includeToolCalls: false }, include: null },
    { name: "results only: #2487's request, byte for byte", options: { includeToolResults: true }, include: "toolResults" },
    { name: "calls only", options: { includeToolCalls: true }, include: "toolCalls" },
    { name: "both, comma-joined, results first", options: { includeToolResults: true, includeToolCalls: true }, include: "toolResults,toolCalls" },
  ];
  it.each(cases)("$name", async ({ options, include }) => {
    const fetchImpl = pages(plain);
    const result = transcript(await fetchThreadHistory({ ...opts, ...options, fetchImpl }));
    expect(urlsOf(fetchImpl)).toEqual([`${ROUTE}?limit=100&order=desc${include === null ? "" : `&include=${include}`}`]);
    expect("toolResults" in result).toBe(options.includeToolResults === true);
    // No echo on this page: calls are never served, whatever was asked.
    expect("toolCalls" in result).toBe(false);
  });

  it("names the include value it asks by", () => {
    expect(TOOL_CALLS_INCLUDE).toBe("toolCalls");
  });
});

describe("fetchThreadHistory — the one honoured set (order and toolCalls)", () => {
  const ASKED = { ...opts, includeToolResults: true, includeToolCalls: true };
  const newest = { rows: [textRow(4, { toolCalls: [{ ...FIND, toolCallId: "toolu_late" }] })], nextToken: "p2", thread: {}, order: "desc" };
  const oldest = { rows: [textRow(2, { toolCalls: [FIND] })], nextToken: null, thread: {}, order: "desc" };

  it("every page echoes toolCalls: the calls of the whole walk, ascending", async () => {
    const fetchImpl = pages(JSON.stringify({ ...newest, include: ["toolCalls", "toolResults"] }), JSON.stringify({ ...oldest, include: ["toolCalls", "toolResults"] }));
    const result = transcript(await fetchThreadHistory({ ...ASKED, fetchImpl }));
    expect(urlsOf(fetchImpl)).toEqual([
      `${ROUTE}?limit=100&order=desc&include=toolResults,toolCalls`,
      `${ROUTE}?limit=100&order=desc&include=toolResults,toolCalls&nextToken=p2`,
    ]);
    expect(result.toolCalls?.map((c) => [c.seq, c.call.toolCallId])).toEqual([[2, "toolu_find"], [4, "toolu_late"]]);
  });

  it("a later page loses the echo (a rollback mid-read): no calls at all, never a partial list; results are #2487's", async () => {
    const fetchImpl = pages(JSON.stringify({ ...newest, include: ["toolCalls", "toolResults"] }), JSON.stringify(oldest));
    const result = transcript(await fetchThreadHistory({ ...ASKED, fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect("toolCalls" in result).toBe(false);
    expect(result.toolResults).toEqual([]);
  });

  it("page 1 without the echo: no calls, even when a later page echoes", async () => {
    const fetchImpl = pages(JSON.stringify(newest), JSON.stringify({ ...oldest, include: ["toolCalls"] }));
    const result = transcript(await fetchThreadHistory({ ...ASKED, fetchImpl }));
    expect("toolCalls" in result).toBe(false);
  });

  it("an echo that is not a list of strings reads as no echo", async () => {
    for (const include of ["toolCalls", { toolCalls: true }, null]) {
      const fetchImpl = pages(JSON.stringify({ ...oldest, include }));
      const result = transcript(await fetchThreadHistory({ ...ASKED, fetchImpl }));
      expect("toolCalls" in result).toBe(false);
    }
  });

  it("the order member restarts the walk ascending, and that walk decides toolCalls afresh", async () => {
    // Page 2 keeps the toolCalls echo but loses the order: the walk is read
    // again ascending, and the calls are those of the second walk.
    const fetchImpl = pages(
      JSON.stringify({ ...newest, include: ["toolCalls"] }),
      JSON.stringify({ ...oldest, order: undefined, include: ["toolCalls"] }),
      JSON.stringify({ rows: [oldest.rows[0], newest.rows[0]], nextToken: null, thread: {}, include: ["toolCalls"] }),
    );
    const result = transcript(await fetchThreadHistory({ ...ASKED, fetchImpl }));
    expect(urlsOf(fetchImpl)[2]).toBe(`${ROUTE}?limit=100&include=toolResults,toolCalls`);
    expect(result.toolCalls?.map((c) => c.call.toolCallId)).toEqual(["toolu_find", "toolu_late"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// The read plane's recorded envelopes, read by this client.
// ─────────────────────────────────────────────────────────────────────

function repoPath(relativeToThisFile: string): string {
  return fileURLToPath(new URL(relativeToThisFile, import.meta.url));
}

const ENVELOPES = repoPath("../../../../backend/amplify/functions/publicApi/fixtures/thread-history-tool-envelopes.json");
const haveEnvelopes = existsSync(ENVELOPES);

interface EnvelopeCase {
  include: string | undefined;
  body: string;
}

/** The fixture's cases, narrowed field by field: `{ query: { include? }, body }` per ask, the body as served text. */
function readEnvelopes(): EnvelopeCase[] {
  const raw: unknown = JSON.parse(readFileSync(ENVELOPES, "utf8"));
  if (typeof raw !== "object" || raw === null || !("cases" in raw) || !Array.isArray(raw.cases)) throw new Error("envelopes: no cases");
  return raw.cases.map((c: unknown): EnvelopeCase => {
    if (typeof c !== "object" || c === null || !("query" in c) || !("body" in c) || typeof c.body !== "object" || c.body === null) {
      throw new Error("envelopes: bad case");
    }
    const query = c.query;
    const include = typeof query === "object" && query !== null && "include" in query && typeof query.include === "string" ? query.include : undefined;
    // The route serves the recorded body as its JSON text.
    return { include, body: JSON.stringify(c.body) };
  });
}

describe.skipIf(!haveEnvelopes)("the recorded envelopes, both directions", () => {
  const envelopes = haveEnvelopes ? readEnvelopes() : [];
  const bodyFor = (include: string | undefined): string => {
    const found = envelopes.find((e) => e.include === include);
    if (!found) throw new Error(`envelopes: no case for include=${String(include)}`);
    return found.body;
  };
  const includeOf = (url: string | URL | Request): string | undefined => new URL(String(url)).searchParams.get("include") ?? undefined;
  /** The L0 route: each ask answered by its recorded body. */
  const l0Route = vi.fn(async (url: string | URL | Request) => new Response(bodyFor(includeOf(url)), { status: 200 }));
  /** The #2487 route: `toolResults` honoured, any other entry skipped, never an echo. */
  const route2487 = vi.fn(async (url: string | URL | Request) =>
    new Response(bodyFor((includeOf(url) ?? "").split(",").includes("toolResults") ? "toolResults" : undefined), { status: 200 }),
  );

  const BOOK_INPUT = { "com.guuey/elided": { bytes: 400000 } };
  const EXPECTED_CALLS: HistoryToolCall[] = [
    { seq: 2, at: "2026-10-28T00:00:02.000Z", call: { toolCallId: "toolu_find", name: "mcp__travel__find_flights", title: "Find flights", input: { from: "ICN", to: "SFO" } } },
    {
      seq: 2,
      at: "2026-10-28T00:00:02.000Z",
      call: { toolCallId: "toolu_map", name: "mcp__maps__show_city", input: { city: "SFO" } },
      card: {
        seq: 5,
        result: { type: "tool-result", toolCallId: "toolu_map", content: [], outcome: "ok", isError: false, structuredContent: { resourceUri: "ui://maps/city/1" } },
      },
    },
    { seq: 6, at: "2026-10-28T00:00:06.000Z", call: { toolCallId: "toolu_book", name: "mcp__travel__book", input: BOOK_INPUT } },
  ];

  it("L0 client × L0 route: both asked, the calls are served, a carded call carries its card", async () => {
    l0Route.mockClear();
    const result = transcript(await fetchThreadHistory({ ...opts, includeToolResults: true, includeToolCalls: true, fetchImpl: l0Route }));
    expect(urlsOf(l0Route)).toEqual([`${ROUTE}?limit=100&order=desc&include=toolResults,toolCalls`]);
    expect(result.toolCalls).toEqual(EXPECTED_CALLS);
    expect(result.toolResults?.map((r) => r.toolCallId)).toEqual(["toolu_find", "toolu_book"]);
  });

  it("L0 client × #2487 route: no echo, so no calls; the results are #2487's exactly", async () => {
    route2487.mockClear();
    const both = transcript(await fetchThreadHistory({ ...opts, includeToolResults: true, includeToolCalls: true, fetchImpl: route2487 }));
    const resultsOnly = transcript(await fetchThreadHistory({ ...opts, includeToolResults: true, fetchImpl: l0Route }));
    expect(String(route2487.mock.calls[0]?.[0])).toBe(`${ROUTE}?limit=100&order=desc&include=toolResults,toolCalls`);
    expect("toolCalls" in both).toBe(false);
    expect(both).toEqual(resultsOnly);
  });

  it("a page carrying toolCalls rows WITHOUT the echo yields no calls", async () => {
    const raw: unknown = JSON.parse(bodyFor("toolResults,toolCalls"));
    if (typeof raw !== "object" || raw === null) throw new Error("envelopes: bad body");
    const { include: _echo, ...unechoed } = { include: undefined, ...raw };
    const result = transcript(await fetchThreadHistory({ ...opts, includeToolResults: true, includeToolCalls: true, fetchImpl: pages(JSON.stringify(unechoed)) }));
    expect(JSON.stringify(unechoed)).toContain('"toolCalls":[');
    expect("toolCalls" in result).toBe(false);
  });

  it("#2487-shaped client × L0 route: results alone asks include=toolResults and nothing else, and reads #2487's body", async () => {
    l0Route.mockClear();
    const result = transcript(await fetchThreadHistory({ ...opts, includeToolResults: true, fetchImpl: l0Route }));
    expect(urlsOf(l0Route)).toEqual([`${ROUTE}?limit=100&order=desc&include=toolResults`]);
    expect("toolCalls" in result).toBe(false);
    expect(result.toolResults?.map((r) => [r.seq, r.toolCallId])).toEqual([[3, "toolu_find"], [7, "toolu_book"]]);
  });

  it("calls alone: the calls, with no results key", async () => {
    l0Route.mockClear();
    const result = transcript(await fetchThreadHistory({ ...opts, includeToolCalls: true, fetchImpl: l0Route }));
    expect(urlsOf(l0Route)).toEqual([`${ROUTE}?limit=100&order=desc&include=toolCalls`]);
    expect(result.toolCalls).toEqual(EXPECTED_CALLS);
    expect("toolResults" in result).toBe(false);
  });

  it("across a page edge: every page echoes → the calls, and the carded call's card pairs from the other page; one page loses it → none", async () => {
    const raw: unknown = JSON.parse(bodyFor("toolResults,toolCalls"));
    if (typeof raw !== "object" || raw === null || !("rows" in raw) || !Array.isArray(raw.rows)) throw new Error("envelopes: bad body");
    const rows: unknown[] = raw.rows;
    const newestPage = { rows: rows.slice(4).reverse(), nextToken: "p2", thread: {}, order: "desc", include: ["toolCalls", "toolResults"] };
    const oldestPage = { rows: rows.slice(0, 4).reverse(), nextToken: null, thread: {}, order: "desc", include: ["toolCalls", "toolResults"] };
    const whole = transcript(
      await fetchThreadHistory({ ...opts, includeToolResults: true, includeToolCalls: true, fetchImpl: pages(JSON.stringify(newestPage), JSON.stringify(oldestPage)) }),
    );
    expect(whole.toolCalls).toEqual(EXPECTED_CALLS);
    const { include: _lost, ...lostPage } = oldestPage;
    const partial = transcript(
      await fetchThreadHistory({ ...opts, includeToolResults: true, includeToolCalls: true, fetchImpl: pages(JSON.stringify(newestPage), JSON.stringify(lostPage)) }),
    );
    expect("toolCalls" in partial).toBe(false);
    expect(partial.toolResults).toEqual(whole.toolResults);
  });
});
