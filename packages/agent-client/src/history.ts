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
import { AgNoticeSource, isJsonValue, readStoredAgMessage, type AgMessage, type JsonValue } from "@silverprotocol/core";
import { readTapLabels } from "@guuey/mcp-apps-host/narrowing";
import type {
  AgentMessage,
  HistoryCard,
  HistoryLoadResult,
  HistoryToolCall,
  HistoryToolResult,
  ThreadClosed,
} from "./types.js";
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
  /**
   * guuey#2487: the tool results this row carries that no card row stands
   * for. Served only when the read asked (`include=toolResults`); absent from
   * an older read plane and from every row that carries none. Read through
   * {@link threadHistoryRowsToToolResults}, so an entry no writer produced
   * maps to nothing.
   */
  toolResults?: ThreadHistoryToolResultRow[] | null;
  /**
   * guuey#2388: the tool calls this row's stored message makes, in block
   * order. Served only when the read asked (`include=toolCalls`) and the page
   * echoes it; absent from an older read plane. Kept as served values and read
   * entry by entry by {@link threadHistoryRowsToToolCalls}, so an entry no
   * writer produced drops alone.
   */
  toolCalls?: JsonValue[] | null;
}

/** One entry of {@link ThreadHistoryRow.toolResults}, as the read plane serves it. */
export interface ThreadHistoryToolResultRow {
  toolCallId?: string | null;
  toolName?: string | null;
  /** The stored `tool-result` block, without its `_meta`. */
  block?: JsonValue | null;
}

/** The `include` value that asks the read plane for {@link ThreadHistoryRow.toolResults}. */
export const TOOL_RESULTS_INCLUDE = "toolResults";

/** The `include` value that asks the read plane for {@link ThreadHistoryRow.toolCalls} (guuey#2388). */
export const TOOL_CALLS_INCLUDE = "toolCalls";

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
  /**
   * guuey#2388: the `include` entries the read plane says it honoured on this
   * page (its body's `include` echo). `[]` when the page carried none: a read
   * plane that predates the echo, or a read that asked nothing that needs it.
   */
  include: readonly string[];
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
  const toolResults = field(value, "toolResults");
  if (toolResults === null) row.toolResults = null;
  else if (Array.isArray(toolResults)) {
    // guuey#2487: each entry is kept only in the shape the type names; what it
    // means is judged by threadHistoryRowsToToolResults.
    row.toolResults = toolResults.filter(isObject).map(readThreadHistoryToolResultRow);
  }
  const toolCalls = field(value, "toolCalls");
  if (toolCalls === null) row.toolCalls = null;
  else if (Array.isArray(toolCalls)) {
    // guuey#2388: each entry is judged on its own by threadHistoryRowsToToolCalls.
    row.toolCalls = toolCalls.filter(isJsonValue);
  }
  return row;
}

