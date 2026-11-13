/**
 * What the host does with one fd-0 control line (guuey#3434). A line the host
 * cannot use never ends the process: a newer Router may send a control type
 * this release does not know, and an older host that died on it would take
 * every later turn of its pod with it.
 *
 * - `invoke`: run the turn.
 * - `shutdown`: leave the loop.
 * - `skip`: a well-formed line of a type this release does not know, or a line
 *   that is not a control message at all. One stderr note, nothing on fd 3, and
 *   the loop reads on.
 * - `refuse`: a line that IS an invoke but is malformed. One `error` event, so
 *   the Router is not left waiting for a turn that will never run, and the loop
 *   reads on.
 *
 * No note and no error ever carries the line's own bytes. Only a type string,
 * truncated to {@link CONTROL_NOTE_TYPE_MAX} characters, is named.
 */
import { isShutdown, isUnknownControl, parseControl, type ControlMessage, type Invoke } from "@guuey/worker";

/** The most characters of an unknown `type` a note names. */
export const CONTROL_NOTE_TYPE_MAX = 64;

export type ControlStep =
  | { readonly kind: "invoke"; readonly invoke: Invoke }
  | { readonly kind: "shutdown" }
  | { readonly kind: "skip"; readonly note: string }
  | { readonly kind: "refuse"; readonly note: string; readonly error: string };

export function readControlLine(line: string): ControlStep {
  let msg: ControlMessage;
  try {
    msg = parseControl(line);
  } catch (err) {
    return refusalOf(line, err);
  }
  if (isShutdown(msg)) return { kind: "shutdown" };
  if (isUnknownControl(msg)) {
    return { kind: "skip", note: `[guuey] skipped a control line of unknown type ${JSON.stringify(msg.rawType.slice(0, CONTROL_NOTE_TYPE_MAX))}` };
  }
  return { kind: "invoke", invoke: msg };
}

/** Why a line `parseControl` refused cannot be used, without quoting it. */
function refusalOf(line: string, err: unknown): ControlStep {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: "skip", note: "[guuey] skipped a control line that is not JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "skip", note: "[guuey] skipped a control line that is not a JSON object" };
  }
  if (!("type" in raw) || raw.type !== "invoke") {
    return { kind: "skip", note: "[guuey] skipped a control line with no string type" };
  }
  // An invoke's own field checks name a field, never its value (worker parse.ts).
  const why = err instanceof Error ? err.message : String(err);
  return { kind: "refuse", note: `[guuey] refused a malformed invoke: ${why}`, error: `@guuey/host: invoke refused: ${why}` };
}
