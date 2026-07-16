import { describe, it, expect, vi } from "vitest";
import {
  fetchThreadHistory,
  threadHistoryRowsToMessages,
  threadHistoryRowsToCards,
  type ThreadHistoryRow,
} from "./history";

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
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]);
  });

  it("drops non-text rows and null text", () => {
    const messages = threadHistoryRowsToMessages([
      row({ kind: "tool_use", text: "{}" }),
      row({ kind: "text", text: null }),
      row({ kind: "text", authorRole: "assistant", text: "kept" }),
    ]);
    expect(messages).toEqual([{ role: "assistant", text: "kept" }]);
  });

  it("treats any non-user author as assistant", () => {
    const messages = threadHistoryRowsToMessages([row({ authorRole: "system", text: "x" })]);
    expect(messages).toEqual([{ role: "assistant", text: "x" }]);
  });

  it("ignores card rows entirely (text-only surface is unchanged)", () => {
    const messages = threadHistoryRowsToMessages([
      row({ seq: 1, authorRole: "user", text: "hi" }),
      row({ seq: 2, kind: "card", authorRole: "agent", text: null, cardSnapshot: CARD }),
      row({ seq: 3, authorRole: "assistant", text: "there" }),
    ]);
    expect(messages).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "there" },
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
    expect(result).toEqual({ messages: [{ role: "user", text: "hey" }] });
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
        { role: "user", text: "first" },
        { role: "assistant", text: "second" },
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
    expect(result).toEqual({ messages: [{ role: "user", text: "hi" }] });
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
      messages: [{ role: "user", text: "hi" }],
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
