/**
 * The one first step every response read in this package takes: a parsed body
 * is `unknown`, and it is an object only once this guard says so. Its members
 * stay `unknown` until the reader at the call site narrows the one it reads,
 * so a body of the wrong shape (an array, `null`, a scalar, a member of the
 * wrong type) is refused where it is read instead of failing deeper in.
 */

/** A JSON object as it came off the wire: every member is unread until narrowed. */
export interface WireObject {
  readonly [key: string]: unknown;
}

/** Whether `value` is a JSON object: not `null`, not an array, not a scalar. */
export function isWireObject(value: unknown): value is WireObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
