/**
 * The ack gate, one rule: did the runtime accept everything this turn sent?
 *
 * A runtime that predates a part kind parses the turn and ignores the kind, so it would answer the words alone. The
 * hook asks this on the turn's `session` frame and cuts the turn (PARTS_UNSUPPORTED) before any reply when the answer
 * is no. It is exported so a runtime's own test can feed its real `session` frame (through {@link readAccepts}) to the
 * same rule the hook runs, never a copy of it.
 *
 * - Shape 1 carries images only: every image must be counted in `accepts.attachments`.
 * - Shape 2: for every kind the turn sent, `accepts.parts[kind]` must equal the count sent. A kind that was not sent
 *   is never asked about, and an absent `accepts.parts` acknowledges nothing.
 */
import type { Accepts } from "./input-kinds.js";
import { USER_PART_KINDS, type UserPart, type UserPartKind } from "./user-parts.js";

/** What one turn sent, as the gate counts it, in the request shape its body actually went in. */
export type TurnSent =
  | { readonly shape: 1; readonly images: number }
  | { readonly shape: 2; readonly parts: { readonly [kind in UserPartKind]?: number } };

/** The runtime's word on this turn: the two `accepts` members the gate reads (an {@link Accepts} is one). */
export type TurnAccepted = Pick<Accepts, "attachments" | "parts">;

/** How many of a turn's parts are of each kind; a kind with none is absent. */
export function countPartKinds(parts: readonly UserPart[]): { [kind in UserPartKind]?: number } {
  const counts: { [kind in UserPartKind]?: number } = {};
  for (const part of parts) counts[part.type] = (counts[part.type] ?? 0) + 1;
  return counts;
}

/** True when the runtime accepted everything the turn sent (see the module doc for the rule per shape). */
export function partsAcknowledged(accepted: TurnAccepted, sent: TurnSent): boolean {
  if (sent.shape === 1) return sent.images === 0 || accepted.attachments === sent.images;
  return USER_PART_KINDS.every((kind) => {
    const count = sent.parts[kind] ?? 0;
    return count === 0 || accepted.parts?.[kind] === count;
  });
}
