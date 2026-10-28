/**
 * guuey#2858 — the history read asks for newest-first pages, so a thread
 * longer than the page cap loses its OLDEST rows (and says so), never the
 * newest. Both directions of a rolling release:
 *
 * - a read plane that predates `?order=desc` serves ascending pages and no
 *   `order` echo: page 1 is page 1 of the ascending read, at no extra cost;
 * - a read plane that stops honouring it mid-read (a rollback) loses the echo:
 *   what was read is discarded and the thread is read again ascending.
 *
 * The fake read plane below pages a stored thread the way the route does:
 * `limit`, `nextToken` = the last served seq, newest-first only when it
 * honours `order=desc` (`honoursOrder`), and the echo only then.
 *
 * RED controls: never send `order=desc` and the newest-first cases fail;
 * trust the order of the pages instead of sorting by seq and the transcript
 * comes back reversed; drop the echo check and the rollback case serves a
 * mixed transcript; set `truncated` from the page count alone and a thread
 * that ends exactly on the cap reads as truncated.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchThreadHistory, readThreadHistoryRow, readThreadMessagesPage, type ThreadHistoryRow } from "./history.js";

function stored(seq: number, over: Partial<ThreadHistoryRow> = {}): ThreadHistoryRow {
  return {
    seq,
    at: `2026-10-28T00:00:${String(seq % 60).padStart(2, "0")}Z`,
    kind: "text",
    authorRole: seq % 2 === 1 ? "user" : "agent",
    text: `m${seq}`,
    ...over,
  };
}

interface FakeReadPlane {
  fetchImpl: typeof fetch;
  urls: string[];
}

/**
 * A read plane over `rows` (ascending by seq) serving `pageSize` rows a page.
 * `honoursOrder(callIndex)` decides, per request, whether this deployment knows
 * `order=desc` (a rollback flips it mid-read).
 */
function readPlane(rows: ThreadHistoryRow[], pageSize: number, honoursOrder: (call: number) => boolean): FakeReadPlane {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const desc = honoursOrder(urls.length - 1) && url.searchParams.get("order") === "desc";
    const token = url.searchParams.get("nextToken");
    const after = token === null ? undefined : Number(token);
    const ordered = desc ? [...rows].reverse() : rows;
    const rest = ordered.filter((r) => after === undefined || (desc ? r.seq < after : r.seq > after));
    const page = rest.slice(0, pageSize);
    const last = page[page.length - 1];
    const body = {
      rows: page,
      nextToken: rest.length > page.length && last !== undefined ? String(last.seq) : null,
      thread: {},
      ...(desc ? { order: "desc" } : {}),
    };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { fetchImpl, urls };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const seqs = (result: Awaited<ReturnType<typeof fetchThreadHistory>>): number[] =>
  "messages" in result ? result.messages.map((m) => m.seq ?? -1) : [];

const opts = { baseUrl: "https://api.example.com/v1", threadId: "t1" };

describe("fetchThreadHistory — newest-first (guuey#2858)", () => {
  it("a long thread past the cap keeps its NEWEST rows, ascending, and says it is truncated", async () => {
    const plane = readPlane(range(1, 40).map((n) => stored(n)), 3, () => true);
    const result = await fetchThreadHistory({ ...opts, fetchImpl: plane.fetchImpl });
    expect(seqs(result)).toEqual(range(11, 40));
    expect("truncated" in result && result.truncated).toBe(true);
    // The order rides beside `truncated`: the rows left out are the OLDEST.
    expect("order" in result && result.order).toBe("desc");
    expect(plane.urls).toHaveLength(10);
    for (const url of plane.urls) expect(url).toContain("order=desc");
  });

  it("a thread that ends exactly on the cap is whole: not truncated", async () => {
    const plane = readPlane(range(1, 30).map((n) => stored(n)), 3, () => true);
    const result = await fetchThreadHistory({ ...opts, fetchImpl: plane.fetchImpl });
    expect(seqs(result)).toEqual(range(1, 30));
    expect(result).not.toHaveProperty("truncated");
    expect(result).not.toHaveProperty("order");
  });

  it("a short thread reads whole in one page, ascending, with no truncated key", async () => {
    const plane = readPlane(range(1, 4).map((n) => stored(n)), 100, () => true);
    const result = await fetchThreadHistory({ ...opts, fetchImpl: plane.fetchImpl });
    expect(seqs(result)).toEqual([1, 2, 3, 4]);
    expect(result).not.toHaveProperty("truncated");
    expect(plane.urls).toEqual(["https://api.example.com/v1/threads/t1/messages?limit=100&order=desc"]);
  });

  it("an older read plane (no echo): read ascending exactly as before, page 1 reused, the cap dropping the newest", async () => {
    const plane = readPlane(range(1, 40).map((n) => stored(n)), 3, () => false);
    const result = await fetchThreadHistory({ ...opts, fetchImpl: plane.fetchImpl });
    expect(seqs(result)).toEqual(range(1, 30));
    expect("truncated" in result && result.truncated).toBe(true);
    // The rows left out are the NEWEST: the reader says the read was ascending.
    expect("order" in result && result.order).toBe("asc");
    expect(plane.urls).toHaveLength(10);
    expect(plane.urls[0]).toContain("order=desc");
    for (const url of plane.urls.slice(1)) expect(url).not.toContain("order=");
  });

  it("a rollback mid-read (the echo disappears): the newest-first rows are discarded and the thread is read again ascending", async () => {
    // Pages 1–2 are served by the new deployment, then the old one answers.
    const plane = readPlane(range(1, 12).map((n) => stored(n)), 3, (call) => call < 2);
    const result = await fetchThreadHistory({ ...opts, fetchImpl: plane.fetchImpl });
    expect(seqs(result)).toEqual(range(1, 12));
    expect(result).not.toHaveProperty("truncated");
    // Two desc pages, the page that lost the echo, then a fresh ascending walk of 4 pages.
    expect(plane.urls).toHaveLength(7);
    expect(plane.urls.slice(3).every((u) => !u.includes("order="))).toBe(true);
    expect(new URL(plane.urls[3] ?? "").searchParams.has("nextToken")).toBe(false);
  });

  it("a row served twice (an overlap after a byte cut) is one row", async () => {
    const pages = [
      { rows: [stored(4), stored(3)], nextToken: "x", thread: {}, order: "desc" },
      { rows: [stored(3), stored(2), stored(1)], nextToken: null, thread: {}, order: "desc" },
    ];
    let call = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(pages[call++]), { status: 200 }));
    const result = await fetchThreadHistory({ ...opts, fetchImpl });
    expect(seqs(result)).toEqual([1, 2, 3, 4]);
  });

  it("an older read plane's closure is read from the NEWEST row of a truncated newest-first read", async () => {
    const closing = stored(40, { authorRole: "agent", text: "This chat is full.", failure: { code: "app:CHAT_FULL" } });
    const rows = [...range(1, 39).map((n) => stored(n)), closing];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const token = url.searchParams.get("nextToken");
      const below = token === null ? Infinity : Number(token);
      const page = [...rows].reverse().filter((r) => r.seq < below).slice(0, 3);
      const last = page[page.length - 1];
      // No `thread` field, so the closure is read from the last row: after the
      // sort by seq that is the newest row, whatever order the pages came in.
      return new Response(JSON.stringify({ rows: page, nextToken: last && last.seq > 1 ? String(last.seq) : null, order: "desc" }), { status: 200 });
    });
    const result = await fetchThreadHistory({ ...opts, fetchImpl });
    expect("closed" in result && result.closed).toEqual({ code: "app:CHAT_FULL", message: "This chat is full.", closedAt: null });
  });

  it("a body that is not a page is a thrown load failure, never an empty transcript", async () => {
    for (const body of [null, [], { rows: "x", nextToken: null }, { rows: [], nextToken: 7 }]) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
      await expect(fetchThreadHistory({ ...opts, fetchImpl })).rejects.toThrow(/malformed page/);
    }
  });
});

