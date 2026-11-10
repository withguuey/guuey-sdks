/**
 * Input kinds (guuey#2549): a turn whose content rides outside its text. The
 * one kind today is `context-only`: the user typed nothing (a photo, say) and
 * the content rode on the page context the app sent with the turn. On the wire
 * it is `input: ""` beside `inputKind: "context-only"`.
 *
 * The runtime is the only judge of whether an agent takes such a turn: it
 * accepts one only when the agent's worker declared the kind, and otherwise
 * refuses the body before the stream starts, storing nothing. This client
 * carries the kind and reads the refusal; it never decides on the agent's
 * behalf. The list, its type and `isInputKind` are from `@guuey/worker`
 * (`@guuey/worker/input-kinds`, the one list, guuey#2877), re-exported here
 * under the same names.
 */
import { isInputKind, type InputKind } from "@guuey/worker/input-kinds";

export { INPUT_KINDS, isInputKind, type InputKind } from "@guuey/worker/input-kinds";

/**
 * The input kind a stored row keeps: only a user row's, and only a kind this
 * release knows. This is the one rule every transcript mapper calls, so a
 * reload draws the line the live session drew.
 */
export function userInputKindOf(role: string, inputKind: unknown): InputKind | undefined {
  return role === "user" && isInputKind(inputKind) ? inputKind : undefined;
}

/**
 * What a `session` frame says the runtime accepted, read off its one `accepts`
 * block (guuey#2876):
 *  - `inputKinds`: the input kinds the agent accepts on its NEXT turn
 *    (guuey#2549), known kinds only, each once, in wire order; `[]` when the
 *    block lists none.
 *  - `attachments`: how many of THIS turn's images it accepted (guuey#2293),
 *    present only as a whole non-negative count.
 * An absent or malformed block reads as `{ inputKinds: [] }` (an older runtime
 * sends none), never a throw.
 */
export function readAccepts(frame: unknown): { inputKinds: readonly InputKind[]; attachments?: number } {
  if (typeof frame !== "object" || frame === null || !("accepts" in frame)) return { inputKinds: [] };
  const accepts = frame.accepts;
  if (typeof accepts !== "object" || accepts === null || Array.isArray(accepts)) return { inputKinds: [] };
  const inputKinds: InputKind[] = [];
  const kinds = "inputKinds" in accepts ? accepts.inputKinds : undefined;
  if (Array.isArray(kinds)) for (const kind of kinds) if (isInputKind(kind) && !inputKinds.includes(kind)) inputKinds.push(kind);
  const attachments = "attachments" in accepts ? accepts.attachments : undefined;
  return typeof attachments === "number" && Number.isInteger(attachments) && attachments >= 0
    ? { inputKinds, attachments }
    : { inputKinds };
}

/** The input kinds a `session` frame says the agent accepts ({@link readAccepts}'s `inputKinds`). */
export function readAcceptedInputKinds(frame: unknown): readonly InputKind[] {
  return readAccepts(frame).inputKinds;
}

/**
 * Whether a runtime's pre-stream refusal message is its refusal of a turn
 * without text. Two runtime generations word it: one that predates input kinds
 * refuses any empty input ("input: non-empty string required"), and one that
 * knows them refuses a kind its agent has not declared ("inputKind: <kind> is
 * not accepted by this agent yet; send text"). Both arrive as a 400 with the
 * code `INVALID_REQUEST`, which other refusals share, so the message is the
 * one discriminator. The runtime's tests pin both strings against this
 * function.
 */
export function isInputKindRefusal(message: string): boolean {
  return /^input: non-empty string required$/.test(message) || /^inputKind: \S+ is not accepted by this agent yet\b/.test(message);
}
