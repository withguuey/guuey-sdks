/**
 * guuey#2549: the ONE place a turn's text becomes the words the model reads.
 *
 * A user turn whose content rode on the page context (`inputKind: "context-only"`, the user typed
 * nothing) has empty text, and a provider refuses an empty text block. Every framework arm's
 * current input AND the history preamble go through {@link modelTextOf}, so the model reads the
 * same fixed sentence for that turn on this turn and on every later one, on every framework. The
 * sentence is never stored: the thread keeps the empty text and the kind.
 */
import { inputKindCapability, type InputKind } from "@guuey/worker";

/** The model-only sentence for a context-only turn. Versioned with this package; never persisted. */
export const CONTEXT_ONLY_TURN_TEXT =
  "The user sent this turn without any text. Respond to what the page context carries.";

/** The input kinds this host handles, declared on its hello as capability names. */
export const HOST_INPUT_KIND_CAPABILITIES: readonly string[] = [inputKindCapability("context-only")];

/**
 * The words the model reads for a turn. A Router sends `inputKind` only when the user typed
 * nothing, so for a context-only turn the user's words ARE the fixed sentence: it stands alone in
 * the history (a stored row's text is empty), and on the current turn it follows whatever the
 * Router framed ahead of the empty input (the page context), never replacing it.
 */
export function modelTextOf(turn: { text: string; inputKind?: InputKind }): string {
  if (turn.inputKind !== "context-only") return turn.text;
  return turn.text.trim() === "" ? CONTEXT_ONLY_TURN_TEXT : `${turn.text}\n\n${CONTEXT_ONLY_TURN_TEXT}`;
}

/**
 * The current turn's model text, with the substitution logged (metadata only: the kind, never
 * any text) so an operator can see it in the worker's stderr stream.
 */
export function modelInputOf(turn: { input: string; inputKind?: InputKind }): string {
  const text = modelTextOf({ text: turn.input, ...(turn.inputKind !== undefined ? { inputKind: turn.inputKind } : {}) });
  if (text !== turn.input) process.stderr.write(`[guuey] input substituted: kind=${String(turn.inputKind)}\n`);
  return text;
}
