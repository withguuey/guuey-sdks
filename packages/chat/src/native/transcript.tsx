/**
 * `<NativeTranscript>` — the plan walker + the §3.2 renderer obligations,
 * restated over React Native's own mechanics:
 *
 *  - **Scroll contract, the inverted way.** The list is an INVERTED
 *    FlatList over the reversed plan (the chat-app contract portal's
 *    agent-chat screen ratified — guuey#94/#100): content grows at the
 *    scroll ORIGIN, so "stick to bottom while streaming" and "never shift
 *    the viewport while the reader is up in history" hold by construction
 *    — no scrollTo calls during streaming, no re-pin race with content
 *    resize (an R6 card growing at the origin cannot move the reader's
 *    viewport). "Release on scroll-up" is likewise structural; the kit
 *    adds the jump-to-latest affordance when the reader has left the
 *    newest turn, and its scroll animation respects the platform
 *    reduce-motion setting.
 *  - **Room below the last item** (guuey#2850, the native twin of the web
 *    transcript's guuey#2554): a scroll view clamps at `content - viewport`,
 *    so under `follow="off"` an item near the end could never reach the
 *    place `scrollToItem` asks for. The transcript reserves exactly the
 *    shortfall in a spacer at the end of the footer. The place is kept
 *    relative to the placed item, never as an offset, and every refit
 *    re-measures the item and the spacer in ONE layout revision
 *    (`measureLayout`, synchronous under the New Architecture), so a layout
 *    event arriving late never misreads it. The room only shrinks, as later
 *    content grows into it, and is released at 0, on a go-to-end, on a
 *    `follow` change, when the reader drags up until releasing it moves
 *    nothing in view, and when the item no longer renders. Without a
 *    synchronous measure (the old architecture), `scrollToItem` places
 *    through `scrollToIndex` with no room, as before. A host
 *    `contentContainerStyle` bottom padding sits after the room and is
 *    counted on top of it.
 *  - **Windowing** is the list primitive's own virtualization — FlatList
 *    windows the DOM-equivalent natively; the plan's stable keys are the
 *    `keyExtractor`, so item identity survives streaming updates.
 *  - **Accessibility** lives on the item components (`components.tsx`).
 *
 * The host's scroll API (`follow`, `handleRef`, `onAtEndChange`,
 * `jumpToLatest`) is the SAME one the web `<Transcript>` takes, typed from
 * the shared `transcript-scroll` module. Under `follow="tail"` (the
 * default) the inverted list above follows by construction. Under
 * `follow="off"` the list is NOT inverted: content grows below the
 * viewport, so growth never moves it — the web transcript's own geometry —
 * and following runs only after `scrollToEnd()` (or the jump chip), by a
 * `scrollToEnd` on each content resize, until the reader drags away.
 *
 * Platform chrome (keyboard insets, dismiss modes, dock scroll policies)
 * stays HOST-OWNED: `listProps` passes the host's FlatList behavior
 * through, with the kit composing `onScroll` so both the host's policy and
 * the jump affordance see every event. The kit owns data/renderItem/keys/
 * inversion — a host overriding those would be fighting the plan.
 */
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AccessibilityInfo,
  FlatList,
  Pressable,
  Text,
  View,
  type FlatListProps,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { DEFAULT_CHAT_THEME, type GuueyChatTheme } from "../theme.js";
import { defaultChatStrings, type ChatStrings } from "../strings.js";
import type { DisplayItem, TranscriptPlan } from "../types.js";
import {
  itemPlaceTop,
  nextRoom,
  reserveRoom,
  roomShortfall,
  type TranscriptFollow,
  type TranscriptItemAlign,
  type TranscriptRoom,
  type TranscriptScrollHandle,
  type TranscriptScrollProps,
} from "../transcript-scroll.js";
import {
  NativeThreadClosedBanner,
  nativeTranscriptComponents,
  renderNativeItem,
  type NativeTranscriptComponents,
  type NativeTranscriptItemContext,
} from "./components.js";
import { resolveNativeTheme, type NativeThemeMode } from "./theme-native.js";

