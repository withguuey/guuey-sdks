/**
 * `<Transcript>` — the plan walker + the §3.2 renderer obligations:
 *
 *  - **Scroll contract:** stick-to-bottom while content grows UNLESS the
 *    user scrolled up, in which case a "jump to latest" affordance appears
 *    instead; anchoring holds through content resize (a ResizeObserver on
 *    the item column re-pins — R6 cards growing on `connected` are the
 *    canonical breaker). Following never carries the current turn's FIRST
 *    CARD above the viewport (guuey#1328, `scroll-anchor.ts`): once the
 *    turn outgrows the panel the card settles at its top, the rest waits
 *    below behind "jump to latest", and reaching the tail yourself (or the
 *    jump) releases the hold for that turn. `prefers-reduced-motion`
 *    downgrades smooth scrolling to instant.
 *  - **Room below the last item** (guuey#2554): a browser clamps a scroll
 *    at `scrollHeight - clientHeight`, so an item near the end could never
 *    reach the place `scrollToItem` asks for. The transcript reserves
 *    exactly the shortfall in a spacer after the column. The place is kept
 *    relative to the placed item, never as a scrollTop, so content above it
 *    changing height (an image loading, windowing dropping an item) is read
 *    off the item where it is now. The room only shrinks (content shrinking
 *    never grows it), as later content grows into it, and is released at 0,
 *    on a go-to-end or following resuming, when no item with the placed
 *    key renders any more, or when the reader scrolls up until releasing it
 *    moves nothing in view.
 *  - **Windowing:** long transcripts render the trailing `window.tail`
 *    items with a "show earlier" expander — the DOM is capped even though
 *    the plan (already O(groups)) carries everything; the plan's stable
 *    keys keep expansion state and DOM identity across the window edge.
 *  - Theme: the resolved `GuueyChatTheme` is projected as `--guuey-chat-*`
 *    custom properties on the root (import `@guuey/chat/styles.css` once
 *    for the default look, or restyle the class names entirely).
 */
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { DEFAULT_CHAT_THEME, type GuueyChatTheme } from "../theme.js";
import { defaultChatStrings, type ChatStrings } from "../strings.js";
import type { TranscriptPlan } from "../types.js";
import {
  defaultTranscriptComponents,
  renderItem,
  ThreadClosedBanner,
  type TranscriptComponents,
  type TranscriptItemContext,
} from "./components.js";
import { themeCssVars, type ThemeMode } from "./theme-css.js";
import { facesCss, useHostFaces } from "./faces.js";
import { PARTS } from "./parts.js";
import { useA2uiEditStore } from "./a2ui.js";
import { followTarget, planTurnAnchor, type TurnAnchorPlan } from "./scroll-anchor.js";
import {
  itemPlaceTop,
  nextRoom,
  reserveRoom,
  roomShortfall,
  type TranscriptFollow,
  type TranscriptItemGeometry,
  type TranscriptRoom,
  type TranscriptScrollClamp,
  type TranscriptScrollHandle,
  type TranscriptScrollProps,
} from "../transcript-scroll.js";
import type { DisplayItem } from "../types.js";

/** How close to the bottom (px) still counts as pinned. */
const PIN_THRESHOLD_PX = 48;

/*
 * The scroll helpers below read nothing from a render: they take the elements and the anchor
 * state as arguments. So the component's own handlers capture only refs and state setters, and
 * the effects and the handle built once around them never hold a stale render.
 */

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const scrollToBottom = (el: HTMLDivElement, smooth: boolean): void => {
  if (typeof el.scrollTo === "function") {
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  } else {
    // Environments without Element.scrollTo (jsdom; ancient WebViews).
    el.scrollTop = el.scrollHeight;
  }
};

