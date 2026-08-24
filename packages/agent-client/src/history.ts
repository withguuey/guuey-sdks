/**
 * Shared transcript-history reader for the base-platform chat client.
 *
 * Reads a thread's persisted transcript from the public read plane
 * (`GET {baseUrl}/threads/{id}/messages`, paginated by `nextToken`) so a
 * reload can repaint history before any SSE traffic starts. Host-agnostic:
 * the caller supplies the base URL and a `requestInit` carrying whatever
 * identity that host can present (a `Authorization: Bearer` header on web /
 * RN when signed in, an `x-guuey-guest` header for RN guests, cookies via
 * `credentials: "include"`). Consumed by {@link createWebAdapters}; Portal
 * has its own copy today and can migrate onto this later.
 */
import type { AgMessage, JsonValue } from "@silverprotocol/core";
import type { AgentMessage, HistoryCard, HistoryLoadResult } from "./types.js";

/** One row of `GET /v1/threads/:id/messages`. */
export interface ThreadHistoryRow {
  seq: number;
  at: string;
  kind: string;
  authorRole: string;
  text: string | null;
  /**
   * The verbatim persisted `AgArtifact` on `kind === "card"` rows; `null` or
   * absent on text/event rows (the read plane omits it there). Forwarded
   * opaquely — never re-parsed into AgEvents.
   */
  cardSnapshot?: JsonValue | null;
}

interface ThreadMessagesResponse {
  rows: ThreadHistoryRow[];
  nextToken: string | null;
}

/**
 * Thrown when the read plane returns 401 on a transcript fetch — distinct
 * from the generic non-OK throw below so a caller holding a token can
 * `instanceof`-match it and retry once with a freshly-refreshed one
 * (`createWebAdapters`'s history adapter is the concrete retry). A cached
 * bearer that has expired since the caller last checked it is exactly the
 * shape a refresh can fix; a 500 or a malformed request is not, and gets no
 * such retry.
 */
export class HistoryUnauthorizedError extends Error {
  constructor(message = "history load failed: 401") {
    super(message);
    this.name = "HistoryUnauthorizedError";
  }
}

/** Rows requested per history page. */
const HISTORY_PAGE_LIMIT = 100;

/**
 * Hard bound on `nextToken` pagination: 10 pages × 100 rows = 1000 messages.
 * The server pages in ASCENDING seq order and the newest turns arrive on the
 * LAST pages, so we follow `nextToken` to completion within this cap rather
 * than stopping at page 1 (which would drop exactly the turns a resuming user
 * cares about). A >1000-message thread truncates its tail — accepted here;
 * a server-side `sort=desc`/`from`-seq param would be the fix if it matters.
 */
const MAX_HISTORY_PAGES = 10;

/** Project raw rows to chat turns: text rows only, author → role. */
export function threadHistoryRowsToMessages(rows: ThreadHistoryRow[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const row of rows) {
    if (row.kind !== "text" || row.text == null) continue;
    messages.push({ role: row.authorRole === "user" ? "user" : "assistant", text: row.text, seq: row.seq });
  }
  return messages;
}

/**
 * Project raw rows to persisted generative-UI cards: `kind === "card"` rows
 * that actually carry a snapshot, tagged with their transcript position. The
 * additive counterpart to {@link threadHistoryRowsToMessages} — a
 * block-preserving consumer merges both by `seq`.
 */
export function threadHistoryRowsToCards(rows: ThreadHistoryRow[]): HistoryCard[] {
  const cards: HistoryCard[] = [];
  for (const row of rows) {
    if (row.kind !== "card" || row.cardSnapshot == null) continue;
    cards.push({ seq: row.seq, at: row.at, cardSnapshot: row.cardSnapshot });
  }
  return cards;
}

export interface ThreadHistoryFetchOptions {
  /** Public read-plane base, already ending in `/v1`. */
  baseUrl: string;
  threadId: string;
  /** Per-request init merged into each page fetch (headers, credentials). */
  requestInit?: RequestInit;
  /**
   * Opt-in: ALSO project `kind === "card"` rows into `result.cards` (see
   * {@link HistoryLoadResult}). Off by default so text-only consumers get the
   * byte-identical `{ messages }` shape. On, a block-preserving renderer gets
   * the persisted cards to interleave by `seq`.
   */
  includeCards?: boolean;
  /** Injection seam for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch a thread's transcript across all pages. Returns `{ gone: true }` on
 * 403/404 (a stale local threadId the caller no longer owns / that no longer
 * exists) so the hook can drop the persisted id; throws on any other non-OK
 * status so `useAgentInvoke`'s best-effort caller can swallow it and leave
 * the chat empty.
 */
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

/**
 * The tool name for a `tool-result` block, read off its paired `tool-call`
 * block in the same message (the reducer keeps both in one message's content).
 * Falls back to `"tool"` when the pair is missing.
 */
export function toolNameFor(message: AgMessage, toolCallId: string): string {
  for (const b of message.content) {
    if (b.type === "tool-call" && b.toolCallId === toolCallId) return b.name;
  }
  return "tool";
}

/**
 * Persisted cards, ascending by transcript `seq` (stable; input untouched).
 * These are PRIOR-turn cards — they always precede the live fold, so a
 * block-preserving renderer surfaces them first (e.g. under an "Earlier in
 * this conversation" divider).
 */
export function sortHistoryCards(cards: readonly HistoryCard[]): HistoryCard[] {
  return [...cards].sort((a, b) => a.seq - b.seq);
}
