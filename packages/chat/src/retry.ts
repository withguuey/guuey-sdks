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