/** Offset (px) past which the reader counts as "up in history". */
const JUMP_THRESHOLD_PX = 160;
/** How close to the end (px) still counts as at the end — the web transcript's threshold. */
const AT_END_THRESHOLD_PX = 48;

/** The list's last known geometry; the content and viewport heights are unknown until measured. */
interface ListGeometry {
  offset: number;
  content: number | null;
  viewport: number | null;
}

/**
 * Pixels between the viewport and the end, or null while the list is unmeasured. It reads no
 * render, so the handlers that call it capture only refs and setters.
 */
const distanceFromEnd = ({ offset, content, viewport }: ListGeometry, inverted: boolean): number | null => {
  // Inverted coordinates: offset 0 IS the newest turn.
  if (inverted) return offset;
  if (content === null || viewport === null) return null;
  return content - offset - viewport;
};

/** A host view, as `measureLayout` takes and answers for it. */
type HostView = ComponentRef<typeof View>;

/** guuey#2850: a place, read off one layout revision. */
interface Place {
  /** The offset that puts the item where it was asked to be. */
  target: number;
  /** What the content lacks below for `target` to be reachable (0 when it is). */
  shortfall: number;
}

/**
 * The view's `{ y, height }` against `relativeTo` (an ancestor), or null when the measure failed
 * or did not answer synchronously. Under the New Architecture the answer comes before the call
 * returns, read off the current layout revision; the old architecture answers later, and a late
 * answer is never used.
 */
function measureNow(view: HostView, relativeTo: HostView): { y: number; height: number } | null {
  let box: { y: number; height: number } | null = null;
  view.measureLayout(relativeTo, (_x, y, _width, height) => {
    box = { y, height };
  });
  return box;
}

/*
 * guuey#2850: the room helpers live at module scope and take the refs and views as arguments,
 * like `distanceFromEnd` and the web transcript's room helpers, so the handlers that call them
 * capture only refs and setters.
 */

/** A placement waiting for its room to be laid out. */
interface PendingPlace {
  animated: boolean;
}

/** What a place is measured from, read off the refs at the moment of asking. */
interface PlaceViews {
  /** The kit's own outer view: the ancestor every measure is read against. */
  frame: HostView | null;
  /** The spacer at the end of the footer; its top is where the content ends without the room. */
  spacer: HostView | null;
  /** The list's top inside the outer view (a host margin moves it): content offsets start there. */
  listTop: number;
  /** The list's viewport height, or null while the list is unmeasured. */
  viewportHeight: number | null;
}

/** Where the content ends without the room, in content coordinates (the spacer's top), or null. */
function bareEnd({ frame, spacer, listTop }: PlaceViews): number | null {
  if (frame === null || spacer === null) return null;
  const box = measureNow(spacer, frame);
  return box === null ? null : box.y - listTop;
}

/**
 * Where a placement of `item` puts it now, and what the content lacks below for that place, read
 * off ONE layout revision: the item and the spacer are measured back to back, so the pair is
 * always consistent. The arithmetic is the shared one (`transcript-scroll`), over these numbers.
 * Null when the list is unmeasured, the item does not render (`undefined`), or the measure did not
 * answer synchronously.
 */
function placeOf(
  views: PlaceViews,
  item: HostView | undefined,
  align: TranscriptItemAlign,
  offset: number,
): Place | null {
  const { frame, listTop, viewportHeight } = views;
  if (frame === null || item === undefined || viewportHeight === null) return null;
  const box = measureNow(item, frame);
  const contentHeight = bareEnd(views);
  if (box === null || contentHeight === null) return null;
  const target = itemPlaceTop({ itemTop: box.y - listTop, itemHeight: box.height, viewportHeight }, align, offset);
  return { target, shortfall: roomShortfall(target, { contentHeight, viewportHeight }) };
}

