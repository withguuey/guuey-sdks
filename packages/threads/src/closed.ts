/**
 * A closed conversation (see {@link ThreadRow.closedAt}): how a stored row
 * reads as closed, and the error a binding answers an append on one with.
 */
import type { ThreadClosure, ThreadRow } from "./rows.js";

/**
 * The thread's closure, or `undefined` while it is open. `closedAt` alone
 * decides: a row without it (every row written before closing existed) is
 * open, and a row with it is closed even when its reason did not land
 * (`code`/`message` then read as `""`).
 */
export function threadClosure(row: ThreadRow): ThreadClosure | undefined {
  if (typeof row.closedAt !== "string" || row.closedAt.length === 0) return undefined;
  return {
    code: typeof row.closedCode === "string" ? row.closedCode : "",
    message: typeof row.closedMessage === "string" ? row.closedMessage : "",
    at: row.closedAt,
  };
}

/**
 * A binding's answer to `incrementSeq` on a closed thread: the conversation
 * takes no new message. A caller that meant to continue it starts a new one.
 */
export class ThreadClosedError extends Error {
  readonly code = "THREAD_CLOSED";
  constructor(readonly threadId: string) {
    super(`thread ${threadId} is closed`);
    this.name = "ThreadClosedError";
  }
}
