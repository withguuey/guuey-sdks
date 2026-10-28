/**
 * The one way a failed user turn is sent again (guuey#2549): the arguments
 * `useAgentInvoke`'s `send` takes for it, so every surface's Retry re-sends
 * exactly what the turn was. A turn sent without words goes again without
 * words (its kind, never an invented sentence); an action turn goes again
 * with its tapped words beside the directive (guuey#2031); anything else is
 * its text.
 */
import type { SendOptions } from "@guuey/agent-client";
import type { UserMessageItem } from "./types.js";

export function retrySendArgs(item: UserMessageItem): [string, SendOptions | undefined] {
  if (item.inputKind !== undefined) return ["", { inputKind: item.inputKind }];
  if (item.tapLabels !== undefined) return [item.text, { tapLabels: item.tapLabels }];
  return [item.text, undefined];
}

/**
 * The same re-send, taking the failed row's place (guuey#2608): the
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
