/**
 * guuey#2554: the host's scroll API on a transcript — ONE definition that every transcript
 * component implements: the web `<Transcript>` now, `NativeTranscript` later (guuey#2569), so a
 * host writes the same code for both. Each component owns its behaviour, except the arithmetic of
 * the room a placement reserves below the last item (the pure functions at the end of this module,
 * over geometry each component reads as numbers), which every transcript shares.
 *
 * Recipe (a chat where the reader reads the answer while it streams, the page never moving under
 * their eye): pass `follow="off"`; when a NEW user item appears in the plan, call
 * `handle.scrollToItem(userItemKey, { align: "top" })` once (with `offset` for a fixed header);
 * then do nothing until the reply ends. Show your own "↓" from `onAtEndChange(false)` with
 * `jumpToLatest={false}`, and call `handle.scrollToEnd()` when it is tapped — the transcript then
 * follows the stream until the reader scrolls away. `transcript-scroll.test.tsx` runs this recipe.
 */
/**
 * A ref the handle is written to: an object ref or a callback ref. Structural, so this root module
 * imports nothing from `react` (an optional peer): a headless consumer typechecks without it, and
 * React's own `Ref<H>` is assignable to it.
 */
export type TranscriptHandleRef<H> = { current: H | null } | ((handle: H | null) => void) | null;

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

/** Where a placed item lands: its top at the viewport's top, or its bottom at the viewport's bottom. */
export type TranscriptItemAlign = "top" | "end";

export interface TranscriptScrollToItemOptions extends TranscriptScrollOptions {
  /** Where the item lands ({@link TranscriptItemAlign}). Default `"top"`. */
  align?: TranscriptItemAlign;
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
  handleRef?: TranscriptHandleRef<H>;
}

/*
 * guuey#2554: the room below the last item. A scroll is clamped at `scrollHeight - clientHeight`
 * (a browser's scrollTop, a native scroll view's offset), so an item near the end could never
 * reach the place `scrollToItem` asks for. A transcript reserves exactly the shortfall below its
 * content. Everything below is pure arithmetic over numbers the component reads off its own
 * layout (the DOM, or a native layout event): no DOM, no React.
 */

/**
 * The room reserved below the last item. `key` is the item placed, `align` and `offset` where it
 * was placed (kept relative to the ITEM, never as a scroll offset, so content above it changing
 * height, or windowing dropping an item above, never misreads it), `px` the room now (what that
 * place lacks to be reachable, never more than the placement itself reserved).
 */
export interface TranscriptRoom {
  readonly key: string;
  readonly align: TranscriptItemAlign;
  readonly offset: number;
  readonly px: number;
}

/** An item's geometry along the scroll axis, as numbers. */
export interface TranscriptItemGeometry {
  /** The item's top in the scroll content's coordinates (0 = the content's top). */
  readonly itemTop: number;
  /** The item's height. */
  readonly itemHeight: number;
  /** The viewport's height (a browser's `clientHeight`). */
  readonly viewportHeight: number;
}

/** The scroll's clamp without any reserved room: the furthest scroll is `contentHeight - viewportHeight`. */
export interface TranscriptScrollClamp {
  /** The scroll height WITHOUT the reserved room (a browser's `scrollHeight` less the room's px). */
  readonly contentHeight: number;
  /** The viewport's height (a browser's `clientHeight`). */
  readonly viewportHeight: number;
}

/** Where the reader's scroll is now, the reserved room included. */
export interface TranscriptScrollPosition {
  /** The scroll offset (a browser's `scrollTop`). */
  readonly scrollTop: number;
  /** The scroll height WITH the reserved room (a browser's `scrollHeight`). */
  readonly scrollHeight: number;
  /** The viewport's height (a browser's `clientHeight`). */
  readonly viewportHeight: number;
}

/**
 * The scroll offset that puts the item at `align` less `offset`, never above the content's top.
 * A placement and every refit of its room ask this same question of the same item, read NOW.
 */
export function itemPlaceTop(item: TranscriptItemGeometry, align: TranscriptItemAlign, offset: number): number {
  return Math.max(
    0,
    align === "top" ? item.itemTop - offset : item.itemTop + item.itemHeight - item.viewportHeight + offset,
  );
}

/**
 * What a scroll to `target` lacks below the content to be reachable under the clamp (whole
 * pixels, rounded up), 0 when it is reachable as it is.
 */
export function roomShortfall(target: number, clamp: TranscriptScrollClamp): number {
  return Math.max(0, Math.ceil(target + clamp.viewportHeight - clamp.contentHeight));
}

/**
 * The room a placement of `key` reserves for a place lacking `shortfall`, or null (none, and any
 * earlier room released) when the place is reachable as it is.
 */
export function reserveRoom(
  key: string,
  align: TranscriptItemAlign,
  offset: number,
  shortfall: number,
): TranscriptRoom | null {
  return isRoomSpent(shortfall) ? null : { key, align, offset, px: shortfall };
}

/**
 * The only-shrinks ratchet: the room a held `heldPx` becomes when its place now lacks
 * `shortfall`. It shrinks by what grew into it (the view never moves) and never grows: content
 * shrinking above or below never makes it larger than the placement reserved.
 */
export function ratchetRoomPx(heldPx: number, shortfall: number): number {
  return Math.min(heldPx, shortfall);
}

/** Released at 0: a room with nothing left to reserve is gone. */
export function isRoomSpent(px: number): boolean {
  return px === 0;
}

/**
 * The reader scrolled up until releasing the room moves nothing in view: it is wholly below the
 * view, or the content is shorter than the viewport and they are at its top.
 */
export function isRoomScrolledPast(heldPx: number, scroll: TranscriptScrollPosition): boolean {
  return scroll.scrollTop <= Math.max(0, scroll.scrollHeight - heldPx - scroll.viewportHeight);
}

/**
 * What happens to the held room.
 *  - `refit`: content or the viewport changed; `shortfall` is what the placed item's place
 *    ({@link itemPlaceTop}, re-read now) lacks ({@link roomShortfall}), or `null` when no item
 *    with the room's key renders any more (windowed out, a thread swap, a new conversation).
 *  - `reader-scroll`: the reader (never the transcript's own move) scrolled to `scroll`.
 *  - `end`: a go-to-end, or following resumed: the end is the content's own, with no room below.
 */
export type TranscriptRoomEvent =
  | { readonly kind: "refit"; readonly shortfall: number | null }
  | { readonly kind: "reader-scroll"; readonly scroll: TranscriptScrollPosition }
  | { readonly kind: "end" };

/**
 * The held room after `event`: null when released, `held` itself (the same object) when
 * unchanged, a new room when it shrank. A refit ratchets ({@link ratchetRoomPx}) and releases at
 * 0 ({@link isRoomSpent}) or when the item no longer renders; a reader's scroll releases it once
 * {@link isRoomScrolledPast}; an end always releases it.
 */
export function nextRoom(held: TranscriptRoom | null, event: TranscriptRoomEvent): TranscriptRoom | null {
  if (held === null) return null;
  switch (event.kind) {
    case "end":
      return null;
    case "reader-scroll":
      return isRoomScrolledPast(held.px, event.scroll) ? null : held;
    case "refit": {
      if (event.shortfall === null) return null;
      const px = ratchetRoomPx(held.px, event.shortfall);
      if (isRoomSpent(px)) return null;
      return px === held.px ? held : { ...held, px };
    }
  }
}
