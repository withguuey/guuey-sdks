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
import { AgNoticeSource, isJsonValue, type AgMessage, type JsonValue } from "@silverprotocol/core";
import { readTapLabels } from "@guuey/mcp-apps-host/narrowing";
import type { AgentMessage, HistoryCard, HistoryLoadResult, ThreadClosed } from "./types.js";
import { closureFromLastRow, readThreadClosed } from "./thread-closed.js";
import { userInputKindOf } from "./input-kinds.js";

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
  /** guuey#402: the producing tool's wire name, when the row carries it. */
  toolName?: string | null;
  /**
   * The row's interim narration, split out of `text` by the read plane (text
   * rows whose stored content carried it; absent otherwise, and absent from
   * a read plane that predates the split).
   */
  narration?: string[] | null;
  /** A failed turn's reader-line row: its code (null before codes were persisted). Absent from an older read plane. */
  failure?: { code?: string | null } | null;
  /** A framework notice's row: its source when named. Absent from an older read plane. */
  notice?: { source?: string | null } | null;
  /**
   * A card-action user row's tap labels (guuey#2031), one entry per tap. Absent
   * from an older read plane and from every row that has none; read through the
   * reader contract (`readTapLabels`), so a value no writer produced maps to
   * nothing.
   */
  tapLabels?: (string | null)[] | null;
  /**
   * The row's idempotency key. On a user row it is the invoke body's
   * `clientMessageId` (the pod stores the key the client sent). Absent from a
   * read plane that does not project it.
   */
  clientMessageId?: string | null;
  /**
   * A user row sent without words (guuey#2549): where its content rode
   * (`text` is `""`). Absent from an older read plane and from every other
   * row; a kind this release does not know maps to nothing.
   */
  inputKind?: string | null;
}

/**
 * One page of `GET /v1/threads/:id/messages` as this client reads it: the
 * body is parsed into `unknown` and proved field by field
 * ({@link readThreadMessagesPage}), never asserted.
 */
export interface ThreadMessagesPage {
  /** The page's rows, in the order served (ascending, or newest-first when {@link newestFirst}). */
  rows: ThreadHistoryRow[];
  nextToken: string | null;
  /**
   * Whether the page carried the thread's own state (`thread`, on every page
   * of a read plane that has it: `{}` while open). An older read plane sends
   * none, and then the closure is read from the last row.
   */
  threadSeen: boolean;
  /** The read plane's word that the agent ended the conversation (`thread.closed`). */
  closed: ThreadClosed | undefined;
  /**
   * guuey#2858: the read plane honoured `?order=desc` and served this page
   * newest-first (its body's `order: "desc"` echo). False on a read plane that
   * predates the param, which serves ascending rows whatever was asked.
   */
  newestFirst: boolean;
}

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

/**
 * One served row as a {@link ThreadHistoryRow}, or null when it lacks the
 * fields every row has (`seq`, `at`, `kind`, `authorRole`, and `text` as a
 * string or null): such a row cannot be placed in the transcript, and no
 * writer produces one. Each optional field is kept only in the shape the
 * type names, so a value no writer produced reads as absent, exactly as the
 * row mappers read it.
 */
export function readThreadHistoryRow(value: unknown): ThreadHistoryRow | null {
  if (!isObject(value)) return null;
  const seq = field(value, "seq");
  const at = field(value, "at");
  const kind = field(value, "kind");
  const authorRole = field(value, "authorRole");
  const text = field(value, "text");
  if (typeof seq !== "number" || !Number.isInteger(seq)) return null;
  if (typeof at !== "string" || typeof kind !== "string" || typeof authorRole !== "string") return null;
  if (typeof text !== "string" && text !== null) return null;
  const row: ThreadHistoryRow = { seq, at, kind, authorRole, text };
  const cardSnapshot = field(value, "cardSnapshot");
  if (cardSnapshot !== undefined && isJsonValue(cardSnapshot)) row.cardSnapshot = cardSnapshot;
  const toolName = stringOrNull(field(value, "toolName"));
  if (toolName !== undefined) row.toolName = toolName;
  const narration = field(value, "narration");
  if (narration === null) row.narration = null;
  else if (Array.isArray(narration)) row.narration = narration.filter((line): line is string => typeof line === "string");
  const failure = field(value, "failure");
  if (failure === null) row.failure = null;
  else if (isObject(failure)) {
    const code = stringOrNull(field(failure, "code"));
    row.failure = code !== undefined ? { code } : {};
  }
  const notice = field(value, "notice");
  if (notice === null) row.notice = null;
  else if (isObject(notice)) {
    const source = stringOrNull(field(notice, "source"));
    row.notice = source !== undefined ? { source } : {};
  }
  const tapLabels = field(value, "tapLabels");
  if (tapLabels === null) row.tapLabels = null;
  else if (Array.isArray(tapLabels) && tapLabels.every((l) => typeof l === "string" || l === null)) {
    row.tapLabels = tapLabels.filter((l): l is string | null => typeof l === "string" || l === null);
  }
  const clientMessageId = stringOrNull(field(value, "clientMessageId"));
  if (clientMessageId !== undefined) row.clientMessageId = clientMessageId;
  const inputKind = stringOrNull(field(value, "inputKind"));
  if (inputKind !== undefined) row.inputKind = inputKind;
  return row;
}