/** One served {@link ThreadHistoryToolResultRow}, each field kept only in the shape the type names. */
function readThreadHistoryToolResultRow(value: object): ThreadHistoryToolResultRow {
  const entry: ThreadHistoryToolResultRow = {};
  const toolCallId = stringOrNull(field(value, "toolCallId"));
  if (toolCallId !== undefined) entry.toolCallId = toolCallId;
  const toolName = stringOrNull(field(value, "toolName"));
  if (toolName !== undefined) entry.toolName = toolName;
  const block = field(value, "block");
  if (block !== undefined && isJsonValue(block)) entry.block = block;
  return entry;
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
  const include = field(body, "include");
  return {
    rows,
    nextToken: typeof nextToken === "string" && nextToken !== "" ? nextToken : null,
    threadSeen,
    closed: threadSeen ? readThreadClosed(field(thread, "closed")) : undefined,
    newestFirst: field(body, "order") === "desc",
    include: Array.isArray(include) ? include.filter((entry): entry is string => typeof entry === "string") : [],
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

/**
 * Project raw rows to the tool results with no UI resource they carry
 * (guuey#2487), tagged with their row's transcript position, ascending as the
 * rows are. The sibling of {@link threadHistoryRowsToCards}: a host that drew
 * an attachment from a tool result live matches these by `toolName` and draws
 * it again. An entry without a string `toolCallId` or a `tool-result` block is
 * dropped; rows from a read plane that predates the field give none.
 *
 * One item per result: a result whose call a card row among `rows` stands for
 * is left out, since that card is how it is drawn. The read plane does the
 * same within one page, but a thread a 3.17 pod wrote can hold a card row
 * minted from a `_meta.ui` locator beside that result's stored row, which
 * this release reads as a result with no UI resource; when a page edge falls
 * between the two, only the reader that holds every row can pair them.
 */
export function threadHistoryRowsToToolResults(rows: ThreadHistoryRow[]): HistoryToolResult[] {
  const carded = cardPartsByToolCallId(rows);
  const results: HistoryToolResult[] = [];
  for (const row of rows) {
    if (row.kind !== "text" || !Array.isArray(row.toolResults)) continue;
    for (const entry of row.toolResults) {
      if (entry === null || typeof entry !== "object") continue;
      const { toolCallId, toolName } = entry;
      if (typeof toolCallId !== "string" || toolCallId === "" || carded.has(toolCallId)) continue;
      const block = readServedToolResultBlock(entry.block);
      if (block === undefined || block.toolCallId !== toolCallId) continue;
      results.push({
        seq: row.seq,
        at: row.at,
        toolCallId,
        ...(typeof toolName === "string" && toolName !== "" ? { toolName } : {}),
        block,
        ...(block.structuredContent !== undefined ? { structuredContent: block.structuredContent } : {}),
      });
    }
  }
  return results;
}

/**
 * Project raw rows to the tool calls their stored messages make (guuey#2388),
 * tagged with their row's transcript position, ascending as the rows are, in
 * block order within a row. Only `kind === "text"` rows carry calls.
 *
 * Lenient, entry by entry: each served entry is read field by field
 * (`toolCallId` and `name` non-empty strings, `title` a string when present,
 * `input` any JSON value), and one that fails is dropped alone, never its row
 * or its neighbours. Every other field is ignored, so a call a later writer
 * describes with more (a new `uiVisibility` value, any key) still reads. A
 * repeated `toolCallId` keeps the first, the live rule.
 *
 * A call whose result a card row among `rows` stands for carries that card's
 * position and its `tool-result` part, so a renderer pairs the two without
 * walking the snapshot again.
 */
export function threadHistoryRowsToToolCalls(rows: ThreadHistoryRow[]): HistoryToolCall[] {
  const carded = cardPartsByToolCallId(rows);
  const seen = new Set<string>();
  const calls: HistoryToolCall[] = [];
  for (const row of rows) {
    if (row.kind !== "text" || !Array.isArray(row.toolCalls)) continue;
    for (const entry of row.toolCalls) {
      const call = readServedToolCall(entry);
      if (call === undefined || seen.has(call.toolCallId)) continue;
      seen.add(call.toolCallId);
      const card = carded.get(call.toolCallId);
      const result = card === undefined ? undefined : readServedToolResultBlock(card.part);
      calls.push({
        seq: row.seq,
        at: row.at,
        call,
        ...(card !== undefined ? { card: { seq: card.seq, ...(result !== undefined ? { result } : {}) } } : {}),
      });
    }
  }
  return calls;
}

/** One served call entry read field by field into the four fields, or `undefined` when one of them does not read. */
function readServedToolCall(entry: JsonValue): HistoryToolCall["call"] | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const { toolCallId, name, title, input } = entry;
  if (typeof toolCallId !== "string" || toolCallId === "") return undefined;
  if (typeof name !== "string" || name === "") return undefined;
  if (title !== undefined && typeof title !== "string") return undefined;
  if (input === undefined) return undefined;
  return { toolCallId, name, ...(title !== undefined ? { title } : {}), input };
}

/**
 * The module's one card walk: each call id the card rows of `rows` stand for,
 * with that card row's position and the `tool-result` part that names it. A
 * part counts when it is an object of `type: "tool-result"` with a string
 * `toolCallId`; a snapshot of any other shape stands for none. The first card
 * row naming an id keeps it. The read plane walks the same field on its side;
 * none of this package's dependencies exports such a walk, so it is written
 * here over the served `JsonValue`.
 */
function cardPartsByToolCallId(rows: readonly ThreadHistoryRow[]): Map<string, { seq: number; part: JsonValue }> {
  const byId = new Map<string, { seq: number; part: JsonValue }>();
  for (const row of rows) {
    const snapshot = row.kind === "card" ? row.cardSnapshot : undefined;
    if (snapshot === null || snapshot === undefined || typeof snapshot !== "object" || Array.isArray(snapshot)) continue;
    const parts = snapshot["parts"];
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
      const toolCallId = part["toolCallId"];
      if (part["type"] === "tool-result" && typeof toolCallId === "string" && !byId.has(toolCallId)) {
        byId.set(toolCallId, { seq: row.seq, part });
      }
    }
  }
  return byId;
}

