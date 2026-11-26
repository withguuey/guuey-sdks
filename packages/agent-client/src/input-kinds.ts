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
 * behalf. The list is this package's own copy, held equal to
 * `@guuey/worker/input-kinds` (the one list, guuey#2877) by the runtime's
 * sync test. It is a copy on purpose: server bundles reach this package
 * through `@guuey/chat` (a Lambda's theme schema), and a Lambda whose alarm
 * reads its log lines must never reach `@guuey/worker`, whose worker writes
 * its own stdout and stderr by design. So this package does not depend on it.
 */
import { isUserPartKind, USER_PART_KINDS, type UserPartKind } from "./user-parts.js";

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

/** What a `session` frame says the runtime accepted ({@link readAccepts}). */
export interface Accepts {
  /** The input kinds the agent accepts on its NEXT turn (guuey#2549), known kinds only, each once, in wire order. */
  inputKinds: readonly InputKind[];
  /** How many of THIS turn's images it accepted (guuey#2293), only as a whole non-negative count. */
  attachments?: number;
  /**
   * The highest request shape the runtime parses (request-shape design v6): `2` = the `AgInput` body. Absent on every
   * runtime before it, so the client writes shape 1. One pod's hint, never a promise (W1 keeps a fallback).
   */
  requestShape?: number;
  /** The user part kinds the agent takes on its NEXT turn (the per-kind gate's advertisement); `[]` when none listed. */
  partKinds: readonly UserPartKind[];
  /** How many of THIS turn's parts of each kind it accepted (the generalized per-kind ack), whole counts only. */
  parts?: { readonly [kind in UserPartKind]?: number };
}

function wholeCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** A wire object's own member, read without a cast (the frame is untyped JSON). */
function member(o: object, key: string): unknown {
  const own: unknown = Object.getOwnPropertyDescriptor(o, key)?.value;
  return own;
}

/**
 * What a `session` frame says the runtime accepted, read off its one `accepts` block (guuey#2876). Every member is
 * optional on the wire: an absent or malformed block, or member, reads as "none" (an older runtime sends none), never a
 * throw.
 */
export function readAccepts(frame: unknown): Accepts {
  const none: Accepts = { inputKinds: [], partKinds: [] };
  if (typeof frame !== "object" || frame === null) return none;
  const accepts = member(frame, "accepts");
  if (typeof accepts !== "object" || accepts === null || Array.isArray(accepts)) return none;
  const inputKinds: InputKind[] = [];
  const kinds = member(accepts, "inputKinds");
  if (Array.isArray(kinds)) for (const kind of kinds) if (isInputKind(kind) && !inputKinds.includes(kind)) inputKinds.push(kind);
  const partKinds: UserPartKind[] = [];
  const rawPartKinds = member(accepts, "partKinds");
  if (Array.isArray(rawPartKinds)) {
    for (const kind of rawPartKinds) {
      if (typeof kind === "string" && isUserPartKind(kind) && !partKinds.includes(kind)) partKinds.push(kind);
    }
  }
  const attachments = wholeCount(member(accepts, "attachments"));
  const requestShape = wholeCount(member(accepts, "requestShape"));
  const rawParts = member(accepts, "parts");
  let parts: { [kind in UserPartKind]?: number } | undefined;
  if (typeof rawParts === "object" && rawParts !== null && !Array.isArray(rawParts)) {
    parts = {};
    for (const kind of USER_PART_KINDS) {
      const n = wholeCount(member(rawParts, kind));
      if (n !== undefined) parts[kind] = n;
    }
  }
  return {
    inputKinds,
    partKinds,
    ...(attachments !== undefined ? { attachments } : {}),
    ...(requestShape !== undefined ? { requestShape } : {}),
    ...(parts !== undefined ? { parts } : {}),
  };
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
