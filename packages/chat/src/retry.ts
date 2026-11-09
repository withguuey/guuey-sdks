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
 *
 * An A2UI action turn (guuey#2384, spec §9.3) carries its own
 * `clientMessageId` as the block's `id`, so a retry mints the new turn's id
 * with `newId` (the hook's `newClientMessageId`) and writes the block again
 * under it; the send carries the same id. Without `newId` the text goes as it
 * was and the hook mints the turn's id, as for any typed turn.
 */
import type { SendOptions } from "@guuey/agent-client";
import { reissueA2uiActionText } from "@guuey/mcp-apps-host/narrowing";
import type { UserMessageItem } from "./types.js";

export function retrySendArgs(item: UserMessageItem, newId?: () => string): [string, SendOptions | undefined] {
  if (item.inputKind !== undefined) return ["", { inputKind: item.inputKind }];
  if (item.actionSummary !== undefined && newId !== undefined) {
    const clientMessageId = newId();
    const text = reissueA2uiActionText(item.text, clientMessageId);
    if (text !== undefined) return [text, { clientMessageId }];
  }
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
export function retryInPlaceArgs(item: UserMessageItem, newId?: () => string): [string, SendOptions | undefined] {
  const [text, options] = retrySendArgs(item, newId);
  if (item.state !== "failed" || item.clientMessageId === undefined) return [text, options];
  return [text, { ...options, replaces: item.clientMessageId }];
}
