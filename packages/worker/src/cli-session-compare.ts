/**
 * Thread resume (guuey#3407 B3, 6a): the ONE comparison between what the platform recorded about a thread's Claude
 * CLI session and what the host measured in the stored session file before it starts the CLI on a `resume`
 * ({@link HelloStoredMeasures}). The host measures and never judges; the Router calls this, and the local resume kit
 * calls the same function, so the rule exists once.
 *
 * A refusal names its reason. The caller then starts the thread without the stored session (the history path), never
 * a resume it cannot vouch for: a missing or damaged file, an edit the host cannot classify, a file of another session,
 * or one whose last prompt is not the one the platform recorded.
 */
import type { HelloStoredMeasures } from "./protocol.js";

/** What the platform recorded when the thread's last turn ended. */
export interface CliSessionRecord {
  /** The session id the platform runs the thread's CLI session under (`Invoke.cliSession.id`). */
  readonly id: string;
  /** The hello's `lastPromptSha` of the thread's last turn: the hash of that turn's own user text. */
  readonly lastPromptSha: string;
}

/** Why a stored session is refused. */
export type CliSessionRefusal =
  | "unreadable"
  | "corrupt"
  | "unclassified"
  | "no-session-ids"
  | "other-session"
  | "no-last-prompt"
  | "last-prompt-differs";

/** The verdict on one stored session. */
export type CliSessionVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: CliSessionRefusal };

/**
 * Whether the stored session may be resumed for `record`. In order: the file must be readable, undamaged and wholly
 * classified; every session id written in it must be `record.id` (a prompt hash alone cannot tell two threads whose
 * last prompts are equal apart); and its LAST last-prompt must be the one recorded (a file cut short, or rolled back,
 * ends on an earlier prompt).
 */
export function compareStoredSession(record: CliSessionRecord, stored: HelloStoredMeasures): CliSessionVerdict {
  if (stored.readError !== undefined) return { ok: false, reason: "unreadable" };
  if (stored.corrupt > 0) return { ok: false, reason: "corrupt" };
  if (stored.unclassified > 0) return { ok: false, reason: "unclassified" };
  const ids = stored.sessionIds;
  if (ids === undefined || ids.length === 0) return { ok: false, reason: "no-session-ids" };
  if (ids.some((id) => id !== record.id)) return { ok: false, reason: "other-session" };
  const last = stored.lastPromptShas[stored.lastPromptShas.length - 1];
  if (last === undefined) return { ok: false, reason: "no-last-prompt" };
  if (last !== record.lastPromptSha) return { ok: false, reason: "last-prompt-differs" };
  return { ok: true };
}
