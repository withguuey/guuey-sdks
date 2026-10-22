/**
 * guuey#2554: the host's scroll API on a transcript — ONE definition that every transcript
 * component implements: the web `<Transcript>` now, `NativeTranscript` later (guuey#2569), so a
 * host writes the same code for both. Types only; each component owns its behaviour.
 *
 * Recipe (a chat where the reader reads the answer while it streams, the page never moving under
 * their eye): pass `follow="off"`; when a NEW user item appears in the plan, call
 * `handle.scrollToItem(userItemKey, { align: "top" })` once (with `offset` for a fixed header);
 * then do nothing until the reply ends. Show your own "↓" from `onAtEndChange(false)` with
 * `jumpToLatest={false}`, and call `handle.scrollToEnd()` when it is tapped — the transcript then
 * follows the stream until the reader scrolls away. `transcript-scroll.test.tsx` runs this recipe.
 */
import type { Ref } from "react";

/**
 * What content growth does to the viewport. `"tail"` (the default, and the behaviour before this
 * API) follows the stream while the reader is at the end. `"off"` never moves the viewport on
 * growth: following starts only when the host calls {@link TranscriptScrollHandle.scrollToEnd} (or the
 * reader taps the built-in chip), until the reader scrolls away from the end.
 */
export type TranscriptFollow = "tail" | "off";

export interface TranscriptScrollOptions {
  /** `"smooth"` is downgraded to instant under `prefers-reduced-motion`. Default `"auto"`. */
  behavior?: "smooth" | "auto";
}

export interface TranscriptScrollToItemOptions extends TranscriptScrollOptions {
  /** Where the item lands: its top at the viewport's top, or its bottom at the viewport's bottom. Default `"top"`. */
  align?: "top" | "end";
  /** Pixels kept between the item and the aligned edge (room for a fixed header). Default 0. */
  offset?: number;
}

/**
 * The host's handle on a transcript's scrolling, through `handleRef`: the framework-neutral CORE
 * every transcript implements. A component may extend it (the web `<Transcript>`'s
 * `TranscriptHandle` adds the scroll `element`).
 */
export interface TranscriptScrollHandle {
  /**
   * Scroll the item with this plan key into place, and stop following. Returns `false`, without
   * scrolling, when the item is not rendered (an unknown key, an item behind the "show earlier"
   * window, or an item the kit's own slot renders as nothing) or when the rendered elements do
   * not line up with the plan (a custom component rendering more or fewer than one element per
   * item): the transcript never guesses which element is the item. The jump chip and the at-end
   * signal update on the next scroll event the move produces; a target already in place produces
   * none.
   */
  scrollToItem(key: string, opts?: TranscriptScrollToItemOptions): boolean;
  /** Go to the end and follow the stream from there, until the reader scrolls away from the end. */
  scrollToEnd(opts?: TranscriptScrollOptions): void;
}

/** The scroll props every transcript component takes; `H` is that component's handle. */
export interface TranscriptScrollProps<H extends TranscriptScrollHandle = TranscriptScrollHandle> {
  /** The scroll policy. Default `"tail"`. It may change at runtime: switching to `"off"` stops following at once. */
  follow?: TranscriptFollow;
  /**
   * Called with `true`/`false` as the tail enters and leaves the viewport, under either policy, so
   * a host can draw its own "↓". Called once on mount with the starting state, then once per change.
   */
  onAtEndChange?: (atEnd: boolean) => void;
  /** `false` hides the built-in "jump to latest" chip (a host drawing its own). Default `true`. */
  jumpToLatest?: boolean;
  /** The scroll handle ({@link TranscriptScrollHandle}). Stable for the component's lifetime. */
  handleRef?: Ref<H>;
}
