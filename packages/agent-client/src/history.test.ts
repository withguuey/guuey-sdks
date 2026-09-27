import { describe, it, expect, vi } from "vitest";
import {
  fetchThreadHistory,
  threadHistoryRowsToMessages,
  threadHistoryRowsToCards,
  HistoryUnauthorizedError,
  type ThreadHistoryRow,
} from "./history.js";

function row(partial: Partial<ThreadHistoryRow>): ThreadHistoryRow {
  return { seq: 1, at: "2026-07-15T00:00:00Z", kind: "text", authorRole: "user", text: "hi", ...partial };
}

const CARD = { artifactId: "a1", turnId: "t1", data: { n: 1 } };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A `fetch`-shaped mock that returns queued responses in order. */
function mockFetch(responses: Response[]) {
  const queue = [...responses];
  return vi.fn(
    (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const next = queue.shift();
      if (!next) throw new Error("mockFetch: no queued response");
      return Promise.resolve(next);
    },
  );
}

describe("threadHistoryRowsToMessages", () => {
  it("keeps text rows and maps author → role", () => {
    const messages = threadHistoryRowsToMessages([
      row({ authorRole: "user", text: "hello" }),
      row({ authorRole: "assistant", text: "hi there" }),
    ]);
    expect(messages).toEqual([
      { role: "user", text: "hello", seq: 1 },
      { role: "assistant", text: "hi there", seq: 1 },
    ]);
  });

  it("drops non-text rows and null text", () => {
    const messages = threadHistoryRowsToMessages([
      row({ kind: "tool_use", text: "{}" }),
      row({ kind: "text", text: null }),
      row({ kind: "text", authorRole: "assistant", text: "kept" }),
    ]);
    expect(messages).toEqual([{ role: "assistant", text: "kept", seq: 1 }]);
  });

  it("treats any non-user author as assistant", () => {
    const messages = threadHistoryRowsToMessages([row({ authorRole: "system", text: "x" })]);
    expect(messages).toEqual([{ role: "assistant", text: "x", seq: 1 }]);
  });

  it("ignores card rows entirely (text-only surface is unchanged)", () => {
    const messages = threadHistoryRowsToMessages([
      row({ seq: 1, authorRole: "user", text: "hi" }),
      row({ seq: 2, kind: "card", authorRole: "agent", text: null, cardSnapshot: CARD }),
      row({ seq: 3, authorRole: "assistant", text: "there" }),
    ]);
    expect(messages).toEqual([
      { role: "user", text: "hi", seq: 1 },
      { role: "assistant", text: "there", seq: 3 },
    ]);
  });
});

describe("threadHistoryRowsToMessages — interim narration from the read plane", () => {
  const row = (seq: number, extra: object) => ({ seq, at: "2026-09-24T00:00:00Z", kind: "text", authorRole: "agent", text: null, ...extra });

  it("narration rides beside the answer; a narration-only row is kept with empty text, so a reload still shows it", () => {
    expect(
      threadHistoryRowsToMessages([
        row(1, { narration: ["Let me check the calendar."] }),
        row(2, { text: "You're free from 3 to 5." }),
      ]),
    ).toEqual([
      { role: "assistant", text: "", seq: 1, narration: ["Let me check the calendar."] },
      { role: "assistant", text: "You're free from 3 to 5.", seq: 2 },
    ]);
  });

  it("a row with neither text nor narration is still dropped; a user row never carries narration; non-strings and empty lines are ignored", () => {
    expect(
      threadHistoryRowsToMessages([
        row(1, {}),
        row(2, { narration: [] }),
        row(3, { authorRole: "user", text: "am I free?", narration: ["stray"] }),
        row(4, { text: "Done.", narration: ["", 7, "Checking."] }),
        row(5, { text: "Old read plane.", narration: null }),
      ]),
    ).toEqual([
      { role: "user", text: "am I free?", seq: 3 },
      { role: "assistant", text: "Done.", seq: 4, narration: ["Checking."] },
      { role: "assistant", text: "Old read plane.", seq: 5 },
    ]);
  });
});