/**
 * Hold `next` (the shared arithmetic's answer) and size the spacer to it: null releases the room
 * and drops a placement waiting on it; the room already held changes nothing.
 */
function holdRoom(
  room: RefObject<TranscriptRoom | null>,
  pendingPlace: RefObject<PendingPlace | null>,
  setRoomPx: (px: number) => void,
  next: TranscriptRoom | null,
): void {
  if (next === room.current) return;
  room.current = next;
  if (next === null) pendingPlace.current = null;
  setRoomPx(next?.px ?? 0);
}

/** The native transcript's handle — the shared core plus the list. */
export interface NativeTranscriptHandle extends TranscriptScrollHandle {
  /** The FlatList, for anything the handle does not cover. */
  readonly element: FlatList<DisplayItem> | null;
}

/** The host-behavior pass-through — everything the kit deliberately does NOT own. */
export type NativeTranscriptListProps = Pick<
  FlatListProps<DisplayItem>,
  | "style"
  | "contentContainerStyle"
  | "keyboardDismissMode"
  | "keyboardShouldPersistTaps"
  | "automaticallyAdjustKeyboardInsets"
  | "onScroll"
  | "scrollEventThrottle"
  | "ListEmptyComponent"
  | "scrollIndicatorInsets"
>;

export interface NativeTranscriptProps
  extends TranscriptScrollProps<NativeTranscriptHandle>,
    Pick<
    NativeTranscriptItemContext,
    "onToggle" | "onRetry" | "onPromptAction" | "onErrorAction" | "resolvedMounts" | "onViewPhase" | "onViewRef"
  > {
  plan: TranscriptPlan;
  /** Per-slot component overrides (spec §3's override column). */
  components?: Partial<NativeTranscriptComponents>;
  /** The i18n seam — pass the same strings the policy carries. */
  strings?: ChatStrings;
  theme?: GuueyChatTheme;
  mode?: NativeThemeMode;
  /** Host-owned FlatList behavior (keyboard/scroll chrome). */
  listProps?: NativeTranscriptListProps;
  /**
   * guuey#2355 — opens a new conversation from the closed-conversation
   * banner (drawn whenever `plan.threadClosed` is set); without it the
   * banner shows the message and no control.
   */
  onStartNewConversation?: () => void;
}

/**
 * The jump pill's label on its ink fill (guuey#2578): never a theme token, since a host theme
 * can set the canvas transparent. It is the web pill's rule without `hsl(from)`: white on the
 * light mode's dark ink, near-black on the dark mode's light ink.
 */
const JUMP_LABEL_ON_INK: Readonly<Record<NativeThemeMode, string>> = { light: "#fff", dark: "#111" };