const isAtEnd = (el: HTMLDivElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;

/**
 * The anchor card's top in scroll-content coordinates, or null (no card this turn, the hold
 * released, or the DOM disagrees with the plan). The kit's own `view` component renders one
 * `.guuey-chat-view` per view item as a direct child of the column; a custom `view` component, or
 * any other mismatch, keeps plain stick-to-bottom rather than guessing.
 */
const anchorTop = (
  anchor: TurnAnchorPlan,
  releasedTurn: string | null,
  el: HTMLDivElement,
  col: HTMLDivElement,
): number | null => {
  if (anchor.anchorOrdinal === null || releasedTurn === anchor.turnKey) return null;
  const views = Array.from(col.children).filter((c) => c.classList.contains("guuey-chat-view"));
  if (views.length !== anchor.viewCount) return null;
  const card = views[anchor.anchorOrdinal];
  if (card === undefined) return null;
  return card.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop + el.scrollTop;
};

/** guuey#2554: a placement still on its way: where it goes, and the scrollTop of its last frame. */
interface Glide {
  target: number;
  last: number;
}

/*
 * guuey#2554: the room's arithmetic is the shared module's (`transcript-scroll.ts`); the helpers
 * below read the DOM's geometry into numbers for it and size the spacer to its answer. They take
 * the room's refs and the elements as arguments, like the scroll helpers above, so the handlers
 * that call them capture only refs and setters.
 */

/** Hold `next` (null: none) and size the spacer to it; the room already held changes nothing. */
const holdRoom = (
  room: RefObject<TranscriptRoom | null>,
  spacer: HTMLDivElement | null,
  next: TranscriptRoom | null,
): void => {
  if (next === room.current) return;
  room.current = next;
  if (spacer !== null) spacer.style.height = next === null ? "" : `${next.px}px`;
};

/** The browser's clamp without the `held` room, read off the scroller. */
const clampOf = (el: HTMLDivElement, held: TranscriptRoom | null): TranscriptScrollClamp => ({
  contentHeight: el.scrollHeight - (held?.px ?? 0),
  viewportHeight: el.clientHeight,
});

/**
 * The item's geometry in the scroll content's coordinates, read NOW: a placement and every refit
 * of its room ask the same question of the same item.
 */
const geometryOf = (el: HTMLDivElement, item: Element): TranscriptItemGeometry => {
  const box = item.getBoundingClientRect();
  return {
    itemTop: box.top - el.getBoundingClientRect().top - el.clientTop + el.scrollTop,
    itemHeight: box.height,
    viewportHeight: el.clientHeight,
  };
};

/**
 * Content or panel changed. The place is re-read off the placed item where it is now (content
 * above it may have grown or shrunk, or been windowed out, and the browser's scroll anchoring
 * moved the view with it), and the room is what that place still lacks. It only ever shrinks, by
 * what grew into it (the view never moves), and is gone at 0; content shrinking never grows it.
 * When the placed item no longer renders (`itemElement` answers null: windowed out, a thread
 * swap, a new conversation), the room has no item to hold and is released, so the browser's clamp
 * brings the view back to the content. A placement still on its way that the change cut short now
 * ends at the scroll's new bottom.
 */
const fitRoom = (
  room: RefObject<TranscriptRoom | null>,
  placing: RefObject<Glide | null>,
  spacer: HTMLDivElement | null,
  el: HTMLDivElement | null,
  itemElement: (key: string) => Element | null,
): void => {
  if (el === null) return;
  const held = room.current;
  if (held !== null) {
    const item = itemElement(held.key);
    const shortfall =
      item === null
        ? null
        : roomShortfall(itemPlaceTop(geometryOf(el, item), held.align, held.offset), clampOf(el, held));
    holdRoom(room, spacer, nextRoom(held, { kind: "refit", shortfall }));
  }
  const glide = placing.current;
  if (glide !== null) {
    const bottom = Math.max(0, el.scrollHeight - el.clientHeight);
    // Its last frame is the clamp's own, at the new bottom: that one is still ours.
    if (glide.target > bottom) placing.current = { target: bottom, last: glide.last };
  }
};

/**
 * guuey#2554 (cto STOP-1): items the kit's OWN default slot renders as no element. The default
 * `tool` slot draws nothing for an attributed call (calm folds it into its view row's chrome,
 * `components.tsx` `DefaultTool`). A host's own `tool` component is counted as one element.
 */
const rendersNothing = (item: DisplayItem, components: TranscriptComponents): boolean =>
  item.kind === "tool" && item.attribution && components.tool === defaultTranscriptComponents.tool;

// guuey#2554: the scroll API's types live in ONE shared module every transcript component
// implements (NativeTranscript next, guuey#2569); re-exported here for `@guuey/chat/react`.
export type {
  TranscriptFollow,
  TranscriptScrollHandle,
  TranscriptScrollOptions,
  TranscriptScrollProps,
  TranscriptScrollToItemOptions,
} from "../transcript-scroll.js";

/** guuey#2554: the web transcript's handle — the shared core plus the scroll element. */
export interface TranscriptHandle extends TranscriptScrollHandle {
  /** The scroll element, for anything the handle does not cover. */
  readonly element: HTMLDivElement | null;
}

export interface TranscriptWindowing {
  /** Trailing items rendered; earlier ones sit behind the expander. */
  tail: number;
}

export interface TranscriptProps
  extends TranscriptScrollProps<TranscriptHandle>,
    Pick<
    TranscriptItemContext,
    | "onToggle"
    | "onRetry"
    | "onPromptAction"
    | "onErrorAction"
    | "resolvedMounts"
    | "onViewPhase"
    | "onViewDiagnosis"
    | "onViewRef"
    | "viewProps"
    | "a2uiEdits"
    | "a2uiIcon"
    | "onA2uiAction"
    | "a2uiActionsReady"
  > {
  plan: TranscriptPlan;
  /** Per-slot component overrides (spec §3's override column). */
  components?: Partial<TranscriptComponents>;
  /** The i18n seam — pass the same strings the policy carries. */
  strings?: ChatStrings;
  theme?: GuueyChatTheme;
  mode?: ThemeMode;
  /**
   * Message-surface presentation (guuey#521). `"card"` (default) renders
   * assistant text on its own surface-tinted, hairline-bordered card;
   * `"bare"` sits the transcript directly on the host's background — the
   * embed disappears into the page it lives on. The user pill stays a
   * bubble in both.
   */
  surface?: "card" | "bare";
  /**
   * guuey#2355 — opens a new conversation from the closed-conversation
   * banner (drawn whenever `plan.threadClosed` is set); without it the
   * banner shows the message and no control.
   */
  onStartNewConversation?: () => void;
  /** DOM windowing (§3.2). `false` renders everything. Default tail 80. */
  window?: TranscriptWindowing | false;
  className?: string;
  style?: CSSProperties;
}

export function Transcript(props: TranscriptProps): ReactNode {
  const {
    plan,
    components,
    strings = defaultChatStrings,
    theme = DEFAULT_CHAT_THEME,
    mode = "light",
    surface = "card",
    window: windowing = { tail: 80 },
    className,
    style,
    onToggle,
    onRetry,
    onPromptAction,
    onErrorAction,
    resolvedMounts,
    onViewPhase,
    onViewDiagnosis,
    onViewRef,
    viewProps,
    a2uiEdits,
    a2uiIcon,
    onA2uiAction,
    a2uiActionsReady,
    onStartNewConversation,
    follow: followPolicy = "tail",
    onAtEndChange,
    jumpToLatest = true,
    handleRef,
  } = props;

  const resolvedComponents: TranscriptComponents = useMemo(
    () => ({ ...defaultTranscriptComponents, ...components }),
    [components],
  );
  // guuey#2382: the A2UI surfaces' local edits live here, above the rows (spec §5.4).
  const ownEdits = useA2uiEditStore(plan.items);
  const edits = a2uiEdits ?? ownEdits;
  const ctx: TranscriptItemContext = useMemo(
    () => ({
      strings,
      onToggle,
      onRetry,
      onPromptAction,
      onErrorAction,
      resolvedMounts,
      onViewPhase,
      onViewDiagnosis,
      onViewRef,
      viewProps,
      a2uiEdits: edits,
      ...(a2uiIcon !== undefined ? { a2uiIcon } : {}),
      ...(onA2uiAction !== undefined ? { onA2uiAction } : {}),
      ...(a2uiActionsReady !== undefined ? { a2uiActionsReady } : {}),
    }),
    [strings, onToggle, onRetry, onPromptAction, onErrorAction, resolvedMounts, onViewPhase, onViewDiagnosis, onViewRef, viewProps, edits, a2uiIcon, onA2uiAction, a2uiActionsReady],
  );

  // ── Windowing ────────────────────────────────────────────────────────
  const [extraShown, setExtraShown] = useState(0);
  const tail = windowing === false ? Number.POSITIVE_INFINITY : windowing.tail;
  const visibleFrom = Math.max(0, plan.items.length - tail - extraShown);
  const hidden = visibleFrom;
  const visible = plan.items.slice(visibleFrom);

  // ── Scroll contract ──────────────────────────────────────────────────
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  // guuey#2554: the policy, read by the observer and the scroll handler between renders.
  const followRef = useRef<TranscriptFollow>(followPolicy);
  followRef.current = followPolicy;
  const pinned = useRef(followPolicy === "tail");
  /**
   * guuey#2554 (cto STOP-2): set by a go-to-end and held until the first frame at the end, so the
   * frames a SMOOTH scroll emits on its way down are not read as the reader scrolling away. The
   * reader scrolling back up mid-way cancels it (`lastSeekTop`).
   */
  const seekingEnd = useRef(false);
  const lastSeekTop = useRef<number | null>(null);
  /** The policy last applied, so a runtime change (not the mount) re-decides following (cto MED-2). */
  const appliedPolicy = useRef<TranscriptFollow>(followPolicy);
  const onAtEndRef = useRef(onAtEndChange);
  onAtEndRef.current = onAtEndChange;
  /** The last at-end state reported, so `onAtEndChange` fires only on a change. */
  const lastAtEnd = useRef<boolean | null>(null);
  const [showJump, setShowJump] = useState(false);
  // guuey#1328 — the current turn's card anchor, read off the rendered
  // items; mirrored into a ref for the ResizeObserver, which runs between
  // renders.
  const turnAnchor = useMemo(() => planTurnAnchor(plan.items.slice(visibleFrom)), [plan.items, visibleFrom]);
  const anchorPlan = useRef(turnAnchor);
  /** True while the anchor, not the bottom, decides where following rests. */
  const holding = useRef(false);
  /** The turn whose hold the viewer released (reached the tail, or jumped). */
  const releasedTurn = useRef<string | null>(null);
  /** The scrollTop of our own last follow, so `onScroll` can tell it from the viewer's. */
  const autoTop = useRef<number | null>(null);
  /** guuey#2554: the spacer after the column that holds the room a placement reserves. */
  const spacer = useRef<HTMLDivElement>(null);
  /**
   * guuey#2554: the room reserved below the last item ({@link TranscriptRoom}: its `px` is the
   * spacer's height now), or null. Its arithmetic is the shared module's; this component reads the
   * DOM's geometry into numbers for it.
   */
  const room = useRef<TranscriptRoom | null>(null);
  /**
   * guuey#2554: a placement still on its way, so its frames are not read as the reader's. Read
   * off the scroll itself, not the behavior asked for: a host's `scroll-behavior: smooth` turns
   * an instant scroll into a glide too.
   */
  const placing = useRef<Glide | null>(null);

  /** Follow: to the bottom, or to the turn's card when the bottom would carry it out of view. */
  const follow = (): void => {
    const el = scroller.current;
    if (el === null) return;
    // guuey#2554: following resumed (the reader came back to the end under "tail"): the end it
    // follows is the content's own, so no reserved room is kept below it.
    holdRoom(room, spacer.current, nextRoom(room.current, { kind: "end" }));
    const col = column.current;
    const target = followTarget(
      { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      col === null ? null : anchorTop(anchorPlan.current, releasedTurn.current, el, col),
    );
    holding.current = target.held;
    // A held follow leaves content below: say so (the scroll event may not
    // fire when the card is already where it rests).
    setShowJump(target.held);
    if (Math.abs(target.top - el.scrollTop) < 1) return;
    autoTop.current = target.top;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: target.top, behavior: "auto" });
    } else {
      el.scrollTop = target.top;
    }
  };

  /** guuey#2554: report the tail entering or leaving the viewport, once per change. */
  const reportAtEnd = (): void => {
    const el = scroller.current;
    const cb = onAtEndRef.current;
    if (el === null || cb === undefined) return;
    const atEnd = isAtEnd(el);
    if (lastAtEnd.current === atEnd) return;
    lastAtEnd.current = atEnd;
    cb(atEnd);
  };

  const onScroll = (): void => {
    const el = scroller.current;
    if (el === null) return;
    const nearBottom = isAtEnd(el);
    reportAtEnd();
    if (seekingEnd.current) {
      const backUp = lastSeekTop.current !== null && el.scrollTop < lastSeekTop.current - 1;
      lastSeekTop.current = el.scrollTop;
      if (!backUp) {
        // A frame of our own go-to-end: following holds; the seek ends at the end.
        if (nearBottom) {
          seekingEnd.current = false;
          lastSeekTop.current = null;
        }
        autoTop.current = null;
        setShowJump(!nearBottom);
        return;
      }
      // The reader scrolled back up mid-way: they took over.
      seekingEnd.current = false;
      lastSeekTop.current = null;
    }
    const glide = placing.current;
    if (glide !== null) {
      // A frame of a smooth placement on its way (never moving away from its target): ours.
      const left = Math.abs(el.scrollTop - glide.target);
      if (left <= Math.abs(glide.last - glide.target) + 1) {
        placing.current = left <= 1 ? null : { target: glide.target, last: el.scrollTop };
        setShowJump(!nearBottom);
        return;
      }
      // The reader took over mid-glide.
      placing.current = null;
    }
    const ours = autoTop.current !== null && Math.abs(el.scrollTop - autoTop.current) <= 1;
    autoTop.current = null;
    if (ours) {
      // Our own follow (to the bottom or to the card), or a placement: following does not change.
      setShowJump(!nearBottom);
      return;
    }
    // guuey#2554: the reader scrolled up until releasing the reserved room moves nothing in view
    // (it is wholly below the view, or the content is shorter than the panel and they are at its
    // top): it is released, so the end they scroll back to is the content's own.
    holdRoom(
      room,
      spacer.current,
      nextRoom(room.current, {
        kind: "reader-scroll",
        scroll: { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, viewportHeight: el.clientHeight },
      }),
    );
    // The viewer reached the tail while the card held: they chose the tail,
    // so this turn follows the bottom from here.
    if (nearBottom && holding.current) releasedTurn.current = anchorPlan.current.turnKey;
    // guuey#2554: under `"off"`, reaching the bottom by hand never starts following (only the
    // host's `scrollToEnd` does); scrolling away still stops it.
    pinned.current = followRef.current === "tail" ? nearBottom : pinned.current && nearBottom;
    setShowJump(!nearBottom);
  };

  // guuey#2554 (cto MED-2): `follow` may change at runtime. To `"off"`: following stops at once.
  // To `"tail"`: following resumes if the reader is at the end. The mount is not a change.
  useLayoutEffect(() => {
    if (appliedPolicy.current === followPolicy) return;
    appliedPolicy.current = followPolicy;
    if (followPolicy === "off") {
      pinned.current = false;
      seekingEnd.current = false;
      return;
    }
    const el = scroller.current;
    if (el !== null && isAtEnd(el)) pinned.current = true;
  }, [followPolicy]);

  // Declared before the follow below: layout effects run in order, so the
  // follow always reads this render's anchor.
  useLayoutEffect(() => {
    anchorPlan.current = turnAnchor;
  }, [turnAnchor]);

  // New content while pinned keeps following (before paint, so per-frame
  // streaming updates never visibly jump).
  useLayoutEffect(() => {
    fitRoom(room, placing, spacer.current, scroller.current, itemElement);
    if (pinned.current) follow();
    reportAtEnd();
  }, [plan]);

  // Content RESIZE (an R6 card connecting and growing, an image loading)
  // re-runs the follow too — scrollHeight changes with no plan change. A
  // card growing past the panel no longer drives the viewport past itself:
  // the follow clamps at its top. guuey#2554: the scroller itself is observed
  // too, so the panel resizing (a virtual keyboard) refits the reserved room.
  useEffect(() => {
    const el = column.current;
    const panel = scroller.current;
    if (el === null || panel === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      fitRoom(room, placing, spacer.current, scroller.current, itemElement);
      if (pinned.current) follow();
      reportAtEnd();
    });
    observer.observe(el);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const goToEnd = (smooth: boolean): void => {
    // The end is the content's own end: no room is kept below it, and no placement still glides.
    holdRoom(room, spacer.current, nextRoom(room.current, { kind: "end" }));
    placing.current = null;
    pinned.current = true;
    // Only a smooth scroll emits frames on its way to the end; an instant one lands at once.
    seekingEnd.current = smooth && !reducedMotion();
    lastSeekTop.current = scroller.current?.scrollTop ?? null;
    releasedTurn.current = anchorPlan.current.turnKey;
    holding.current = false;
    setShowJump(false);
    const el = scroller.current;
    if (el !== null) scrollToBottom(el, smooth);
  };

  // guuey#2554 (cto MED-1): the handle is built ONCE (stable for a callback ref), so it reads the
  // render's values through refs, as the observer and the scroll handler do.
  const renderRef = useRef({ visible, hidden, plan, components: resolvedComponents });
  renderRef.current = { visible, hidden, plan, components: resolvedComponents };

  /**
   * The rendered element of a visible item, or null. The column's children are, in order: the
   * "show earlier" button (when items are hidden), one element per rendered visible item, then the
   * status and closed-thread rows. The count must line up exactly, or this answers null (never a guess).
   */
  const itemElement = (key: string): Element | null => {
    const col = column.current;
    if (col === null) return null;
    const { visible: shown, hidden: behind, plan: current, components } = renderRef.current;
    const rendered = shown.filter((item) => !rendersNothing(item, components));
    const index = rendered.findIndex((item) => item.key === key);
    if (index < 0) return null;
    const lead = behind > 0 ? 1 : 0;
    const trail = (current.status !== null ? 1 : 0) + (current.threadClosed !== null ? 1 : 0);
    if (col.children.length !== lead + rendered.length + trail) return null;
    return col.children[lead + index] ?? null;
  };

  useImperativeHandle(
    handleRef,
    (): TranscriptHandle => ({
      scrollToItem(key, opts = {}) {
        const el = scroller.current;
        const target = itemElement(key);
        if (el === null || target === null) return false;
        const align = opts.align ?? "top";
        const offset = opts.offset ?? 0;
        const place = itemPlaceTop(geometryOf(el, target), align, offset);
        // The host placed the view: following stops until it asks for the end again, and any
        // go-to-end still gliding is over (its seek must not swallow the reader's next move).
        pinned.current = false;
        seekingEnd.current = false;
        lastSeekTop.current = null;
        // guuey#2554: a place the browser's clamp would stop short of gets the room it lacks.
        const lacks = roomShortfall(place, clampOf(el, room.current));
        holdRoom(room, spacer.current, reserveRoom(key, align, offset, lacks));
        const smooth = opts.behavior === "smooth" && !reducedMotion();
        const from = el.scrollTop;
        const moves = Math.abs(place - from) >= 1;
        if (typeof el.scrollTo === "function") {
          el.scrollTo({ top: place, behavior: smooth ? "smooth" : "auto" });
        } else {
          el.scrollTop = place;
        }
        // The move's own scroll events are ours, never the reader's: an earlier follow's marker
        // is replaced by this move's (none when the view is already in place: no event comes). A
        // move that landed has one event, at its target; one still on its way (smooth, or a
        // host's `scroll-behavior: smooth` gliding an instant scroll) has frames toward it.
        const landed = Math.abs(el.scrollTop - place) <= 1;
        autoTop.current = moves && landed ? place : null;
        placing.current = moves && !landed ? { target: place, last: from } : null;
        return true;
      },
      scrollToEnd(opts = {}) {
        goToEnd(opts.behavior === "smooth");
      },
      get element() {
        return scroller.current;
      },
    }),
    [],
  );

  // guuey#1195: a standalone <Transcript> consumer gets the theme's faces too.
  useHostFaces(facesCss(theme.typography.faces));

  const rootStyle: CSSProperties = { ...themeCssVars(theme, mode), ...style };

  const StatusComponent = resolvedComponents.status;

  return (
    <div
      className={`guuey-chat${surface === "bare" ? " guuey-chat--bare" : ""}${className !== undefined ? ` ${className}` : ""}`}
      style={rootStyle}
      data-guuey-chat-mode={mode}
      part={PARTS.transcript}
    >
      <div ref={scroller} className="guuey-chat-scroller" onScroll={onScroll}>
        <div ref={column} className="guuey-chat-column">
          {hidden > 0 ? (
            <button
              type="button"
              className="guuey-chat-show-earlier"
              onClick={() => setExtraShown((n) => n + tail)}
            >
              {strings.showEarlier(hidden)}
            </button>
          ) : null}
          {visible.map((item) => renderItem(item, resolvedComponents, ctx))}
          {plan.status !== null ? (
            <StatusComponent item={plan.status} ctx={ctx} />
          ) : null}
          {plan.threadClosed !== null ? (
            <ThreadClosedBanner
              closed={plan.threadClosed}
              strings={strings}
              {...(onStartNewConversation !== undefined ? { onStartNewConversation } : {})}
            />
          ) : null}
        </div>
        {/* guuey#2554: the room a placement near the end reserves; sized from code, 0 at rest. */}
        <div ref={spacer} className="guuey-chat-reserve" aria-hidden="true" />
      </div>
      {showJump && jumpToLatest ? (
        <button
          type="button"
          className="guuey-chat-jump"
          aria-label={strings.jumpToLatest}
          title={strings.jumpToLatest}
          onClick={() => goToEnd(true)}
        >
          {/* guuey#2121: the labelled chip where a composer follows (the seam);
              an icon-only round chip, the down arrow, everywhere else, so the
              chip's footprint over a composer-less transcript is the smallest it
              can be. CSS picks which part shows; the accessible name is the words
              either way. */}
          <span className="guuey-chat-jump-label" aria-hidden="true">
            {strings.jumpToLatest}
          </span>
          <svg
            className="guuey-chat-jump-icon"
            aria-hidden="true"
            focusable="false"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