describe("readThreadMessagesPage / readThreadHistoryRow — the body is proved, never asserted", () => {
  it("reads a page: rows, token, the thread's state and the order echo", () => {
    const page = readThreadMessagesPage({
      rows: [stored(2), stored(1)],
      nextToken: "tok",
      thread: { closed: { code: "X", message: "bye", closedAt: "2026-10-28T00:00:00Z" } },
      order: "desc",
    });
    expect(page).toEqual({
      rows: [stored(2), stored(1)],
      nextToken: "tok",
      threadSeen: true,
      closed: { code: "X", message: "bye", closedAt: "2026-10-28T00:00:00Z" },
      newestFirst: true,
    });
  });

  it("an older body (no thread, no order, no nextToken key) reads as ascending with no thread state", () => {
    expect(readThreadMessagesPage({ rows: [] })).toEqual({
      rows: [],
      nextToken: null,
      threadSeen: false,
      closed: undefined,
      newestFirst: false,
    });
    expect(readThreadMessagesPage({ rows: [], nextToken: null, order: "asc" })?.newestFirst).toBe(false);
  });

  it("a row without its placing fields is left out; the others are kept", () => {
    const page = readThreadMessagesPage({
      rows: [stored(1), { seq: "2", at: "a", kind: "text", authorRole: "user", text: "x" }, { seq: 3 }, 4, stored(5)],
      nextToken: null,
    });
    expect(page?.rows.map((r) => r.seq)).toEqual([1, 5]);
  });

  it("each optional field is kept only in its own shape", () => {
    expect(
      readThreadHistoryRow({
        ...stored(1),
        cardSnapshot: { a: [1, { b: null }] },
        toolName: 7,
        narration: ["one", 2, "three"],
        failure: { code: 5 },
        notice: { source: "framework" },
        tapLabels: ["a", 1],
        clientMessageId: "cm-1",
        inputKind: null,
        unknownField: true,
      }),
    ).toEqual({
      ...stored(1),
      cardSnapshot: { a: [1, { b: null }] },
      narration: ["one", "three"],
      failure: {},
      notice: { source: "framework" },
      clientMessageId: "cm-1",
      inputKind: null,
    });
  });
});
