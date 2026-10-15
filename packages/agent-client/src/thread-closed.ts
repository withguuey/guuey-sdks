/**
 * Reading a conversation's closure ({@link ThreadClosed}) off the wire: the
 * closing turn's `event: error` / `event: done` frames and the transcript
 * read's `thread.closed`. One reader for every source, so they agree.
 */
import type { ThreadClosed } from "./types.js";
import type { ThreadHistoryRow } from "./history.js";

/** The prefix a code-mode worker's own reason arrives under. */
export const APP_CODE_PREFIX = "app:";

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

/**
 * `value` as a {@link ThreadClosed}, or undefined unless it is an object with
 * a non-empty string `code` and a non-empty string `message` (`closedAt` is
 * kept when it is a non-empty string, else null). A malformed value reads as
 * "not closed": the conversation stays usable rather than shut on a guess.
 */
export function readThreadClosed(value: unknown): ThreadClosed | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const code = field(value, "code");
  const message = field(value, "message");
  const closedAt = field(value, "closedAt");
  if (typeof code !== "string" || code === "" || typeof message !== "string" || message === "") return undefined;
  return { code, message, closedAt: typeof closedAt === "string" && closedAt !== "" ? closedAt : null };
}

/**
 * The closure an older read plane implies (one that sends no `thread`
 * field): the transcript's LAST row is the agent's failure row with an
 * `app:` code, which is how the closing turn is stored. Its text is the
 * agent's message; when it was closed is unknown.
 */
export function closureFromLastRow(rows: readonly ThreadHistoryRow[]): ThreadClosed | undefined {
  const last = rows[rows.length - 1];
  if (last === undefined || last.kind !== "text" || last.authorRole === "user") return undefined;
  const code = last.failure != null && typeof last.failure === "object" ? last.failure.code : undefined;
  if (typeof code !== "string" || !code.startsWith(APP_CODE_PREFIX) || code.length === APP_CODE_PREFIX.length) return undefined;
  if (typeof last.text !== "string" || last.text === "") return undefined;
  return { code, message: last.text, closedAt: null };
}
