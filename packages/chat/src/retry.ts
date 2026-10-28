/**
 * What a failed user turn was, as the arguments `useAgentInvoke`'s `send`
 * takes for it (guuey#2549), so a Retry re-sends exactly that turn. A turn
 * sent without words goes again without words (its kind, never an invented
 * sentence); an action turn goes again with its tapped words beside the
 * directive (guuey#2031); anything else is its text.
 *
 * A host's Retry calls {@link retryInPlaceArgs}, which builds on this and
 * adds the failed row's place; calling this alone re-sends the turn beside
 * its old failed row.
 */
import type { SendOptions } from "@guuey/agent-client";
import type { UserMessageItem } from "./types.js";

export function retrySendArgs(item: UserMessageItem): [string, SendOptions | undefined] {
  if (item.inputKind !== undefined) return ["", { inputKind: item.inputKind }];
  if (item.tapLabels !== undefined) return [item.text, { tapLabels: item.tapLabels }];
  return [item.text, undefined];
}

/**
 * The retry rule a host's Retry calls (guuey#2608): the
 * {@link retrySendArgs} arguments plus `replaces`, the failed row's own
 * `clientMessageId`, so `useAgentInvoke` drops that row as the new send
 * starts and the turn is drawn once, never beside its old "Couldn't send"
 * row. Only a failed row names itself: a row that reached the agent (or one
 * the plan gave no id) re-sends as {@link retrySendArgs} says and stays where
 * it is. `replaces` is local to the hook and never rides the wire.
 */
export function retryInPlaceArgs(item: UserMessageItem): [string, SendOptions | undefined] {
  const [text, options] = retrySendArgs(item);
  if (item.state !== "failed" || item.clientMessageId === undefined) return [text, options];
  return [text, { ...options, replaces: item.clientMessageId }];
}