/**
 * A served block read as a stored `tool-result` block, through AgJSON's
 * lenient stored-record reader (the reader every stored message goes through),
 * leniently PER PART: unknown fields pass through, and a block that names a
 * value this client's closed sets do not hold is read again without it.
 *
 * The stored reader omits a whole content element that fails at any depth, so
 * a tool result carrying one content part of a type a later
 * `@silverprotocol/core` adds, or a later `outcome` value, would be lost whole,
 * with the `structuredContent` a host draws from. N-1 forward: when the block
 * does not read as served, each content part is judged on its own, and the
 * block is read again with the parts that do not read (and an outcome that
 * does not read) left out, the way `@guuey/threads`' `readStoredRowMessage`
 * reads a message with an elided answer: once as stored, then once rebuilt.
 * Only a block that still does not read (not a `tool-result`, no `content`
 * array, or another field of its own that is not valid) is `undefined`, so
 * that one entry is dropped and the rest of the list still reads.
 */
function readServedToolResultBlock(
  served: JsonValue | null | undefined,
): HistoryToolResult["block"] | undefined {
  if (served === null || served === undefined) return undefined;
  const whole = readToolResultElement(served);
  if (whole !== undefined) return whole;
  if (typeof served !== "object" || Array.isArray(served)) return undefined;
  const { content, outcome, ...rest } = served;
  if (rest["type"] !== "tool-result" || !Array.isArray(content)) return undefined;
  // Each part and the outcome are judged alone, on a probe block with nothing else in it.
  const readable = content.filter((part) => readToolResultElement(probeBlock({ content: [part] })) !== undefined);
  const keepsOutcome = outcome !== undefined && readToolResultElement(probeBlock({ outcome })) !== undefined;
  return readToolResultElement({ ...rest, content: readable, ...(keepsOutcome ? { outcome } : {}) });
}

/** The smallest block the stored reader reads as a tool result, with `fields` over it: the probe a part or an outcome is judged on. */
function probeBlock(fields: { [key: string]: JsonValue }): JsonValue {
  return { type: "tool-result", toolCallId: "probe", content: [], ...fields };
}