describe("threadHistoryRowsToCards", () => {
  it("keeps card rows with a snapshot, tagged by seq/at", () => {
    const cards = threadHistoryRowsToCards([
      row({ seq: 1, authorRole: "user", text: "hi" }),
      row({ seq: 2, at: "2026-07-15T00:00:02Z", kind: "card", authorRole: "agent", text: null, cardSnapshot: CARD }),
    ]);
    expect(cards).toEqual([{ seq: 2, at: "2026-07-15T00:00:02Z", cardSnapshot: CARD }]);
  });

  it("drops non-card rows and card rows with a null/absent snapshot", () => {
    const cards = threadHistoryRowsToCards([
      row({ seq: 1, kind: "text", text: "hi" }),
      row({ seq: 2, kind: "card", text: null, cardSnapshot: null }),
      row({ seq: 3, kind: "card", text: null }), // absent snapshot
      row({ seq: 4, kind: "event", text: null }),
    ]);
    expect(cards).toEqual([]);
  });
});

describe("fetchThreadHistory", () => {
  it("returns the mapped transcript for a single page", async () => {
    const fetchImpl = mockFetch([
      jsonResponse({ rows: [row({ authorRole: "user", text: "hey" })], nextToken: null }),
    ]);
    const result = await fetchThreadHistory({
      baseUrl: "https://api.example.com/v1",
      threadId: "t_1",
      fetchImpl,
    });
    expect(result).toEqual({ messages: [{ role: "user", text: "hey", seq: 1 }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/threads/t_1/messages?limit=100");
  });

  it("follows nextToken across pages (ascending order preserved)", async () => {
    const fetchImpl = mockFetch([
      jsonResponse({ rows: [row({ seq: 1, text: "first" })], nextToken: "p2" }),
      jsonResponse({ rows: [row({ seq: 2, authorRole: "assistant", text: "second" })], nextToken: null }),
    ]);
    const result = await fetchThreadHistory({
      baseUrl: "https://api.example.com/v1",
      threadId: "t_1",
      fetchImpl,
    });
    expect(result).toEqual({
      messages: [
        { role: "user", text: "first", seq: 1 },
        { role: "assistant", text: "second", seq: 2 },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toContain("nextToken=p2");
  });

  it("returns gone on 403 / 404", async () => {
    for (const status of [403, 404]) {
      const fetchImpl = mockFetch([jsonResponse({}, status)]);
      const result = await fetchThreadHistory({
        baseUrl: "https://api.example.com/v1",
        threadId: "t_1",
        fetchImpl,
      });
      expect(result).toEqual({ gone: true });
    }
  });

  it("throws on other non-OK statuses", async () => {
    const fetchImpl = mockFetch([jsonResponse({}, 500)]);
    await expect(
      fetchThreadHistory({ baseUrl: "https://api.example.com/v1", threadId: "t_1", fetchImpl }),
    ).rejects.toThrow(/history load failed: 500/);
  });

  it("throws HistoryUnauthorizedError — distinctly from a generic non-OK — on 401", async () => {
    // Distinct from the generic `Error` above: a caller holding a token can
    // `instanceof`-match this to retry once with a freshly-refreshed one
    // (`createWebAdapters`'s history adapter). A 500 or a malformed request
    // gets no such retry — those aren't identity problems.
    const fetchImpl = mockFetch([jsonResponse({}, 401)]);
    await expect(
      fetchThreadHistory({ baseUrl: "https://api.example.com/v1", threadId: "t_1", fetchImpl }),
    ).rejects.toBeInstanceOf(HistoryUnauthorizedError);
  });

  it("omits cards by default (text-only consumers unaffected)", async () => {
    const fetchImpl = mockFetch([
      jsonResponse({
        rows: [
          row({ seq: 1, authorRole: "user", text: "hi" }),
          row({ seq: 2, kind: "card", authorRole: "agent", text: null, cardSnapshot: CARD }),
        ],
        nextToken: null,
      }),
    ]);
    const result = await fetchThreadHistory({
      baseUrl: "https://api.example.com/v1",
      threadId: "t_1",
      fetchImpl,
    });
    expect(result).toEqual({ messages: [{ role: "user", text: "hi", seq: 1 }] });
    expect(result).not.toHaveProperty("cards");
  });

  it("populates cards when includeCards is set, preserving text alongside", async () => {
    const fetchImpl = mockFetch([
      jsonResponse({
        rows: [
          row({ seq: 1, authorRole: "user", text: "hi" }),
          row({ seq: 2, at: "2026-07-15T00:00:02Z", kind: "card", authorRole: "agent", text: null, cardSnapshot: CARD }),
        ],
        nextToken: null,
      }),
    ]);
    const result = await fetchThreadHistory({
      baseUrl: "https://api.example.com/v1",
      threadId: "t_1",
      includeCards: true,
      fetchImpl,
    });
    expect(result).toEqual({
      messages: [{ role: "user", text: "hi", seq: 1 }],
      cards: [{ seq: 2, at: "2026-07-15T00:00:02Z", cardSnapshot: CARD }],
    });
  });

  it("passes the caller's requestInit (identity headers) to fetch", async () => {
    const fetchImpl = mockFetch([jsonResponse({ rows: [], nextToken: null })]);
    await fetchThreadHistory({
      baseUrl: "https://api.example.com/v1",
      threadId: "t_1",
      requestInit: { headers: { Authorization: "Bearer tok" } },
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0][1]).toEqual({ headers: { Authorization: "Bearer tok" } });
  });
});

// ── A read plane that marks a failed turn's or a notice's row ──────────────
describe("threadHistoryRowsToMessages — marked rows reload as notices", () => {
  it("a failed turn's row becomes a notice carrying its code; a row stored before codes carries null", () => {
    expect(
      threadHistoryRowsToMessages([
        row({ seq: 1, authorRole: "user", text: "tell me" }),
        row({ seq: 2, authorRole: "agent", text: "The reply was withheld.", failure: { code: "CONTENT_BLOCKED" } }),
        row({ seq: 3, authorRole: "agent", text: "Something went wrong on our side while writing this reply.", failure: { code: null } }),
      ]),
    ).toEqual([
      { role: "user", text: "tell me", seq: 1 },
      { role: "notice", text: "The reply was withheld.", seq: 2, failure: { code: "CONTENT_BLOCKED" } },
      { role: "notice", text: "Something went wrong on our side while writing this reply.", seq: 3, failure: { code: null } },
    ]);
  });

  it("a notice's row becomes a notice with its source when it is a known one", () => {
    expect(
      threadHistoryRowsToMessages([
        row({ seq: 1, authorRole: "agent", text: "safeguards stopped the response above", notice: { source: "framework" } }),
        row({ seq: 2, authorRole: "agent", text: "an annotation", notice: { source: "a-future-layer" } }),
        row({ seq: 3, authorRole: "agent", text: "unnamed", notice: { source: null } }),
      ]),
    ).toEqual([
      { role: "notice", text: "safeguards stopped the response above", seq: 1, noticeSource: "framework" },
      { role: "notice", text: "an annotation", seq: 2 },
      { role: "notice", text: "unnamed", seq: 3 },
    ]);
  });

  it("malformed or misplaced marks read as absent: a user row stays the user's; an empty-text mark is dropped", () => {
    expect(
      threadHistoryRowsToMessages([
        row({ seq: 1, authorRole: "user", text: "q", failure: { code: "X" } }),
        row({ seq: 2, authorRole: "agent", text: "", failure: { code: "NO_REPLY" } }),
        row({ seq: 3, authorRole: "agent", text: "coded oddly", failure: { code: "" } }),
      ]),
    ).toEqual([
      { role: "user", text: "q", seq: 1 },
      { role: "notice", text: "coded oddly", seq: 3, failure: { code: null } },
    ]);
  });

  it("N−1: an older read plane's rows (no marks) map exactly as before", () => {
    expect(threadHistoryRowsToMessages([row({ seq: 2, authorRole: "agent", text: "The reply was withheld." })])).toEqual([
      { role: "assistant", text: "The reply was withheld.", seq: 2 },
    ]);
  });
});
