/**
 * guuey#2549 / guuey#2877: the ONE list of input kinds, what a user turn's
 * content rides on when its text is empty. `context-only`: the turn's content
 * is the page context the app sent (a photo the app named there, say), and
 * the user typed nothing. More kinds are added additively, here and only here.
 *
 * Every package that names an input kind reads this file: the worker protocol,
 * `@guuey/agent-client` and `@guuey/threads`. It is published on its own
 * subpath, `@guuey/worker/input-kinds`, and imports nothing, so a browser
 * bundle can take it without the worker's Node-only entry.
 */

/** Every input kind, in wire spelling. */
export const INPUT_KINDS = ["context-only"] as const;

/** One input kind. */
export type InputKind = (typeof INPUT_KINDS)[number];

/** Whether `value` is a known input kind; anything else, including a kind this release does not know, is not. */
export function isInputKind(value: unknown): value is InputKind {
  return typeof value === "string" && INPUT_KINDS.some((kind) => kind === value);
}

/**
 * The hello capability name a worker declares when it handles turns of this kind (an empty
 * `input` plus `inputKind`). A Router sends such a turn ONLY to a worker whose hello for that
 * same invoke declared it.
 */
export function inputKindCapability(kind: InputKind): string {
  return `input-kind:${kind}`;
}