/** One stored content element read alone as a `tool-result` block, or `undefined` when the stored reader omits it. */
function readToolResultElement(element: JsonValue): HistoryToolResult["block"] | undefined {
  const [block] = readStoredAgMessage({ id: "served-tool-result", role: "tool", content: [element] }).value?.content ?? [];
  return block?.type === "tool-result" ? block : undefined;
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
  /**
   * Opt-in (guuey#2487): ask the read plane for the tool results with no UI
   * resource (`include=toolResults`) and project them into
   * `result.toolResults` (see {@link threadHistoryRowsToToolResults}). Off by
   * default, so the request and the result stay byte-identical. A read plane
   * that predates the field ignores the ask, and `toolResults` is `[]`.
   */
  includeToolResults?: boolean;
  /**
   * Opt-in (guuey#2388): ask the read plane for the stored tool calls
   * (`include=toolCalls`) and project them into `result.toolCalls` (see
   * {@link threadHistoryRowsToToolCalls}). Off by default. Asks only its own
   * entry: with {@link includeToolResults} the two ride one comma-joined
   * `include` param. `result.toolCalls` is present only when every page of the
   * read echoed `toolCalls`; a read plane that predates calls sends no echo,
   * and then it is absent.
   */
  includeToolCalls?: boolean;
  /** Injection seam for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * A page echo the walk needs honoured on EVERY page it reads: the newest-first
 * `order` (guuey#2858) and the `toolCalls` include (guuey#2388).
 */
type HonouredEcho = "order" | typeof TOOL_CALLS_INCLUDE;

/** The members of `asked` that `page` echoes. */
function pageEchoes(page: ThreadMessagesPage, asked: ReadonlySet<HonouredEcho>): Set<HonouredEcho> {
  const echoed = new Set<HonouredEcho>();
  if (asked.has("order") && page.newestFirst) echoed.add("order");
  if (asked.has(TOOL_CALLS_INCLUDE) && page.include.includes(TOOL_CALLS_INCLUDE)) echoed.add(TOOL_CALLS_INCLUDE);
  return echoed;
}

/** One walk of the route in one order: every row it read, by seq, and the thread's state. */
interface HistoryWalk {
  rows: Map<number, ThreadHistoryRow>;
  closed: ThreadClosed | undefined;
  threadSeen: boolean;
  /** The page cap was reached with a `nextToken` left: rows exist that this walk did not read. */
  truncated: boolean;
  /** The echoes every page of this walk carried: `order` = served newest-first; `toolCalls` = calls honoured. */
  honoured: ReadonlySet<HonouredEcho>;
}

/** The read's `include` entries, in their fixed order (#2487's first), as one comma-joined param; `""` when it asks none. */
function includeParam(includeToolResults: boolean, includeToolCalls: boolean): string {
  const entries = [
    ...(includeToolResults ? [TOOL_RESULTS_INCLUDE] : []),
    ...(includeToolCalls ? [TOOL_CALLS_INCLUDE] : []),
  ];
  return entries.length > 0 ? `&include=${entries.join(",")}` : "";
}

/**
 * Walk the route's pages, newest-first when `asked` holds `order`
 * (guuey#2858), keeping ONE set of the echoes honoured on every page: page 1
 * seeds it with the asked members it echoes, and each later page narrows it.
 * What a lost member costs is the member's own:
 *
 *  - `order`: page 1 without the echo is a read plane that predates the
 *    param: its rows are ascending, so that page is page 1 of the ascending
 *    walk, and the walk goes on ascending (no `order` sent). A later page that
 *    loses it (the read plane rolled back mid-read) answers `order-lost`: its
 *    token runs the other way, so the caller discards this walk and reads
 *    again ascending.
 *  - `toolCalls` (guuey#2388): lost on any page, the walk serves no calls at
 *    all, never a partial list. The ask itself rides every page unchanged.
 */
async function walkHistory(
  routeUrl: string,
  asked: ReadonlySet<HonouredEcho>,
  include: string,
  requestInit: RequestInit | undefined,
  fetchImpl: typeof fetch,
): Promise<HistoryWalk | "gone" | "order-lost"> {
  const rows = new Map<number, ThreadHistoryRow>();
  let honoured = new Set(asked);
  let nextToken: string | null = null;
  let closed: ThreadClosed | undefined;
  let threadSeen = false;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const url =
      `${routeUrl}?limit=${HISTORY_PAGE_LIMIT}` +
      (honoured.has("order") ? "&order=desc" : "") +
      include +
      (nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : "");
    const res = await fetchImpl(url, requestInit);
    if (res.status === 403 || res.status === 404) return "gone";
    if (res.status === 401) throw new HistoryUnauthorizedError();
    if (!res.ok) throw new Error(`history load failed: ${res.status}`);
    // Parsed HERE, from the body text: a fetch from another JS realm (Node's
    // fetch under a jsdom suite, a vm or SSR host) builds `res.json()` on that
    // realm's Object.prototype, and the card snapshot's plain-object check
    // would drop every card without a word.
    const body: unknown = JSON.parse(await res.text());
    const read = readThreadMessagesPage(body);
    if (read === null) throw new Error("history load failed: the read plane returned a malformed page");
    const echoed = pageEchoes(read, honoured);
    if (page > 0 && honoured.has("order") && !echoed.has("order")) return "order-lost";
    honoured = echoed;
    // Keyed by seq: a row served twice (an overlap after a byte cut) is one row.
    for (const row of read.rows) rows.set(row.seq, row);
    if (read.threadSeen) {
      threadSeen = true;
      closed = read.closed ?? closed;
    }
    nextToken = read.nextToken;
    if (!nextToken) return { rows, closed, threadSeen, truncated: false, honoured };
  }
  return { rows, closed, threadSeen, truncated: true, honoured };
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
  includeToolResults = false,
  includeToolCalls = false,
  fetchImpl = fetch,
}: ThreadHistoryFetchOptions): Promise<HistoryLoadResult> {
  const routeUrl = `${baseUrl}/threads/${encodeURIComponent(threadId)}/messages`;
  const include = includeParam(includeToolResults, includeToolCalls);
  const askCalls: HonouredEcho[] = includeToolCalls ? [TOOL_CALLS_INCLUDE] : [];
  let walk = await walkHistory(routeUrl, new Set<HonouredEcho>(["order", ...askCalls]), include, requestInit, fetchImpl);
  if (walk === "order-lost") walk = await walkHistory(routeUrl, new Set(askCalls), include, requestInit, fetchImpl);
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
    ...(includeToolResults ? { toolResults: threadHistoryRowsToToolResults(rows) } : {}),
    // guuey#2388: only when every page echoed the ask; no echo means none.
    ...(walk.honoured.has(TOOL_CALLS_INCLUDE) ? { toolCalls: threadHistoryRowsToToolCalls(rows) } : {}),
    ...(threadClosed !== undefined ? { closed: threadClosed } : {}),
    // The order says which rows a capped read left out, so it rides beside `truncated`.
    ...(walk.truncated ? { truncated: true, order: walk.honoured.has("order") ? "desc" : "asc" } : {}),
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
