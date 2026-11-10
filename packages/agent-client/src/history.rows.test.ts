/**
 * `fetchThreadHistoryRows` (guuey#2388): the transcript read stopped at the
 * rows, for a host that keeps its own message shape. It is the same walk as
 * `fetchThreadHistory` (one walker for the route): the same request, the same
 * echo rules, the same errors. These tests pin that sameness and what the rows
 * result adds: the status on `gone`, and the calls echo as a flag beside rows
 * kept as served.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fetchThreadHistory,
  fetchThreadHistoryRows,
  HistoryUnauthorizedError,
  threadHistoryRowsToMessages,
  threadHistoryRowsToToolCalls,
  threadHistoryRowsToToolResults,
  type ThreadHistoryRow,
  type ThreadHistoryRowsResult,
} from "./history.js";

const BASE = "https://api.example.com/v1";
const ROUTE = `${BASE}/threads/t1/messages`;
const ASKED = { baseUrl: BASE, threadId: "t1", includeToolResults: true, includeToolCalls: true };

function pages(...bodies: string[]) {
  let i = 0;
  return vi.fn(async (_url: string | URL | Request) => {
    const body = bodies[i++];
    if (body === undefined) throw new Error("pages: no body queued");
    return new Response(body, { status: 200 });
  });
}

function status(code: number) {
  return vi.fn(async (_url: string | URL | Request) => new Response("{}", { status: code }));
}

function textRow(seq: number, extra: Partial<ThreadHistoryRow> = {}): ThreadHistoryRow {
  return { seq, at: `2026-10-28T00:00:0${seq}.000Z`, kind: "text", authorRole: "agent", text: null, ...extra };
}

const FIND = { toolCallId: "toolu_find", name: "mcp__travel__find_flights", input: { from: "ICN", to: "SFO" } };
const LATE = { ...FIND, toolCallId: "toolu_late" };
const RESULT = { toolCallId: "toolu_find", toolName: "mcp__travel__find_flights", block: { type: "tool-result", toolCallId: "toolu_find", content: [] } };
const newest = { rows: [textRow(4, { toolCalls: [LATE] })], nextToken: "p2", thread: {}, order: "desc" };
const oldest = { rows: [textRow(2, { toolCalls: [FIND], toolResults: [RESULT] })], nextToken: null, thread: {}, order: "desc" };
const BOTH = ["toolResults", "toolCalls"];

describe("fetchThreadHistoryRows — the read, stopped at the rows", () => {
  it("asks what fetchThreadHistory asks, page for page", async () => {
    const rowsFetch = pages(JSON.stringify({ ...newest, include: BOTH }), JSON.stringify({ ...oldest, include: BOTH }));
    const loadFetch = pages(JSON.stringify({ ...newest, include: BOTH }), JSON.stringify({ ...oldest, include: BOTH }));
    await fetchThreadHistoryRows({ ...ASKED, fetchImpl: rowsFetch });
    await fetchThreadHistory({ ...ASKED, fetchImpl: loadFetch });
    expect(rowsFetch.mock.calls.map((c) => String(c[0]))).toEqual([
      `${ROUTE}?limit=100&order=desc&include=toolResults,toolCalls`,
      `${ROUTE}?limit=100&order=desc&include=toolResults,toolCalls&nextToken=p2`,
    ]);
    expect(rowsFetch.mock.calls.map((c) => String(c[0]))).toEqual(loadFetch.mock.calls.map((c) => String(c[0])));
  });

  it("every page echoes toolCalls: the rows ascending, as served, and the calls honoured", async () => {
    const fetchImpl = pages(JSON.stringify({ ...newest, include: BOTH }), JSON.stringify({ ...oldest, include: BOTH }));
    const read = await fetchThreadHistoryRows({ ...ASKED, fetchImpl });
    if ("gone" in read) throw new Error("expected rows");
    expect(read.toolCallsHonoured).toBe(true);
    expect(read.rows.map((r) => r.seq)).toEqual([2, 4]);
    expect(read.rows[0]?.toolCalls).toEqual([FIND]);
    expect(read.rows[0]?.toolResults).toEqual([RESULT]);
    expect("truncated" in read).toBe(false);
  });

  it("a page loses the echo: the calls are not honoured, and the rows still come back as served", async () => {
    const fetchImpl = pages(JSON.stringify({ ...newest, include: BOTH }), JSON.stringify(oldest));
    const read = await fetchThreadHistoryRows({ ...ASKED, fetchImpl });
    if ("gone" in read) throw new Error("expected rows");
    expect(read.toolCallsHonoured).toBe(false);
    expect(read.rows.map((r) => r.seq)).toEqual([2, 4]);
  });

  it("not asked: the calls are never honoured, whatever a page echoes", async () => {
    const fetchImpl = pages(JSON.stringify({ ...oldest, include: BOTH }));
    const read = await fetchThreadHistoryRows({ baseUrl: BASE, threadId: "t1", fetchImpl });
    if ("gone" in read) throw new Error("expected rows");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${ROUTE}?limit=100&order=desc`);
    expect(read.toolCallsHonoured).toBe(false);
  });

  it("403 and 404 are gone, with the status; fetchThreadHistory's gone is unchanged", async () => {
    for (const code of [403, 404] as const) {
      expect(await fetchThreadHistoryRows({ ...ASKED, fetchImpl: status(code) })).toEqual({ gone: code });
      expect(await fetchThreadHistory({ ...ASKED, fetchImpl: status(code) })).toEqual({ gone: true });
    }
  });

  it("401 and any other failure throw as fetchThreadHistory throws", async () => {
    await expect(fetchThreadHistoryRows({ ...ASKED, fetchImpl: status(401) })).rejects.toBeInstanceOf(HistoryUnauthorizedError);
    await expect(fetchThreadHistoryRows({ ...ASKED, fetchImpl: status(500) })).rejects.toThrow("history load failed: 500");
    await expect(fetchThreadHistoryRows({ ...ASKED, fetchImpl: pages(JSON.stringify({ nope: true })) })).rejects.toThrow(
      "history load failed: the read plane returned a malformed page",
    );
  });

  it("a capped read says it was capped, and which end it kept", async () => {
    const bodies = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ rows: [textRow(100 - i)], nextToken: `p${i + 2}`, thread: {}, order: "desc" }),
    );
    const read = await fetchThreadHistoryRows({ ...ASKED, fetchImpl: pages(...bodies) });
    if ("gone" in read) throw new Error("expected rows");
    expect(read.truncated).toBe(true);
    expect(read.order).toBe("desc");
    expect(read.rows).toHaveLength(10);
  });
});

describe("fetchThreadHistoryRows and fetchThreadHistory settle every walk alike", () => {
  // The two reads settle the walk in their own code (see readHistory's note),
  // so each outcome is read both ways and the rows result, projected, must be
  // fetchThreadHistory's result.
  function project(read: ThreadHistoryRowsResult) {
    if ("gone" in read) return { gone: true };
    const { rows, toolCallsHonoured, ...tail } = read;
    return {
      messages: threadHistoryRowsToMessages(rows),
      toolResults: threadHistoryRowsToToolResults(rows),
      ...(toolCallsHonoured ? { toolCalls: threadHistoryRowsToToolCalls(rows) } : {}),
      ...tail,
    };
  }
  const closedThread = {
    rows: [textRow(1, { text: "bye" })],
    nextToken: null,
    thread: { closed: { code: "app:done", message: "That is all for today.", closedAt: "2026-10-28T00:00:09.000Z" } },
    order: "desc",
  };
  const capped = Array.from({ length: 10 }, (_, i) =>
    JSON.stringify({ rows: [textRow(100 - i)], nextToken: `p${i + 2}`, thread: {}, order: "desc", include: BOTH }),
  );
  const OUTCOMES: Array<[string, () => ReturnType<typeof pages> | ReturnType<typeof status>]> = [
    ["every page echoes", () => pages(JSON.stringify({ ...newest, include: BOTH }), JSON.stringify({ ...oldest, include: BOTH }))],
    ["a page loses the calls echo", () => pages(JSON.stringify({ ...newest, include: BOTH }), JSON.stringify(oldest))],
    [
      "a rollback mid-read: read again ascending",
      () =>
        pages(
          JSON.stringify({ ...newest, include: BOTH }),
          JSON.stringify({ rows: [textRow(3)], nextToken: "b", thread: {}, include: BOTH }),
          JSON.stringify({ rows: [textRow(2), textRow(3)], nextToken: "c", thread: {}, include: BOTH }),
          JSON.stringify({ rows: [textRow(4)], nextToken: null, thread: {}, include: BOTH }),
        ),
    ],
    [
      "an older read plane: no order, no thread, closure from the last row",
      () => pages(JSON.stringify({ rows: [textRow(1), textRow(2, { text: "That is all for today.", failure: { code: "app:done" } })], nextToken: null })),
    ],
    ["a closed thread", () => pages(JSON.stringify(closedThread))],
    ["the page cap", () => pages(...capped)],
    ["gone (404)", () => status(404)],
  ];
  it.each(OUTCOMES)("%s", async (_label, make) => {
    const rows = await fetchThreadHistoryRows({ ...ASKED, fetchImpl: make() });
    const load = await fetchThreadHistory({ ...ASKED, fetchImpl: make() });
    expect(project(rows)).toEqual(load);
  });

  it("the closure cases read a closure at all (the fixtures are live)", async () => {
    for (const make of [() => pages(JSON.stringify(closedThread)), OUTCOMES[3]![1]]) {
      const load = await fetchThreadHistory({ ...ASKED, fetchImpl: make() });
      expect("closed" in load && load.closed?.code).toBe("app:done");
    }
  });
});
