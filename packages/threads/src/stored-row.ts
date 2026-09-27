/**
 * What a stored thread row IS, for every reader that turns rows back into
 * conversation. Some stored rows are not "the agent said this", and reading
 * them as such replays them to the model as the agent's own words and draws
 * them as answer bubbles:
 *
 *  - a FAILURE row: the runtime's reader line for a failed turn, keyed
 *    `…#agentError`. It carries `content.error.code` from the runtime release
 *    that added codes; rows written before it carry only `{kind:'text', text}`,
 *    so the key suffix alone must classify them too;
 *  - a NOTICE row: a stored message with `role: "notice"` (a framework notice
 *    the agent facet emits), a non-conversational, user-facing row;
 *  - a BLANK row: an agent message whose every block shows the reader nothing
 *    (an empty text part, or a provider carry with nothing in it).
 *
 * The reader is lenient: it reads the stored `content` through the core's
 * stored-record reader, so a row written before any of this is classified the
 * same way, with no migration.
 */
import { readStoredAgMessage, type AgBlock, type JsonValue } from "@silverprotocol/core";
import type { ThreadMessageRow } from "./rows.js";

/** The clientMessageId suffix the runtime gives a failed turn's reader-line row. */
export const AGENT_ERROR_ROW_SUFFIX = "#agentError";

/**
 * True when a JSON value carries no information a reader could act on:
 * `null`/`undefined`, the empty string, an empty array or object, or an
 * array/object whose every member is itself informationless. Numbers and
 * booleans are information. The same rule `@guuey/chat` applies to a provider
 * carry it hides from the transcript.
 */
export function isInformationless(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value === "";
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (Array.isArray(value)) return value.every((v) => isInformationless(v));
  return Object.values(value).every((v) => isInformationless(v));
}

/**
 * A block the reader's transcript shows nothing for: an empty text part, or a
 * `provider-raw` carry whose payload is informationless. Every other block,
 * reasoning included, is something a reader can see. ONE predicate for the
 * runtime's turn watch, its stored fold, and this classifier.
 */
export function isBlankBlock(block: AgBlock): boolean {
  if (block.type === "text") return block.text === "";
  if (block.type === "provider-raw") return isInformationless(block.raw);
  return false;
}

/** The class of one stored row. */
export type StoredRowClass =
  | { kind: "conversation" }
  /** A failed turn's reader line. `code` is null on a row stored before codes were persisted. */
  | { kind: "failure"; code: string | null }
  /** A framework notice. `source` is the injecting layer when the row names one. */
  | { kind: "notice"; source: string | null }
  | { kind: "blank" };

/** The failure code a row's content carries (`content.error.code`), when it carries one. */
function failureCodeOf(content: unknown): string | undefined {
  if (typeof content !== "object" || content === null || !("error" in content)) return undefined;
  const error = content.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" && error.code !== "" ? error.code : undefined;
}

/** Classify one stored row (see the module doc). */
export function classifyStoredRow(
  row: Pick<ThreadMessageRow, "clientMessageId" | "authorRole" | "content">,
): StoredRowClass {
  const code = failureCodeOf(row.content);
  if (row.clientMessageId.endsWith(AGENT_ERROR_ROW_SUFFIX) || code !== undefined) {
    return { kind: "failure", code: code ?? null };
  }
  if (row.authorRole === "user") return { kind: "conversation" };
  const stored = readStoredAgMessage(row.content).value;
  if (stored === undefined) return { kind: "conversation" };
  if (stored.role === "notice") return { kind: "notice", source: stored.noticeSource ?? null };
  if (stored.content.every(isBlankBlock)) return { kind: "blank" };
  return { kind: "conversation" };
}
