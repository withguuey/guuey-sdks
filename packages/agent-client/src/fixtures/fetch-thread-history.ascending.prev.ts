/**
 * FROZEN test fixture (guuey#2858): `fetchThreadHistory` exactly as it stood
 * before the read asked for newest-first pages: ascending, capped at 10 pages,
 * reading the thread's closure (`thread`). It stands in for an older client
 * reading a newer read plane (the N−1 direction), so do not edit it to follow
 * `../history.ts`; a later wire change gets a new frozen copy beside this one
 * (`./fetch-thread-history.prev.ts` is the copy from before `thread`). Only
 * the imports are adjusted to this directory, and the constants and the
 * response type it needs are kept with it. The row mappers and the closure
 * readers it calls are imported: they did not change.
 */
import {
  HistoryUnauthorizedError,
  threadHistoryRowsToCards,
  threadHistoryRowsToMessages,
  type ThreadHistoryFetchOptions,
  type ThreadHistoryRow,
} from "../history.js";
import { closureFromLastRow, readThreadClosed } from "../thread-closed.js";
import type { HistoryLoadResult, ThreadClosed } from "../types.js";

interface ThreadMessagesResponse {
  rows: ThreadHistoryRow[];
  nextToken: string | null;
  /**
   * The thread's own state, on every page: `{}` while open, `closed` once its
   * agent ended it. Absent from an older read plane.
   */
  thread?: { closed?: { code?: string | null; message?: string | null; closedAt?: string | null } | null } | null;
}

const HISTORY_PAGE_LIMIT = 100;
const MAX_HISTORY_PAGES = 10;

export async function fetchThreadHistory({
  baseUrl,
  threadId,
  requestInit,
  includeCards = false,
  fetchImpl = fetch,
}: ThreadHistoryFetchOptions): Promise<HistoryLoadResult> {
  const routeUrl = `${baseUrl}/threads/${encodeURIComponent(threadId)}/messages`;
  const rows: ThreadHistoryRow[] = [];
  let nextToken: string | null = null;
  // The read plane's own word on a closed thread, from any page; and whether
  // it spoke at all (an older read plane sends no `thread` field).
  let closed: ThreadClosed | undefined;
  let threadFieldSeen = false;

  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const url =
      `${routeUrl}?limit=${HISTORY_PAGE_LIMIT}` +
      (nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : "");
    const res = await fetchImpl(url, requestInit);
    if (res.status === 403 || res.status === 404) return { gone: true };
    if (res.status === 401) throw new HistoryUnauthorizedError();
    if (!res.ok) throw new Error(`history load failed: ${res.status}`);
    const body: ThreadMessagesResponse = await res.json();
    rows.push(...body.rows);
    if (body.thread != null && typeof body.thread === "object") {
      threadFieldSeen = true;
      closed = readThreadClosed(body.thread.closed) ?? closed;
    }
    nextToken = body.nextToken;
    if (!nextToken) break;
  }

  // A read plane that sends `thread` decides alone (`{}` = open, even when the
  // last row is an `app:` failure row on a thread that stayed open). Only an
  // older read plane, which sends no `thread`, is read from its last row.
  const threadClosed = closed ?? (threadFieldSeen ? undefined : closureFromLastRow(rows));
  return {
    messages: threadHistoryRowsToMessages(rows),
    ...(includeCards ? { cards: threadHistoryRowsToCards(rows) } : {}),
    ...(threadClosed !== undefined ? { closed: threadClosed } : {}),
  };
}
