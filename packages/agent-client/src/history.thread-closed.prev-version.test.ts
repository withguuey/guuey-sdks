/**
 * N−1 across a rolling release for the transcript read's `thread.closed`
 * (guuey#2355), both directions:
 *
 * - An OLDER client (its `fetchThreadHistory` frozen in
 *   `fixtures/fetch-thread-history.prev.ts`) reads a NEWER read plane's body
 *   for a closed thread: it ignores `thread`, and draws exactly what it drew
 *   before, the closing turn as its `app:` failure notice (the agent's
 *   message), so nothing is lost.
 * - The CURRENT client reads an OLDER read plane's body (no `thread` field):
 *   it reads the conversation as closed from that last `app:` failure row.
 *   A newer read plane always sends `thread` (`{}` while open), and then the
 *   field alone decides: an open thread whose last row is an `app:` failure
 *   row reads open.
 */
import { describe, it, expect, vi } from "vitest";
import { fetchThreadHistory, type ThreadHistoryRow } from "./history.js";
import { fetchThreadHistory as fetchThreadHistoryPrev } from "./fixtures/fetch-thread-history.prev.js";

const MESSAGE = "This chat is full. Start a new one.";
const ROWS: ThreadHistoryRow[] = [
  { seq: 1, at: "2026-10-15T00:00:00Z", kind: "text", authorRole: "user", text: "hi" },
  { seq: 2, at: "2026-10-15T00:00:01Z", kind: "text", authorRole: "agent", text: MESSAGE, failure: { code: "app:CHAT_FULL" } },
];
const OLD_BODY = { rows: ROWS, nextToken: null };
const NEW_BODY = { ...OLD_BODY, thread: { closed: { code: "app:CHAT_FULL", message: MESSAGE, closedAt: "2026-10-15T00:00:02.000Z" } } };
/** A newer read plane's body for a thread that is still OPEN, though its last row is an app: failure row. */
const NEW_OPEN_BODY = { ...OLD_BODY, thread: {} };

function serving(body: object) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

const opts = { baseUrl: "https://api.example.com/v1", threadId: "t1", includeCards: true };

describe("an older client × a newer read plane's closed-thread body", () => {
  it("reads it exactly as the older body: thread is ignored, and the closing turn is its app: notice", async () => {
    const fromNew = await fetchThreadHistoryPrev({ ...opts, fetchImpl: serving(NEW_BODY) });
    const fromOld = await fetchThreadHistoryPrev({ ...opts, fetchImpl: serving(OLD_BODY) });
    expect(fromNew).toEqual(fromOld);
    expect("messages" in fromNew && fromNew.messages[1]).toEqual({ role: "notice", text: MESSAGE, seq: 2, failure: { code: "app:CHAT_FULL" } });
  });

  it("reads a newer open body (thread: {}) exactly as the older body too", async () => {
    const fromNewOpen = await fetchThreadHistoryPrev({ ...opts, fetchImpl: serving(NEW_OPEN_BODY) });
    const fromOld = await fetchThreadHistoryPrev({ ...opts, fetchImpl: serving(OLD_BODY) });
    expect(fromNewOpen).toEqual(fromOld);
  });
});

describe("the current client × either body", () => {
  it("an older read plane's body reads as closed from the last app: row (no closedAt)", async () => {
    const result = await fetchThreadHistory({ ...opts, fetchImpl: serving(OLD_BODY) });
    expect("closed" in result && result.closed).toEqual({ code: "app:CHAT_FULL", message: MESSAGE, closedAt: null });
  });

  it("the newer body reads as closed from thread.closed, and differs from the older client's read ONLY by closed", async () => {
    const now = await fetchThreadHistory({ ...opts, fetchImpl: serving(NEW_BODY) });
    const prev = await fetchThreadHistoryPrev({ ...opts, fetchImpl: serving(NEW_BODY) });
    expect(now).toEqual({ ...prev, closed: { code: "app:CHAT_FULL", message: MESSAGE, closedAt: "2026-10-15T00:00:02.000Z" } });
  });

  it("the newer open body (thread: {}) reads OPEN from the field, not closed from the last app: row", async () => {
    const now = await fetchThreadHistory({ ...opts, fetchImpl: serving(NEW_OPEN_BODY) });
    const prev = await fetchThreadHistoryPrev({ ...opts, fetchImpl: serving(NEW_OPEN_BODY) });
    expect("closed" in now).toBe(false);
    expect(now).toEqual(prev);
  });
});