export function NativeTranscript(props: NativeTranscriptProps): ReactNode {
  const {
    plan,
    components,
    strings = defaultChatStrings,
    theme = DEFAULT_CHAT_THEME,
    mode = "light",
    listProps,
    onToggle,
    onRetry,
    onPromptAction,
    onErrorAction,
    resolvedMounts,
    onViewPhase,
    onViewRef,
    onStartNewConversation,
    follow: followPolicy = "tail",
    onAtEndChange,
    jumpToLatest = true,
    handleRef,
  } = props;

  const tokens = useMemo(() => resolveNativeTheme(theme, mode), [theme, mode]);
  const resolvedComponents: NativeTranscriptComponents = useMemo(
    () => ({ ...nativeTranscriptComponents, ...components }),
    [components],
  );
  const ctx: NativeTranscriptItemContext = useMemo(
    () => ({ strings, tokens, onToggle, onRetry, onPromptAction, onErrorAction, resolvedMounts, onViewPhase, onViewRef }),
    [strings, tokens, onToggle, onRetry, onPromptAction, onErrorAction, resolvedMounts, onViewPhase, onViewRef],
  );

  // Under "tail": an inverted list over the reversed plan, newest at index 0
  // (the visual bottom / scroll origin) — inverted only while non-empty. Under
  // "off": the plan in order, top-down. Keys are the plan's stable keys.
  const inverted = followPolicy === "tail" && plan.items.length > 0;
  const data = useMemo(
    () => (followPolicy === "tail" ? [...plan.items].reverse() : plan.items),
    [plan.items, followPolicy],
  );

  // Reduce motion: the ONE animation the kit owns is the jump scroll.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (alive) setReduceMotion(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const listRef = useRef<FlatList<DisplayItem>>(null);
  const [showJump, setShowJump] = useState(false);

  // The render's values, read by the handle and the list callbacks between renders.
  const renderRef = useRef({ data, inverted, followPolicy, reduceMotion });
  renderRef.current = { data, inverted, followPolicy, reduceMotion };
  /** The list's last known geometry; the content and viewport heights are unknown until measured. */
  const geometry = useRef<ListGeometry>({
    offset: 0,
    content: null,
    viewport: null,
  });
  /** Under "off": true from a go-to-end until the reader drags away from the end. */
  const pinned = useRef(false);
  /** True while the reader's finger (or its momentum) moves the list, so our own scrolls are told apart. */
  const dragging = useRef(false);
  /** Set by `onScrollToIndexFailed`, which the list calls synchronously inside `scrollToIndex`. */
  const indexFailed = useRef(false);
  const onAtEndRef = useRef(onAtEndChange);
  onAtEndRef.current = onAtEndChange;
  /** The last at-end state reported, so `onAtEndChange` fires only on a change. */
  const lastAtEnd = useRef<boolean | null>(null);
  /** An orientation flip made before the list was measured: it re-anchors once the list is. */
  const pendingFlip = useRef<{ wasInverted: boolean } | null>(null);

  // guuey#2850: the room below the last item under "off".
  /** The kit's own outer view: the ancestor every measure is read against. */
  const frame = useRef<HostView>(null);
  /** The spacer at the end of the footer; its top is where the content ends without the room. */
  const spacer = useRef<HostView>(null);
  /** The rendered item views by key, for `measureLayout`. */
  const itemViews = useRef(new Map<string, HostView>());
  /** One ref callback per key, so a re-render never detaches and re-attaches an item's view. */
  const itemRefs = useRef(new Map<string, (view: HostView | null) => void>());
  /** The list's top inside the outer view (a host margin moves it): content offsets start there. */
  const listTop = useRef(0);
  /** The placed item and the room its place still lacks, or null (the shared arithmetic's room). */
  const room = useRef<TranscriptRoom | null>(null);
  /** The spacer's height, rendered. */
  const [roomPx, setRoomPx] = useState(0);
  /**
   * A placement waiting for its room to be laid out: the scroll goes once the content covers the
   * place, never sooner, since a scroll before the content grows is clamped short (on Android a
   * view command can run ahead of the same commit's layout).
   */
  const pendingPlace = useRef<PendingPlace | null>(null);

  const itemRef = (key: string): ((view: HostView | null) => void) => {
    let ref = itemRefs.current.get(key);
    if (ref === undefined) {
      ref = (view) => {
        if (view !== null) {
          itemViews.current.set(key, view);
          return;
        }
        itemViews.current.delete(key);
        itemRefs.current.delete(key);
      };
      itemRefs.current.set(key, ref);
    }
    return ref;
  };

  /**
   * Content, panel or plan changed. The place is re-read off the placed item where it is now, and
   * the room becomes what that place still lacks. It only ever shrinks (content growing into it);
   * content shrinking or the panel growing never grows it. It is gone at 0, and when the item no
   * longer renders. A placement waiting on its room scrolls once the content covers the place.
   */
  const fitRoom = (): void => {
    const held = room.current;
    if (held === null) return;
    // An item that left the plan, or the window, no longer renders: its view is gone, so no place.
    const place = placeOf(
      { frame: frame.current, spacer: spacer.current, listTop: listTop.current, viewportHeight: geometry.current.viewport },
      itemViews.current.get(held.key),
      held.align,
      held.offset,
    );
    holdRoom(room, pendingPlace, setRoomPx, nextRoom(held, { kind: "refit", shortfall: place?.shortfall ?? null }));
    if (room.current === null) return;
    const pending = pendingPlace.current;
    const { content, viewport } = geometry.current;
    if (pending === null || place === null || content === null || viewport === null) return;
    if (content < place.target + viewport) return;
    pendingPlace.current = null;
    listRef.current?.scrollToOffset({ offset: place.target, animated: pending.animated });
  };

  /** Report the tail entering or leaving the viewport, once per change, and place the jump chip. */
  const refresh = (): void => {
    const distance = distanceFromEnd(geometry.current, renderRef.current.inverted);
    if (distance === null) return;
    setShowJump(distance > JUMP_THRESHOLD_PX);
    const cb = onAtEndRef.current;
    if (cb === undefined) return;
    const atEnd = distance < AT_END_THRESHOLD_PX;
    if (lastAtEnd.current === atEnd) return;
    lastAtEnd.current = atEnd;
    cb(atEnd);
  };

  /**
   * Carry the viewport across an orientation flip as its distance from the end — the same
   * content, seen the same way, whichever edge the offset counts from. The list keeps its numeric
   * offset through the flip, so the re-anchor is always an explicit scroll, never left to it.
   * Unmeasured, the flip waits for the measure (until then the offset is the first one, 0).
   */
  const reanchor = (wasInverted: boolean): void => {
    const isInverted = renderRef.current.inverted;
    const { offset, content, viewport } = geometry.current;
    if (content === null || viewport === null) {
      pendingFlip.current = { wasInverted };
      return;
    }
    pendingFlip.current = null;
    if (wasInverted === isInverted) return;
    const distance = wasInverted ? offset : content - offset - viewport;
    const next = Math.max(0, isInverted ? distance : content - viewport - distance);
    geometry.current = { ...geometry.current, offset: next };
    listRef.current?.scrollToOffset({ offset: next, animated: false });
  };
  const settleFlip = (): void => {
    const pending = pendingFlip.current;
    if (pending !== null) reanchor(pending.wasInverted);
  };

  const hostOnScroll = listProps?.onScroll;
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    geometry.current = { offset: contentOffset.y, content: contentSize.height, viewport: layoutMeasurement.height };
    settleFlip();
    const distance = distanceFromEnd(geometry.current, renderRef.current.inverted);
    // Under "off", reaching the end by hand never starts following (only a go-to-end does);
    // dragging away from it stops following.
    if (dragging.current && distance !== null && distance >= AT_END_THRESHOLD_PX) pinned.current = false;
    // guuey#2850: the reader dragged up until releasing the room moves nothing in view (it is
    // wholly below the view): it is released, so the end they come back to is the content's own.
    // The scroll height is read as the content's measured end plus the room held, never off this
    // event's contentSize, which may predate the spacer's latest height.
    const held = room.current;
    const contentEnd =
      held !== null && dragging.current
        ? bareEnd({
            frame: frame.current,
            spacer: spacer.current,
            listTop: listTop.current,
            viewportHeight: geometry.current.viewport,
          })
        : null;
    if (held !== null && contentEnd !== null) {
      holdRoom(
        room,
        pendingPlace,
        setRoomPx,
        nextRoom(held, {
          kind: "reader-scroll",
          scroll: { scrollTop: contentOffset.y, scrollHeight: contentEnd + held.px, viewportHeight: layoutMeasurement.height },
        }),
      );
    }
    refresh();
    hostOnScroll?.(e);
  };

  const onContentSizeChange = (_width: number, height: number): void => {
    geometry.current = { ...geometry.current, content: height };
    settleFlip();
    fitRoom();
    // Under "off", content growth moves the list only while following a go-to-end.
    if (renderRef.current.followPolicy === "off" && pinned.current) {
      listRef.current?.scrollToEnd({ animated: false });
    }
    refresh();
  };

  const onLayout = (e: LayoutChangeEvent): void => {
    listTop.current = e.nativeEvent.layout.y;
    geometry.current = { ...geometry.current, viewport: e.nativeEvent.layout.height };
    settleFlip();
    fitRoom();
    refresh();
  };

  const goToEnd = (animated: boolean): void => {
    const list = listRef.current;
    dragging.current = false;
    // The end is the content's own end: no room is kept below it.
    holdRoom(room, pendingPlace, setRoomPx, nextRoom(room.current, { kind: "end" }));
    if (renderRef.current.followPolicy === "off") pinned.current = true;
    setShowJump(false);
    if (list === null) return;
    if (renderRef.current.inverted) list.scrollToOffset({ offset: 0, animated });
    else list.scrollToEnd({ animated });
  };

  // `follow` may change at runtime. To "off": following stops at once. Either way the list
  // flips orientation, so the viewport is carried over as its distance from the end. The
  // mount is not a change.
  const appliedPolicy = useRef<TranscriptFollow>(followPolicy);
  const appliedInverted = useRef(inverted);
  useLayoutEffect(() => {
    const wasInverted = appliedInverted.current;
    appliedInverted.current = inverted;
    if (appliedPolicy.current === followPolicy) return;
    appliedPolicy.current = followPolicy;
    pinned.current = false;
    dragging.current = false;
    // guuey#2850: a room belongs to a place under "off"; the flip carries the distance instead.
    holdRoom(room, pendingPlace, setRoomPx, nextRoom(room.current, { kind: "end" }));
    // A flip still waiting for the measure keeps the orientation it started from.
    reanchor(pendingFlip.current?.wasInverted ?? wasInverted);
  }, [followPolicy, inverted]);

  // The starting at-end state (an inverted list starts at its end; a top-down one reports
  // once it is measured).
  useEffect(() => {
    refresh();
  }, []);

  // guuey#2850: a new plan may have dropped the placed item, or moved it: refit after the commit.
  useLayoutEffect(() => {
    fitRoom();
  }, [data]);

  // The handle is built ONCE (stable for a callback ref); it reads the render through refs.
  useImperativeHandle(
    handleRef,
    (): NativeTranscriptHandle => ({
      scrollToItem(key, opts = {}) {
        const list = listRef.current;
        const { data: items, inverted: isInverted, reduceMotion: still } = renderRef.current;
        const index = items.findIndex((item) => item.key === key);
        if (list === null || index < 0) return false;
        const offset = opts.offset ?? 0;
        const align = opts.align ?? "top";
        const animated = opts.behavior === "smooth" && !still;
        // guuey#2850: under "off", a place read off the layout gets the room it lacks below.
        const place = isInverted
          ? null
          : placeOf(
              {
                frame: frame.current,
                spacer: spacer.current,
                listTop: listTop.current,
                viewportHeight: geometry.current.viewport,
              },
              itemViews.current.get(key),
              align,
              offset,
            );
        if (place !== null) {
          // The host placed the view: following stops until it asks for the end again.
          pinned.current = false;
          dragging.current = false;
          pendingPlace.current = null;
          const reserved = reserveRoom(key, align, offset, place.shortfall);
          holdRoom(room, pendingPlace, setRoomPx, reserved);
          const { content, viewport } = geometry.current;
          if (reserved === null || (content !== null && viewport !== null && content >= place.target + viewport)) {
            // Reachable as it is, or the room already rendered covers it: go now (a larger room
            // rendered is trimmed to what is lacked).
            list.scrollToOffset({ offset: place.target, animated });
          } else {
            pendingPlace.current = { animated };
          }
          return true;
        }
        const top = align === "top";
        // An inverted list's visual top is the item's far edge: the alignment flips with it.
        const atFarEdge = top !== isInverted;
        indexFailed.current = false;
        list.scrollToIndex({
          index,
          viewPosition: atFarEdge ? 0 : 1,
          viewOffset: atFarEdge ? offset : -offset,
          animated,
        });
        // An item outside the measured window has no known place: the list declined, and the
        // transcript does not guess one.
        if (indexFailed.current) return false;
        // The host placed the view: following stops until it asks for the end again.
        pinned.current = false;
        dragging.current = false;
        // A room held for an earlier place is not this place's.
        holdRoom(room, pendingPlace, setRoomPx, null);
        return true;
      },
      scrollToEnd(opts = {}) {
        goToEnd(opts.behavior === "smooth" && !renderRef.current.reduceMotion);
      },
      get element() {
        return listRef.current;
      },
    }),
    [],
  );

  const StatusComponent = resolvedComponents.status;
  // The live status line sits below the last turn: an inverted list's header renders at the
  // VISUAL BOTTOM, a top-down one's footer does.
  // guuey#2355: the closed-conversation banner sits below the last turn.
  const tail =
    plan.status !== null || plan.threadClosed !== null ? (
      <View>
        {plan.status !== null ? <StatusComponent item={plan.status} ctx={ctx} /> : null}
        {plan.threadClosed !== null ? (
          <NativeThreadClosedBanner
            closed={plan.threadClosed}
            strings={strings}
            tokens={tokens}
            {...(onStartNewConversation !== undefined ? { onStartNewConversation } : {})}
          />
        ) : null}
      </View>
    ) : null;

  // guuey#2850: under "off" the footer ends in the room's spacer, 0 high at rest. Hidden from
  // assistive tech on both platforms, and never touchable.
  const footer = (
    <View>
      {tail}
      <View
        ref={spacer}
        collapsable={false}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ height: roomPx }}
      />
    </View>
  );

  return (
    <View ref={frame} style={{ flex: 1, backgroundColor: tokens.palette.canvas }}>
      <FlatList
        ref={listRef}
        {...listProps}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
        onScrollBeginDrag={() => {
          dragging.current = true;
        }}
        onMomentumScrollEnd={() => {
          dragging.current = false;
        }}
        onScrollToIndexFailed={() => {
          indexFailed.current = true;
        }}
        scrollEventThrottle={listProps?.scrollEventThrottle ?? 16}
        // Inverted only while non-empty: an inverted ListEmptyComponent
        // renders upside-down (RN gotcha — portal's receipt).
        inverted={inverted}
        data={data}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => (
          <View ref={itemRef(item.key)} style={{ paddingVertical: tokens.gap / 2 }}>
            {renderNativeItem(item, resolvedComponents, ctx)}
          </View>
        )}
        {...(followPolicy === "tail" ? { ListHeaderComponent: tail } : { ListFooterComponent: footer })}
      />
      {showJump && jumpToLatest ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => goToEnd(!reduceMotion)}
          style={{
            position: "absolute",
            bottom: 12,
            alignSelf: "center",
            // One control, one face (guuey#2578): the web pill's idiom. The fill is the palette ink,
            // which separates from the transcript by its whole body (17:1 and 15:1 on the shipped
            // canvases), so the pill needs no edge. `elevation` is Android-only, so the iOS shadow
            // keys sit beside it.
            backgroundColor: tokens.palette.ink,
            borderRadius: 999,
            paddingHorizontal: 14,
            paddingVertical: 8,
            elevation: 3,
            shadowColor: tokens.palette.ink,
            shadowOpacity: 0.15,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 1 },
          }}
        >
          <Text style={{ color: JUMP_LABEL_ON_INK[mode], fontSize: tokens.fontSize - 2, fontFamily: tokens.fontFamily }}>
            {strings.jumpToLatest}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
