/**
 * FROZEN test fixture: `fetchThreadHistory` exactly as it stood before the
 * transcript read could say a thread was closed. It stands in for an older
 * client reading a newer read plane's body (the N−1 direction), so do not
 * edit it to follow `../history.ts`; a later wire change gets a new frozen
 * copy beside this one. Only the imports are adjusted to this directory, and
 * the constants and the response type it needs are kept with it. The row
 * mappers it calls are imported: they did not change.
 */
import {
  HistoryUnauthorizedError,
  threadHistoryRowsToCards,
  threadHistoryRowsToMessages,
  type ThreadHistoryFetchOptions,
  type ThreadHistoryRow,
} from "../history.js";
import type { HistoryLoadResult } from "../types.js";

interface ThreadMessagesResponse {
  rows: ThreadHistoryRow[];
  nextToken: string | null;
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
    nextToken = body.nextToken;
    if (!nextToken) break;
  }

  return {
    messages: threadHistoryRowsToMessages(rows),
    ...(includeCards ? { cards: threadHistoryRowsToCards(rows) } : {}),
  };
}
