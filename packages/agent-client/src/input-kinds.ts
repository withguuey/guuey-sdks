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
 * behalf. The list is this package's own copy (it depends on no runtime
 * package); the runtime's tests pin it equal to the worker protocol's list.
 */

/** Every input kind this client can send, in wire spelling. */
export const INPUT_KINDS = ["context-only"] as const;

/** One input kind. */
export type InputKind = (typeof INPUT_KINDS)[number];

/** Whether `value` is a known input kind; anything else, including a kind this release does not know, is not. */
export function isInputKind(value: unknown): value is InputKind {
  return typeof value === "string" && INPUT_KINDS.some((kind) => kind === value);
}

/**
 * The input kind a stored row keeps: only a user row's, and only a kind this
 * release knows. This is the one rule every transcript mapper calls, so a
 * reload draws the line the live session drew.
 */
export function userInputKindOf(role: string, inputKind: unknown): InputKind | undefined {
  return role === "user" && isInputKind(inputKind) ? inputKind : undefined;
}

/**
 * The input kinds a `session` frame says the agent accepts (`accepts.inputKinds`):
 * known kinds only, each once, in wire order. An absent or malformed block is
 * `[]` (an older runtime sends none), never a throw.
 */
export function readAcceptedInputKinds(frame: unknown): readonly InputKind[] {
  if (typeof frame !== "object" || frame === null || !("accepts" in frame)) return [];
  const accepts = frame.accepts;
  if (typeof accepts !== "object" || accepts === null || Array.isArray(accepts) || !("inputKinds" in accepts)) return [];
  const kinds = accepts.inputKinds;
  if (!Array.isArray(kinds)) return [];
  const out: InputKind[] = [];
  for (const kind of kinds) if (isInputKind(kind) && !out.includes(kind)) out.push(kind);
  return out;
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
