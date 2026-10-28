/**
 * Readers for what the hosted thread API answers ({@link HttpThreadPersistence}
 * in `http.ts`). A response body is parsed to `unknown` and read here member by
 * member; nothing is taken as a port type until these readers have proven it.
 *
 * Each reader returns the typed value, or `undefined` when the payload is not
 * one; the binding turns `undefined` into an `HttpThreadStoreError` with code
 * `BAD_RESPONSE`, the error every caller of the binding already handles.
 *
 * What a reader checks follows the port types in `rows.ts`, read across a
 * rolling release:
 * - a REQUIRED member is proven by type (every binding writes it on every row);
 *   a row without it is refused;
 * - an OPTIONAL member is kept when it reads as its type and is absent
 *   otherwise, the way each one's own reader treats it at use (`readThreadInputKind`,
 *   `readTapLabels`, `threadClosure`), so a field an older server omits reads
 *   as absent and a value a newer one adds that this release does not know is
 *   left out;
 * - where reading a malformed optional member as absent would OPEN something
 *   the stored value closes (`sealIntervals`, `untrustedOrigin`), the row is
 *   refused instead;
 * - opaque members (`content`, `cardSnapshot`, `aiContext`) are carried as
 *   they came, as the port types them (`unknown`).
 */
import { JsonValue } from "@silverprotocol/core";
import { readTapLabels } from "@guuey/mcp-apps-host/narrowing";
import { splitStoredThreadMemory } from "./fold-rows.js";
import {
  readThreadInputKind,
  type ClientClass,
  type HandoffEvent,
  type ReportEvent,
  type SealInterval,
  type ThreadMessageEvent,
  type ThreadMessageKind,
  type ThreadMessageRole,
  type ThreadMessageRow,
  type ThreadRow,
  type ThreadSnapshotRow,
  type TurnOrigin,
} from "./rows.js";
import { readSealState } from "./seal.js";
import type { ThreadScope } from "./http.js";

/** A JSON object as it came off the wire: every member is unread until narrowed. */
export interface WireObject {
  readonly [key: string]: unknown;
}

/** Whether `value` is a JSON object: not `null`, not an array, not a scalar. */
export function isWireObject(value: unknown): value is WireObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeqNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** The member when it is a string, else undefined (absent, null or another type). */
function optString(obj: WireObject, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

const MESSAGE_KINDS: readonly ThreadMessageKind[] = ["text", "card", "event"];
const MESSAGE_ROLES: readonly ThreadMessageRole[] = ["user", "agent", "system"];
const TURN_ORIGINS: readonly TurnOrigin[] = ["card_action", "chip", "typed"];
const CLIENT_CLASSES: readonly ClientClass[] = ["operator", "bot", "browser"];

/** `value` when it is one of `allowed`, else undefined. */
function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((member) => member === value);
}

/** `scope`'s result: the three strings the server binds the token to. */
export function readThreadScope(value: unknown): ThreadScope | undefined {
  if (!isWireObject(value)) return undefined;
  const { appId, userId, region } = value;
  if (typeof appId !== "string" || typeof userId !== "string" || typeof region !== "string") return undefined;
  return { appId, userId, region };
}

/** `incrementSeq`'s result: the integer seq the server allocated. */
export function readAllocatedSeq(value: unknown): number | undefined {
  return isSeqNumber(value) ? value : undefined;
}

/** A stored `sealIntervals`: absent, or intervals; `"unreadable"` when it is neither. */
function readSealIntervals(value: unknown): SealInterval[] | undefined | "unreadable" {
  const state = readSealState(value);
  if (state.kind === "none") return undefined;
  if (state.kind === "unreadable") return "unreadable";
  return [...state.intervals];
}

/** A `getThread` row. */
export function readThreadRow(value: unknown): ThreadRow | undefined {
  if (!isWireObject(value)) return undefined;
  const { id, userId, appId, servingRegion, title, status, pinned, lastSeq } = value;
  const { lastMessageAt, lastMessagePreview, threadMode, createdAt, updatedAt } = value;
  if (
    typeof id !== "string" ||
    typeof userId !== "string" ||
    typeof appId !== "string" ||
    typeof servingRegion !== "string" ||
    typeof title !== "string" ||
    typeof status !== "string" ||
    typeof pinned !== "boolean" ||
    !isSeqNumber(lastSeq) ||
    typeof lastMessageAt !== "string" ||
    typeof lastMessagePreview !== "string" ||
    typeof threadMode !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return undefined;
  }
  // A stored seal that does not read must not read as "no seal" (every message
  // readable); `readSealState` reads it as wholly sealed, so the row is refused.
  const sealIntervals = readSealIntervals(value.sealIntervals);
  if (sealIntervals === "unreadable") return undefined;
  const previewSeq = value.lastMessagePreviewSeq;
  const previewDigest = optString(value, "lastMessagePreviewDigest");
  const closedCode = optString(value, "closedCode");
  const closedMessage = optString(value, "closedMessage");
  const closedAt = optString(value, "closedAt");
  return {
    id,
    userId,
    appId,
    servingRegion,
    title,
    status,
    pinned,
    lastSeq,
    lastMessageAt,
    lastMessagePreview,
    ...(isSeqNumber(previewSeq) ? { lastMessagePreviewSeq: previewSeq } : {}),
    ...(previewDigest !== undefined ? { lastMessagePreviewDigest: previewDigest } : {}),
    ...(sealIntervals !== undefined ? { sealIntervals } : {}),
    ...(closedCode !== undefined ? { closedCode: closedCode } : {}),
    ...(closedMessage !== undefined ? { closedMessage: closedMessage } : {}),
    ...(closedAt !== undefined ? { closedAt: closedAt } : {}),
    threadMode,
    createdAt,
    updatedAt,
  };
}

