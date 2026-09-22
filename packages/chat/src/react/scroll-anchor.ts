/**
 * The turn's card anchor (guuey#1328): auto-follow never scrolls the current
 * turn's first card above the top of the viewport.
 *
 * Stick-to-bottom (§3.2) re-pins on every content resize. That was built for
 * cards, but a card that connects and GROWS past the panel was therefore
 * pushed out of view by its own growth, and the prose streaming beside it
 * held the viewer at the tail. QA measured it on prod: 140 px of a 560 px
 * card on screen at first rest, "painted but not shown". The follow target is
 * now clamped at the top of the turn's first card. The card settles at its
 * top, the prose continues below it, and "Jump to latest" offers the rest.
 *
 * Two pure pieces, so the rule is unit-tested without layout:
 *  - {@link planTurnAnchor} reads the anchor off the PLAN (component-agnostic),
 *    not off class names alone;
 *  - {@link followTarget} is the clamp.
 * `<Transcript>` joins them to the DOM, and only while the DOM agrees with the
 * plan (see `transcript.tsx`).
 */
import type { DisplayItem } from "../types.js";

/** Room kept above an anchored card, so its border and radius read as its top. */
export const ANCHOR_GAP_PX = 12;

export interface TurnAnchorPlan {
  /**
   * The current turn's identity: the key of the last user message, or `""`
   * before any (an agent-first hello). A change means a NEW turn, which
   * re-pins the transcript and re-arms the anchor.
   */
  turnKey: string;
  /** How many `view` items the rendered items carry, all turns. */
  viewCount: number;
  /**
   * The anchor card's position among those views (0-based): the FIRST view
   * after the last user message. `null` when the current turn has no card.
   */
  anchorOrdinal: number | null;
}

/** Read the current turn's anchor off the rendered items (in render order). */
export function planTurnAnchor(items: readonly DisplayItem[]): TurnAnchorPlan {
  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.kind === "user") {
      lastUser = i;
      break;
    }
  }
  let viewCount = 0;
  let anchorOrdinal: number | null = null;
  items.forEach((item, i) => {
    if (item.kind !== "view") return;
    if (i > lastUser && anchorOrdinal === null) anchorOrdinal = viewCount;
    viewCount++;
  });
  const userItem = lastUser >= 0 ? items[lastUser] : undefined;
  return { turnKey: userItem?.key ?? "", viewCount, anchorOrdinal };
}

export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface FollowTarget {
  /** The scrollTop auto-follow moves to. */
  top: number;
  /** True when the anchor, not the bottom, decided it (there is more below). */
  held: boolean;
}

/**
 * Where auto-follow scrolls: the bottom, unless that would carry the anchor
 * card's top (`anchorTop`, in scroll-content coordinates) above the viewport.
 * In that case it goes to the anchor instead, and never scrolls UP to reach
 * it: an anchor already above the current position holds the viewer where
 * they are.
 */
export function followTarget(geom: ScrollGeometry, anchorTop: number | null): FollowTarget {
  const bottom = Math.max(0, geom.scrollHeight - geom.clientHeight);
  if (anchorTop === null) return { top: bottom, held: false };
  const anchor = Math.max(0, anchorTop - ANCHOR_GAP_PX);
  if (anchor >= bottom) return { top: bottom, held: false };
  return { top: Math.min(bottom, Math.max(anchor, geom.scrollTop)), held: true };
}
