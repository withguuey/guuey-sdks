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
  type ReactNode,
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
import type { TranscriptFollow, TranscriptScrollHandle, TranscriptScrollProps } from "../transcript-scroll.js";
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
  const geometry = useRef<{ offset: number; content: number | null; viewport: number | null }>({
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

  /** Pixels between the viewport and the end, or null while the list is unmeasured. */
  const distanceFromEnd = (): number | null => {
    const { offset, content, viewport } = geometry.current;
    // Inverted coordinates: offset 0 IS the newest turn.
    if (renderRef.current.inverted) return offset;
    if (content === null || viewport === null) return null;
    return content - offset - viewport;
  };

  /** Report the tail entering or leaving the viewport, once per change, and place the jump chip. */
  const refresh = (): void => {
    const distance = distanceFromEnd();
    if (distance === null) return;
    setShowJump(distance > JUMP_THRESHOLD_PX);
    const cb = onAtEndRef.current;
    if (cb === undefined) return;
    const atEnd = distance < AT_END_THRESHOLD_PX;
    if (lastAtEnd.current === atEnd) return;
    lastAtEnd.current = atEnd;
    cb(atEnd);
  };

  const hostOnScroll = listProps?.onScroll;
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    geometry.current = { offset: contentOffset.y, content: contentSize.height, viewport: layoutMeasurement.height };
    const distance = distanceFromEnd();
    // Under "off", reaching the end by hand never starts following (only a go-to-end does);
    // dragging away from it stops following.
    if (dragging.current && distance !== null && distance >= AT_END_THRESHOLD_PX) pinned.current = false;
    refresh();
    hostOnScroll?.(e);
  };

  const onContentSizeChange = (_width: number, height: number): void => {
    geometry.current = { ...geometry.current, content: height };
    // Under "off", content growth moves the list only while following a go-to-end.
    if (renderRef.current.followPolicy === "off" && pinned.current) {
      listRef.current?.scrollToEnd({ animated: false });
    }
    refresh();
  };

  const onLayout = (e: LayoutChangeEvent): void => {
    geometry.current = { ...geometry.current, viewport: e.nativeEvent.layout.height };
    refresh();
  };

  const goToEnd = (animated: boolean): void => {
    const list = listRef.current;
    dragging.current = false;
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
    if (wasInverted === inverted) return;
    const { offset, content, viewport } = geometry.current;
    if (content === null || viewport === null) return;
    const distance = wasInverted ? offset : content - offset - viewport;
    const next = Math.max(0, inverted ? distance : content - viewport - distance);
    geometry.current = { ...geometry.current, offset: next };
    listRef.current?.scrollToOffset({ offset: next, animated: false });
  }, [followPolicy, inverted]);

  // The starting at-end state (an inverted list starts at its end; a top-down one reports
  // once it is measured).
  useEffect(() => {
    refresh();
  }, []);

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
        const top = (opts.align ?? "top") === "top";
        // An inverted list's visual top is the item's far edge: the alignment flips with it.
        const atFarEdge = top !== isInverted;
        indexFailed.current = false;
        list.scrollToIndex({
          index,
          viewPosition: atFarEdge ? 0 : 1,
          viewOffset: atFarEdge ? offset : -offset,
          animated: opts.behavior === "smooth" && !still,
        });
        // An item outside the measured window has no known place: the list declined, and the
        // transcript does not guess one.
        if (indexFailed.current) return false;
        // The host placed the view: following stops until it asks for the end again.
        pinned.current = false;
        dragging.current = false;
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

  return (
    <View style={{ flex: 1, backgroundColor: tokens.palette.canvas }}>
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
          <View style={{ paddingVertical: tokens.gap / 2 }}>
            {renderNativeItem(item, resolvedComponents, ctx)}
          </View>
        )}
        {...(followPolicy === "tail" ? { ListHeaderComponent: tail } : { ListFooterComponent: tail })}
      />
      {showJump && jumpToLatest ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => goToEnd(!reduceMotion)}
          style={{
            position: "absolute",
            bottom: 12,
            alignSelf: "center",
            backgroundColor: tokens.palette.surface,
            borderRadius: 999,
            paddingHorizontal: 14,
            paddingVertical: 8,
            elevation: 3,
          }}
        >
          <Text style={{ color: tokens.palette.ink, fontSize: tokens.fontSize - 2, fontFamily: tokens.fontFamily }}>
            {strings.jumpToLatest}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