/** A stored `event` this release reads; another `type`, or a malformed one, is not one ("not mine"). */
function readThreadMessageEvent(value: unknown): ThreadMessageEvent | undefined {
  if (!isWireObject(value)) return undefined;
  if (value.type === "handoff") {
    const question = value.question;
    if (typeof question !== "string") return undefined;
    const contactEmail = optString(value, "contactEmail");
    const contactName = optString(value, "contactName");
    const summary = optString(value, "summary");
    const event: HandoffEvent = {
      type: "handoff",
      question,
      ...(contactEmail !== undefined ? { contactEmail } : {}),
      ...(contactName !== undefined ? { contactName } : {}),
      ...(summary !== undefined ? { summary } : {}),
    };
    return event;
  }
  if (value.type === "report") {
    const { summary, reportedBy, wantedHuman } = value;
    if (typeof summary !== "string" || typeof reportedBy !== "string") return undefined;
    const contactEmail = optString(value, "contactEmail");
    const contactName = optString(value, "contactName");
    const event: ReportEvent = {
      type: "report",
      summary,
      ...(typeof wantedHuman === "boolean" ? { wantedHuman } : {}),
      ...(contactEmail !== undefined ? { contactEmail } : {}),
      ...(contactName !== undefined ? { contactName } : {}),
      reportedBy,
    };
    return event;
  }
  return undefined;
}

/** A message row (`listRecentMessages`, `findByClientMessageId`). */
export function readThreadMessageRow(value: unknown): ThreadMessageRow | undefined {
  if (!isWireObject(value)) return undefined;
  const { threadId, seq, userId, clientMessageId, at } = value;
  const kind = oneOf(MESSAGE_KINDS, value.kind);
  const authorRole = oneOf(MESSAGE_ROLES, value.authorRole);
  if (
    typeof threadId !== "string" ||
    !isSeqNumber(seq) ||
    typeof userId !== "string" ||
    typeof clientMessageId !== "string" ||
    typeof at !== "string" ||
    kind === undefined ||
    authorRole === undefined
  ) {
    return undefined;
  }
  // `untrustedOrigin` marks page-derived content; a stored value that is not a
  // boolean must not read as trusted, so the row is refused.
  const untrustedOrigin = value.untrustedOrigin;
  if (untrustedOrigin !== undefined && typeof untrustedOrigin !== "boolean") return undefined;
  const event = readThreadMessageEvent(value.event);
  const turnOrigin = oneOf(TURN_ORIGINS, value.turnOrigin);
  const clientClass = oneOf(CLIENT_CLASSES, value.clientClass);
  const inputKind = readThreadInputKind(value.inputKind);
  const tapLabels = readTapLabels(value.tapLabels);
  const text = optString(value, "text");
  const toolName = optString(value, "toolName");
  const answeredCardSessionId = optString(value, "answeredCardSessionId");
  return {
    threadId,
    seq,
    userId,
    clientMessageId,
    at,
    kind,
    authorRole,
    ...(text !== undefined ? { text } : {}),
    ...(value.content !== undefined ? { content: value.content } : {}),
    ...(value.cardSnapshot !== undefined ? { cardSnapshot: value.cardSnapshot } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(value.aiContext !== undefined ? { aiContext: value.aiContext } : {}),
    ...(untrustedOrigin !== undefined ? { untrustedOrigin } : {}),
    ...(event !== undefined ? { event } : {}),
    ...(turnOrigin !== undefined ? { turnOrigin } : {}),
    ...(inputKind !== undefined ? { inputKind } : {}),
    ...(answeredCardSessionId !== undefined ? { answeredCardSessionId } : {}),
    ...(clientClass !== undefined ? { clientClass } : {}),
    ...(tapLabels !== undefined ? { tapLabels } : {}),
  };
}

/** `listRecentMessages`' result: every row must read, or the list is refused. */
export function readThreadMessageRows(value: unknown): ThreadMessageRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: ThreadMessageRow[] = [];
  for (const entry of value) {
    const row = readThreadMessageRow(entry);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  return rows;
}

/**
 * A `getSnapshot` row. Its memory arrays are JSON (checked, never assumed); the
 * thread records are re-read through the one stored-memory reader
 * (`splitStoredThreadMemory`), and any element this release cannot read as a
 * thread record joins the carried elements, so it is kept, never dropped.
 */
export function readThreadSnapshotRow(value: unknown): ThreadSnapshotRow | undefined {
  if (!isWireObject(value)) return undefined;
  const { threadId, userId, updatedAt } = value;
  if (typeof threadId !== "string" || typeof userId !== "string" || typeof updatedAt !== "string") return undefined;
  const memory = JsonValue.array().safeParse(value.threadMemory);
  if (!memory.success) return undefined;
  let carried: JsonValue[] = [];
  if (value.carriedThreadMemory !== undefined) {
    const parsed = JsonValue.array().safeParse(value.carriedThreadMemory);
    if (!parsed.success) return undefined;
    carried = parsed.data;
  }
  let workingState: JsonValue | undefined;
  if (value.workingState !== undefined) {
    const parsed = JsonValue.safeParse(value.workingState);
    if (!parsed.success) return undefined;
    workingState = parsed.data;
  }
  const split = splitStoredThreadMemory(memory.data);
  const carriedThreadMemory = [...carried, ...split.carriedThreadMemory];
  const lastTurnId = optString(value, "lastTurnId");
  return {
    threadId,
    userId,
    ...(workingState !== undefined ? { workingState } : {}),
    threadMemory: split.threadMemory,
    ...(value.carriedThreadMemory !== undefined || carriedThreadMemory.length > 0 ? { carriedThreadMemory } : {}),
    ...(lastTurnId !== undefined ? { lastTurnId } : {}),
    updatedAt,
  };
}
