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
 * Platform chrome (keyboard insets, dismiss modes, dock scroll policies)
 * stays HOST-OWNED: `listProps` passes the host's FlatList behavior
 * through, with the kit composing `onScroll` so both the host's policy and
 * the jump affordance see every event. The kit owns data/renderItem/keys/
 * inversion — a host overriding those would be fighting the plan.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  FlatList,
  Pressable,
  Text,
  View,
  type FlatListProps,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { DEFAULT_CHAT_THEME, type GuueyChatTheme } from "../theme.js";
import { defaultChatStrings, type ChatStrings } from "../strings.js";
import type { DisplayItem, TranscriptPlan } from "../types.js";
import {
  nativeTranscriptComponents,
  renderNativeItem,
  type NativeTranscriptComponents,
  type NativeTranscriptItemContext,
} from "./components.js";
import { resolveNativeTheme, type NativeThemeMode } from "./theme-native.js";

/** Offset (px) past which the reader counts as "up in history". */
const JUMP_THRESHOLD_PX = 160;

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
  extends Pick<
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

  // Inverted-list data: reversed plan, newest at index 0 (the visual
  // bottom / scroll origin). Keys are the plan's stable keys.
  const data = useMemo(() => [...plan.items].reverse(), [plan.items]);

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
  const hostOnScroll = listProps?.onScroll;
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Inverted coordinates: offset 0 IS the newest turn.
      setShowJump(e.nativeEvent.contentOffset.y > JUMP_THRESHOLD_PX);
      hostOnScroll?.(e);
    },
    [hostOnScroll],
  );

  const StatusComponent = resolvedComponents.status;

  return (
    <View style={{ flex: 1, backgroundColor: tokens.palette.canvas }}>
      <FlatList
        ref={listRef}
        {...listProps}
        onScroll={onScroll}
        scrollEventThrottle={listProps?.scrollEventThrottle ?? 16}
        // Inverted only while non-empty: an inverted ListEmptyComponent
        // renders upside-down (RN gotcha — portal's receipt).
        inverted={data.length > 0}
        data={data}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => (
          <View style={{ paddingVertical: tokens.gap / 2 }}>
            {renderNativeItem(item, resolvedComponents, ctx)}
          </View>
        )}
        // Inverted list: the header renders at the VISUAL BOTTOM — where
        // the live status line belongs.
        ListHeaderComponent={
          plan.status !== null ? <StatusComponent item={plan.status} ctx={ctx} /> : null
        }
      />
      {showJump ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setShowJump(false);
            listRef.current?.scrollToOffset({ offset: 0, animated: !reduceMotion });
          }}
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
