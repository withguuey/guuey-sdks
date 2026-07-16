import { describe, it, expect, vi } from "vitest";
import {
  fetchThreadHistory,
  threadHistoryRowsToMessages,
  type ThreadHistoryRow,
} from "./history";

function row(partial: Partial<ThreadHistoryRow>): ThreadHistoryRow {
  return { seq: 1, at: "2026-07-15T00:00:00Z", kind: "text", authorRole: "user", text: "hi", ...partial };
}

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