/**
 * A transcript page body (already parsed from JSON) as a
 * {@link ThreadMessagesPage}, or null when it is not one: not an object, no
 * `rows` array, or a `nextToken` that is neither a string nor null. A row in
 * the array that is not a row ({@link readThreadHistoryRow}) is left out.
 */
export function readThreadMessagesPage(body: unknown): ThreadMessagesPage | null {
  if (!isObject(body)) return null;
  const rawRows = field(body, "rows");
  const nextToken = field(body, "nextToken");
  if (!Array.isArray(rawRows)) return null;
  if (typeof nextToken !== "string" && nextToken !== null && nextToken !== undefined) return null;
  const rows: ThreadHistoryRow[] = [];
  for (const raw of rawRows) {
    const row = readThreadHistoryRow(raw);
    if (row !== null) rows.push(row);
  }
  const thread = field(body, "thread");
  const threadSeen = isObject(thread);
  return {
    rows,
    nextToken: typeof nextToken === "string" && nextToken !== "" ? nextToken : null,
    threadSeen,
    closed: threadSeen ? readThreadClosed(field(thread, "closed")) : undefined,
    newestFirst: field(body, "order") === "desc",
  };
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
 * Hard bound on `nextToken` pagination: at most 10 pages per read. A page is
 * at most 100 rows, and far fewer when its rows are large (a page is cut at a
 * byte budget, so a card-heavy page holds a handful), so a long thread can
 * outrun the cap. The read asks for newest-first pages (guuey#2858), so the
 * cap drops the OLDEST rows and the result says so (`truncated`); a read plane
 * that predates the order serves ascending pages, and there the cap drops the
 * newest, as it always did.
 */
const MAX_HISTORY_PAGES = 10;

/**
 * Project raw rows to chat turns: text rows only, author → role. An
 * assistant row's `narration` rides beside its answer. A narration-only row
 * (no answer text, which the read plane sends for a message that was only
 * commentary) is kept as an assistant message with empty `text`, so its
 * narration still shows after a reload.
 *
 * A row the read plane marks as a failed turn (`failure`) or a framework
 * notice (`notice`) becomes a `role: "notice"` message, never the agent's
 * words, as it was drawn live. A read plane that predates those fields sends
 * neither, and the row stays an assistant message as before.
 */
export function threadHistoryRowsToMessages(rows: ThreadHistoryRow[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const row of rows) {
    if (row.kind !== "text") continue;
    const notice = historyNotice(row);
    if (notice !== null) {
      if (row.text == null || row.text === "") continue;
      messages.push({ role: "notice", text: row.text, seq: row.seq, ...notice });
      continue;
    }
    const role = row.authorRole === "user" ? "user" : "assistant";
    const narration =
      role === "assistant" && Array.isArray(row.narration)
        ? row.narration.filter((line): line is string => typeof line === "string" && line !== "")
        : [];
    // guuey#2549: a user row sent without words keeps its kind, so a reload
    // draws the line the live session drew (and the row is never dropped).
    const inputKind = userInputKindOf(role, row.inputKind);
    if (row.text == null && narration.length === 0 && inputKind === undefined) continue;
    // guuey#2031: a user row's tap labels, shape-checked (the writer's bounds are not the reader's).
    const tapLabels = role === "user" ? readTapLabels(row.tapLabels) : undefined;
    // guuey#2445: a user row keeps the key its send carried, so a history read
    // that replaces the rows can be matched to the rows this client sent live.
    const clientMessageId =
      role === "user" && typeof row.clientMessageId === "string" && row.clientMessageId !== ""
        ? row.clientMessageId
        : undefined;
    messages.push({
      role,
      text: row.text ?? "",
      seq: row.seq,
      ...(clientMessageId !== undefined ? { clientMessageId } : {}),
      ...(narration.length > 0 ? { narration } : {}),
      ...(tapLabels !== undefined ? { tapLabels } : {}),
      ...(inputKind !== undefined ? { inputKind } : {}),
    });
  }
  return messages;
}

/** The notice facets of a row the read plane marked, or null for any other row (malformed marks read as absent). */
function historyNotice(row: ThreadHistoryRow): Pick<AgentMessage, "failure" | "noticeSource"> | null {
  if (row.authorRole === "user") return null;
  if (row.failure != null && typeof row.failure === "object") {
    const code = typeof row.failure.code === "string" && row.failure.code !== "" ? row.failure.code : null;
    return { failure: { code } };
  }
  if (row.notice != null && typeof row.notice === "object") {
    const source = AgNoticeSource.safeParse(row.notice.source);
    return source.success ? { noticeSource: source.data } : {};
  }
  return null;
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
    cards.push({
      seq: row.seq,
      at: row.at,
      cardSnapshot: row.cardSnapshot,
      // guuey#402: thread the producing tool's name when the read plane
      // persists it (defensive — pre-enabler rows carry none).
      ...(typeof row.toolName === "string" ? { toolName: row.toolName } : {}),
    });
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

/** One walk of the route in one order: every row it read, by seq, and the thread's state. */
interface HistoryWalk {
  rows: Map<number, ThreadHistoryRow>;
  closed: ThreadClosed | undefined;
  threadSeen: boolean;
  /** The page cap was reached with a `nextToken` left: rows exist that this walk did not read. */
  truncated: boolean;
  /** The pages were served newest-first (the read plane echoed the order on every page). */
  newestFirst: boolean;
}

/**
 * Walk the route's pages, newest-first when `askNewestFirst` (guuey#2858).
 *
 *  - Page 1 without the `order` echo is a read plane that predates the param:
 *    its rows are ascending, so that page is page 1 of the ascending walk, and
 *    the walk goes on ascending (no `order` sent).
 *  - A later page that loses the echo (the read plane rolled back mid-read)
 *    answers `order-lost`: its token runs the other way, so the caller
 *    discards this walk and reads again ascending.
 */
async function walkHistory(
  routeUrl: string,
  askNewestFirst: boolean,
  requestInit: RequestInit | undefined,
  fetchImpl: typeof fetch,
): Promise<HistoryWalk | "gone" | "order-lost"> {
  const rows = new Map<number, ThreadHistoryRow>();
  let newestFirst = askNewestFirst;
  let nextToken: string | null = null;
  let closed: ThreadClosed | undefined;
  let threadSeen = false;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const url =
      `${routeUrl}?limit=${HISTORY_PAGE_LIMIT}` +
      (newestFirst ? "&order=desc" : "") +
      (nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : "");
    const res = await fetchImpl(url, requestInit);
    if (res.status === 403 || res.status === 404) return "gone";
    if (res.status === 401) throw new HistoryUnauthorizedError();
    if (!res.ok) throw new Error(`history load failed: ${res.status}`);
    const body: unknown = await res.json();
    const read = readThreadMessagesPage(body);
    if (read === null) throw new Error("history load failed: the read plane returned a malformed page");
    if (page === 0) newestFirst = newestFirst && read.newestFirst;
    else if (newestFirst && !read.newestFirst) return "order-lost";
    // Keyed by seq: a row served twice (an overlap after a byte cut) is one row.
    for (const row of read.rows) rows.set(row.seq, row);
    if (read.threadSeen) {
      threadSeen = true;
      closed = read.closed ?? closed;
    }
    nextToken = read.nextToken;
    if (!nextToken) return { rows, closed, threadSeen, truncated: false, newestFirst };
  }
  return { rows, closed, threadSeen, truncated: true, newestFirst };
}

/**
 * Fetch a thread's transcript across its pages, newest-first (guuey#2858), so
 * a thread longer than the page cap loses its OLDEST rows, never the turns a
 * resuming reader came back for, and the result says so (`truncated`).
 * Rows are gathered by `seq` and returned ascending, the render order. A read
 * plane that predates the order serves ascending pages and is read exactly as
 * before; one that stops honouring it mid-read is read again ascending.
 *
 * Returns `{ gone: true }` on 403/404 (a stale local threadId the caller no
 * longer owns / that no longer exists) so the hook can drop the persisted id;
 * throws on any other non-OK status, or a body that is not a page, so
 * `useAgentInvoke`'s best-effort caller can swallow it and leave the chat
 * empty.
 */
export async function fetchThreadHistory({
  baseUrl,
  threadId,
  requestInit,
  includeCards = false,
  fetchImpl = fetch,
}: ThreadHistoryFetchOptions): Promise<HistoryLoadResult> {
  const routeUrl = `${baseUrl}/threads/${encodeURIComponent(threadId)}/messages`;
  let walk = await walkHistory(routeUrl, true, requestInit, fetchImpl);
  if (walk === "order-lost") walk = await walkHistory(routeUrl, false, requestInit, fetchImpl);
  // An ascending walk sends no order, so it cannot lose one.
  if (walk === "order-lost") throw new Error("history load failed: an ascending read lost an order it never asked for");
  if (walk === "gone") return { gone: true };
  const rows = [...walk.rows.values()].sort((a, b) => a.seq - b.seq);

  // A read plane that sends `thread` decides alone (`{}` = open, even when the
  // last row is an `app:` failure row on a thread that stayed open). Only an
  // older read plane, which sends no `thread`, is read from its last row.
  const threadClosed = walk.closed ?? (walk.threadSeen ? undefined : closureFromLastRow(rows));
  return {
    messages: threadHistoryRowsToMessages(rows),
    ...(includeCards ? { cards: threadHistoryRowsToCards(rows) } : {}),
    ...(threadClosed !== undefined ? { closed: threadClosed } : {}),
    // The order says which rows a capped read left out, so it rides beside `truncated`.
    ...(walk.truncated ? { truncated: true, order: walk.newestFirst ? "desc" : "asc" } : {}),
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
