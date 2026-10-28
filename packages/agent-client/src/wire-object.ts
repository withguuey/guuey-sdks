/**
 * The one first step every response read in this package takes: a parsed body
 * is `unknown`, and it is an object only once this guard says so. Its members
 * stay `unknown` until the reader at the call site narrows the one it reads,
 * so a body of the wrong shape (an array, `null`, a scalar, a member of the
 * wrong type) is refused where it is read instead of failing deeper in.
 *
 * `@guuey/threads` keeps the same guard (`http-read.ts`). It is not shared
 * because no package both depend on exports one that reads an `unknown`:
 * `@guuey/mcp-apps-host`'s `isJsonObject` takes a `JsonValue` and narrows its
 * members to `JsonValue`, which a parsed body is not proven to be, and the two
 * packages do not depend on each other. The guard is one line and every member
 * it yields is narrowed at its read.
 */

/** A JSON object as it came off the wire: every member is unread until narrowed. */
export interface WireObject {
  readonly [key: string]: unknown;
}

/** Whether `value` is a JSON object: not `null`, not an array, not a scalar. */
export function isWireObject(value: unknown): value is WireObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
