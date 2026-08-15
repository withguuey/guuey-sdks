/**
 * The React Native per-category component kit (spec §3's override slots,
 * §3.2's RN-parity obligation): one component per `DisplayItem` variant,
 * each a THIN walk of its item — every rendering decision was already made
 * by `planTranscript`; these translate decided items into RN primitives and
 * never consult policy or invent copy. The override contract mirrors the
 * web kit: `NativeTranscriptComponents` is the component map.
 *
 * Accessibility (spec §3.2 restated over RN):
 *  - every `expanded` toggle is a `Pressable` with `accessibilityRole`
 *    "button" + `accessibilityState.expanded`;
 *  - the status line and streaming text announce via
 *    `accessibilityLiveRegion="polite"` (Android) and are `accessible`
 *    grouped nodes for screen readers on both platforms;
 *  - R10 prompts are a live-region group so their appearance announces
 *    (RN has no document focus to move — the web kit's focus contract maps
 *    to announcement here);
 *  - there are NO decorative animations in the native defaults, so
 *    reduce-motion holds trivially at this tier (the transcript's scroll
 *    animation is where motion lives — see `transcript.tsx`).
 *
 * The R6 DEFAULT is the documented native default-gap: the kit ships
 * WITHOUT a WebView dependency, so the default `view` renderer is a
 * labeled placeholder (`strings.viewSandboxUnavailable`) — never blank —
 * and a host app supplies its own WebView-based mount as the `view` slot
 * override (portal's card machinery is the reference consumer).
 */
import type { ComponentType, ReactNode } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { ResolvedViewMount, ViewHostPhase } from "@guuey/mcp-apps-host";
import type { ChatStrings } from "../strings.js";
import type {
  CitationsItem,
  CodeItem,
  CompactionItem,
  DataResultItem,
  DisplayItem,
  ErrorItem,
  HistoryBoundaryItem,
  ItemKey,
  MediaItem,
  NoticeItem,
  PromptItem,
  ReasoningItem,
  StatusLineItem,
  ToolGroupItem,
  ToolItem,
  UnknownItem,
  UserMessageItem,
  TextItem,
  ViewMountItem,
  ViewRefItem,
} from "../types.js";
import { Linking } from "react-native";
import { NativeMarkdown } from "./markdown.js";
import type { NativeChatTokens } from "./theme-native.js";

/** Everything a rendered native item may need beyond itself. */
export interface NativeTranscriptItemContext {
  strings: ChatStrings;
  /** The resolved theme tokens (see `resolveNativeTheme`). */
  tokens: NativeChatTokens;
  /** Flip an item's collapse state (the renderer owns override state). */
  onToggle: (key: ItemKey) => void;
  /** R0 failed-send retry. */
  onRetry?: (item: UserMessageItem) => void;
  /** R10 prompt actions — the host owns what accept/decline DO. */
  onPromptAction?: (
    item: PromptItem,
    action: "accept" | "decline" | "dismiss" | { grantModeId: string },
  ) => void;
  /** R11 action slots (sign-in / retry affordances). */
  onErrorAction?: (item: ErrorItem) => void;
  /** R6: locator mounts resolved by `useTranscript` ("expired" = failed). */
  resolvedMounts: ReadonlyMap<ItemKey, ResolvedViewMount | "expired">;
  /** R6: live phase reports wired back into the next plan. */
  onViewPhase: (key: ItemKey, phase: ViewHostPhase) => void;
  /**
   * guuey#204: a promoted-view reference chip was activated — the host
   * focuses/reveals its stage. Absent ⇒ the chip renders as a label.
   */
  onViewRef?: (item: ViewRefItem) => void;
}

interface ItemProps<T> {
  item: T;
  ctx: NativeTranscriptItemContext;
}

/** A collapse toggle + body pair with the RN accessibility plumbing. */
function Collapsible({
  itemKey,
  expanded,
  header,
  ctx,
  children,
}: {
  itemKey: ItemKey;
  expanded: boolean;
  header: ReactNode;
  ctx: NativeTranscriptItemContext;
  children: ReactNode;
}): ReactNode {
  const { tokens } = ctx;
  return (
    <View
      style={{
        backgroundColor: tokens.palette.surface,
        borderRadius: tokens.radius,
        paddingHorizontal: tokens.pad,
        paddingVertical: tokens.pad - 4,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => ctx.onToggle(itemKey)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
      >
        <View style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 6 }}>
          {header}
        </View>
        <Text
          accessibilityElementsHidden
          style={{ color: tokens.palette.inkMuted, fontSize: tokens.fontSize - 3 }}
        >
          {expanded ? "▾" : "▸"}
        </Text>
      </Pressable>
      {expanded ? <View style={{ marginTop: 6, gap: 6 }}>{children}</View> : null}
    </View>
  );
}

function MutedText({ ctx, children }: { ctx: NativeTranscriptItemContext; children: ReactNode }): ReactNode {
  const { tokens } = ctx;
  return (
    <Text
      style={{
        color: tokens.palette.inkMuted,
        fontSize: tokens.fontSize - 2,
        fontFamily: tokens.fontFamily,
      }}
    >
      {children}
    </Text>
  );
}

// ─── R0 ────────────────────────────────────────────────────────────────────

export function NativeUserMessage({ item, ctx }: ItemProps<UserMessageItem>): ReactNode {
  const { tokens } = ctx;
  return (
    <View style={{ alignItems: "flex-end", gap: 4, opacity: item.state === "sending" ? 0.6 : 1 }}>
      <View
        style={{
          maxWidth: "82%",
          backgroundColor: tokens.palette.ink,
          borderRadius: tokens.radius,
          paddingHorizontal: tokens.pad,
          paddingVertical: tokens.pad - 2,
        }}
      >
        {/* User text is QUOTED, never rendered — whitespace preserved. */}
        <Text style={{ color: tokens.palette.canvas, fontSize: tokens.fontSize, fontFamily: tokens.fontFamily }}>
          {item.text}
        </Text>
      </View>
      {item.state === "failed" ? (
        <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: tokens.palette.error, fontSize: tokens.fontSize - 2 }}>
            {ctx.strings.userCouldntSend}
          </Text>
          {item.retry ? (
            <Pressable accessibilityRole="button" onPress={() => ctx.onRetry?.(item)}>
              <Text style={{ color: tokens.palette.accent, fontSize: tokens.fontSize - 2, fontWeight: "600" }}>
                {ctx.strings.userRetry}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ─── R1 ────────────────────────────────────────────────────────────────────

export function NativeText({ item, ctx }: ItemProps<TextItem>): ReactNode {
  const { tokens } = ctx;
  const caret = item.streaming ? (
    <Text style={{ color: tokens.palette.accent }}>{" ▍"}</Text>
  ) : undefined;
  return (
    <View
      accessibilityLiveRegion={item.streaming ? "polite" : "none"}
      style={{
        alignSelf: "flex-start",
        maxWidth: "92%",
        backgroundColor: tokens.palette.surface,
        borderRadius: tokens.radius,
        paddingHorizontal: tokens.pad,
        paddingVertical: tokens.pad - 2,
        gap: 4,
      }}
    >
      {item.markdown ? (
        <NativeMarkdown text={item.text} color={tokens.palette.ink} tokens={tokens} trailing={caret} />
      ) : (
        <Text style={{ color: tokens.palette.ink, fontSize: tokens.fontSize, fontFamily: tokens.fontFamily }}>
          {item.text}
          {caret}
        </Text>
      )}
      {item.stopped ? <MutedText ctx={ctx}>{ctx.strings.stopped}</MutedText> : null}
    </View>
  );
}

// ─── R2 ────────────────────────────────────────────────────────────────────

export function NativeReasoning({ item, ctx }: ItemProps<ReasoningItem>): ReactNode {
  return (
    <Collapsible itemKey={item.key} expanded={item.expanded} ctx={ctx} header={<MutedText ctx={ctx}>{item.label}</MutedText>}>
      <MutedText ctx={ctx}>{item.text}</MutedText>
    </Collapsible>
  );
}

// ─── R5 ────────────────────────────────────────────────────────────────────

export function NativeDataResult({ item, ctx }: ItemProps<DataResultItem>): ReactNode {
  const { tokens } = ctx;
  const bytes = ctx.strings.bytes(item.byteCount);
  if (item.state === "empty") return <MutedText ctx={ctx}>{ctx.strings.noOutput}</MutedText>;
  if (item.preview === null) return <MutedText ctx={ctx}>{bytes}</MutedText>;
  return (
    <View style={{ gap: 4 }}>
      <View
        style={{
          maxHeight: 220, // R5's scroll-cap projected to a fixed clamp (native has no rem)
          overflow: "hidden",
          backgroundColor: tokens.palette.canvasMuted,
          borderRadius: tokens.radius,
          padding: tokens.pad - 4,
        }}
      >
        <Text style={{ color: tokens.palette.ink, fontSize: tokens.fontSize - 3, fontFamily: tokens.monoFontFamily }}>
          {item.preview}
        </Text>
      </View>
      {item.showBytes ? <MutedText ctx={ctx}>{bytes}</MutedText> : null}
    </View>
  );
}

// ─── R3 ────────────────────────────────────────────────────────────────────

const TOOL_GLYPH: Record<ToolItem["state"], string> = {
  running: "◌",
  done: "✓",
  failed: "✕",
  orphaned: "–",
};

export function NativeTool({ item, ctx }: ItemProps<ToolItem>): ReactNode {
  // R4's display-bearing rule: in calm this call's line lives in its view
  // row's chrome ("via {tool}") — rendering it here too would double it.
  if (item.attribution) return null;
  const { tokens } = ctx;
  const failed = item.state === "failed";
  const header = (
    <>
      <Text style={{ color: failed ? tokens.palette.error : tokens.palette.inkMuted, fontSize: tokens.fontSize - 2 }}>
        {TOOL_GLYPH[item.state]}
      </Text>
      <Text
        style={{
          color: failed ? tokens.palette.error : tokens.palette.inkMuted,
          fontSize: tokens.fontSize - 2,
          fontFamily: tokens.fontFamily,
          flexShrink: 1,
        }}
      >
        {item.title}
        {item.state === "orphaned" ? ` — ${ctx.strings.toolDidntFinish}` : ""}
      </Text>
    </>
  );
  const expandable = item.argsPreview !== null || item.result !== null;
  if (!expandable) {
    return <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: ctx.tokens.pad }}>{header}</View>;
  }
  return (
    <Collapsible itemKey={item.key} expanded={item.expanded} ctx={ctx} header={header}>
      {item.argsPreview !== null ? (
        <Text style={{ color: tokens.palette.inkMuted, fontSize: tokens.fontSize - 3, fontFamily: tokens.monoFontFamily }}>
          {item.argsPreview}
        </Text>
      ) : null}
      {item.result !== null ? <NativeDataResult item={item.result} ctx={ctx} /> : null}
    </Collapsible>
  );
}

// ─── R4 ────────────────────────────────────────────────────────────────────

export function NativeToolGroup({ item, ctx }: ItemProps<ToolGroupItem>): ReactNode {
  const { tokens } = ctx;
  return (
    <Collapsible
      itemKey={item.key}
      expanded={item.expanded}
      ctx={ctx}
      header={
        <>
          <MutedText ctx={ctx}>{item.label}</MutedText>
          {item.failureBadge !== null ? (
            <Text style={{ color: tokens.palette.error, fontSize: tokens.fontSize - 3 }}>{item.failureBadge}</Text>
          ) : null}
        </>
      }
    >
      {item.tools.map((tool) => (
        <NativeTool key={tool.key} item={tool} ctx={ctx} />
      ))}
    </Collapsible>
  );
}

// ─── R6 — the documented native default-gap ────────────────────────────────

export function NativeView({ item, ctx }: ItemProps<ViewMountItem>): ReactNode {
  const { tokens } = ctx;
  // The kit's native tier ships without a WebView dependency, so there is
  // no default mount host — the `view` slot is a REQUIRED override on
  // native (labeled here, never blank; portal's card machinery is the
  // reference override). The expired/labeled states still render honestly.
  const label =
    item.phase === "expired"
      ? ctx.strings.viewExpired
      : (item.label ?? ctx.strings.viewSandboxUnavailable);
  return (
    <View
      accessibilityRole="summary"
      style={{
        backgroundColor: tokens.palette.canvasMuted,
        borderRadius: tokens.radius,
        padding: tokens.pad,
        gap: 4,
      }}
    >
      <MutedText ctx={ctx}>{label}</MutedText>
      {item.attribution !== null ? <MutedText ctx={ctx}>{item.attribution}</MutedText> : null}
    </View>
  );
}

/**
 * guuey#204: the "promote and reference" chip — a Pressable when the host
 * wires `onViewRef`, a plain labeled row otherwise. Never a second mount.
 */
export function NativeViewRef({ item, ctx }: ItemProps<ViewRefItem>): ReactNode {
  const { tokens } = ctx;
  const chipStyle = {
    alignSelf: "flex-start" as const,
    backgroundColor: tokens.palette.surface,
    borderRadius: 999,
    paddingHorizontal: tokens.pad,
    paddingVertical: 6,
  };
  if (ctx.onViewRef === undefined) {
    return (
      <View accessibilityRole="text" style={chipStyle}>
        <MutedText ctx={ctx}>{item.label}</MutedText>
      </View>
    );
  }
  const onViewRef = ctx.onViewRef;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
      onPress={() => onViewRef(item)}
      style={chipStyle}
    >
      <MutedText ctx={ctx}>{item.label}</MutedText>
    </Pressable>
  );
}

// ─── R7 ────────────────────────────────────────────────────────────────────

/** Inline images allow https URLs and image/* base64 data — nothing else. */
function imageSrc(item: MediaItem): string | null {
  const source = item.source;
  if (source.type === "url" && /^https:\/\//i.test(source.url)) return source.url;
  if (source.type === "base64" && /^image\//.test(source.mediaType)) {
    return `data:${source.mediaType};base64,${source.data}`;
  }
  return null;
}

export function NativeMedia({ item, ctx }: ItemProps<MediaItem>): ReactNode {
  const { tokens } = ctx;
  if (item.presentation === "inline" && item.media === "image") {
    const src = imageSrc(item);
    if (src !== null) {
      return (
        <Image
          accessibilityLabel={item.name ?? ""}
          source={{ uri: src }}
          resizeMode="contain"
          style={{ width: "100%", height: 220, borderRadius: tokens.radius, backgroundColor: tokens.palette.canvasMuted }}
        />
      );
    }
  }
  // Attachment chip: files, documents, audio (RN has no default audio
  // element — a chip is the honest default), unloadable/oversized media.
  return (
    <View
      style={{
        alignSelf: "flex-start",
        backgroundColor: tokens.palette.canvasMuted,
        borderRadius: tokens.radius,
        paddingHorizontal: tokens.pad,
        paddingVertical: 4,
      }}
    >
      <MutedText ctx={ctx}>{item.name ?? item.media}</MutedText>
    </View>
  );
}

// ─── R8 ────────────────────────────────────────────────────────────────────

export function NativeCode({ item, ctx }: ItemProps<CodeItem>): ReactNode {
  const { tokens } = ctx;
  return (
    <View style={{ backgroundColor: tokens.palette.canvasMuted, borderRadius: tokens.radius, padding: tokens.pad - 2, gap: 4 }}>
      <MutedText ctx={ctx}>{item.language}</MutedText>
      <Text style={{ color: tokens.palette.ink, fontSize: tokens.fontSize - 3, fontFamily: tokens.monoFontFamily }}>
        {item.code}
      </Text>
    </View>
  );
}

// ─── R9 ────────────────────────────────────────────────────────────────────

/** Citation links navigate only to http(s) targets. */
function safeCitationUrl(url: string | null): string | null {
  return url !== null && /^https?:\/\//i.test(url) ? url : null;
}

export function NativeCitations({ item, ctx }: ItemProps<CitationsItem>): ReactNode {
  const { tokens } = ctx;
  return (
    <Collapsible itemKey={item.key} expanded={item.expanded} ctx={ctx} header={<MutedText ctx={ctx}>{item.label}</MutedText>}>
      {item.sources.map((source, i) => {
        const url = safeCitationUrl(source.url);
        const label = source.title ?? source.url ?? "";
        if (url === null) return <MutedText key={i} ctx={ctx}>{label}</MutedText>;
        return (
          <Pressable
            key={i}
            accessibilityRole="link"
            onPress={() => {
              void Linking.openURL(url).catch(() => {});
            }}
          >
            <Text style={{ color: tokens.palette.accent, fontSize: tokens.fontSize - 2, textDecorationLine: "underline" }}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </Collapsible>
  );
}

// ─── R10 ───────────────────────────────────────────────────────────────────

export function NativePrompt({ item, ctx }: ItemProps<PromptItem>): ReactNode {
  const { tokens } = ctx;
  if (item.promptKind === "hitl") {
    const s = ctx.strings;
    if (item.state === "resolved" || item.state === "declined") {
      return (
        <MutedText ctx={ctx}>
          {item.state === "resolved"
            ? item.chosenModeLabel !== null
              ? s.promptAnsweredWith(item.chosenModeLabel)
              : s.promptAccept
            : s.promptDeclinedRecord}
        </MutedText>
      );
    }
    // `cancelled` = guuey's re-askable dismissal: a record row that reopens
    // to the actions on toggle (silverprotocol#16 ruling).
    const answerable = item.state === "pending" || (item.state === "cancelled" && item.expanded);
    return (
      <View
        accessibilityLiveRegion="polite"
        accessible
        style={{ backgroundColor: tokens.palette.surface, borderRadius: tokens.radius, padding: tokens.pad, gap: 8 }}
      >
        {item.state === "cancelled" && (
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: item.expanded }} onPress={() => ctx.onToggle(item.key)}>
            <Text style={{ color: tokens.palette.inkMuted, fontSize: tokens.fontSize }}>{s.promptDismissed}</Text>
          </Pressable>
        )}
        {answerable && (
          <>
            {item.message !== null && (
              <Text style={{ color: tokens.palette.ink, fontSize: tokens.fontSize, fontFamily: tokens.fontFamily }}>
                {item.message}
              </Text>
            )}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              {item.grantModes.length === 0 ? (
                <Pressable accessibilityRole="button" onPress={() => ctx.onPromptAction?.(item, "accept")}>
                  <Text style={{ color: tokens.palette.accent, fontWeight: "700", fontSize: tokens.fontSize }}>
                    {s.promptAccept}
                  </Text>
                </Pressable>
              ) : (
                item.grantModes.map((mode) => (
                  <Pressable
                    key={mode.id}
                    accessibilityRole="button"
                    accessibilityHint={mode.description}
                    onPress={() => ctx.onPromptAction?.(item, { grantModeId: mode.id })}
                  >
                    <Text style={{ color: tokens.palette.accent, fontWeight: "700", fontSize: tokens.fontSize }}>
                      {mode.label ?? mode.id}
                    </Text>
                  </Pressable>
                ))
              )}
              <Pressable accessibilityRole="button" onPress={() => ctx.onPromptAction?.(item, "decline")}>
                <Text style={{ color: tokens.palette.inkMuted, fontSize: tokens.fontSize }}>{s.promptDecline}</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    );
  }
  if (item.state !== "pending") {
    return (
      <MutedText ctx={ctx}>
        {item.promptKind}: {item.state}
      </MutedText>
    );
  }
  return (
    <View
      // RN has no document focus to move; the live region announces the ask
      // (the web kit's focus contract, restated over the platform).
      accessibilityLiveRegion="polite"
      accessible
      style={{ backgroundColor: tokens.palette.surface, borderRadius: tokens.radius, padding: tokens.pad, gap: 8 }}
    >
      <Text style={{ color: tokens.palette.ink, fontSize: tokens.fontSize, fontFamily: tokens.fontFamily }}>
        {item.promptKind === "consent"
          ? `${item.appId} requests ${item.requested} access`
          : `Link your account to ${item.appId}`}
      </Text>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Pressable accessibilityRole="button" onPress={() => ctx.onPromptAction?.(item, "accept")}>
          <Text style={{ color: tokens.palette.accent, fontWeight: "700", fontSize: tokens.fontSize }}>Allow</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => ctx.onPromptAction?.(item, "decline")}>
          <Text style={{ color: tokens.palette.inkMuted, fontSize: tokens.fontSize }}>Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── R16 ──────────────────────────────────────────────────────────────────

/** The notice row (spec draft.2) — labeled, non-conversational, never agent-voiced. */
export function NativeNotice({ item, ctx }: ItemProps<NoticeItem>): ReactNode {
  const { tokens } = ctx;
  return (
    <View accessible accessibilityRole="text" style={{ paddingVertical: 4 }}>
      <Text style={{ color: tokens.palette.inkMuted, fontSize: tokens.fontSize - 2 }}>
        {ctx.strings.noticeLabel}
        {item.sourceLabel !== null ? ` · ${item.sourceLabel}` : ""}
        {item.text !== "" ? ` — ${item.text}` : ""}
      </Text>
    </View>
  );
}

// ─── R11 ───────────────────────────────────────────────────────────────────

export function NativeError({ item, ctx }: ItemProps<ErrorItem>): ReactNode {
  const { tokens } = ctx;
  return (
    <View
      accessibilityLiveRegion="assertive"
      accessible
      style={{
        backgroundColor: tokens.palette.surface,
        borderLeftWidth: 3,
        borderLeftColor: tokens.palette.error,
        borderRadius: tokens.radius,
        padding: tokens.pad,
        gap: 6,
      }}
    >
      <Text style={{ color: tokens.palette.ink, fontSize: tokens.fontSize - 1, fontFamily: tokens.fontFamily }}>
        {item.copy}
      </Text>
      {ctx.onErrorAction !== undefined && (item.family === "transient" || item.family === "auth") ? (
        <Pressable accessibilityRole="button" onPress={() => ctx.onErrorAction?.(item)}>
          <Text style={{ color: tokens.palette.accent, fontSize: tokens.fontSize - 1, fontWeight: "600" }}>
            {item.family === "auth" ? ctx.strings.errorAuth : ctx.strings.userRetry}
          </Text>
        </Pressable>
      ) : null}
      {item.verbatim !== null ? (
        <Text style={{ color: tokens.palette.inkMuted, fontSize: tokens.fontSize - 3, fontFamily: tokens.monoFontFamily }}>
          {item.verbatim}
        </Text>
      ) : null}
    </View>
  );
}

// ─── R13 / R14 / R15 ───────────────────────────────────────────────────────

export function NativeHistoryBoundary({ item, ctx }: ItemProps<HistoryBoundaryItem>): ReactNode {
  return (
    <View accessibilityLiveRegion="polite" style={{ alignItems: "center", paddingVertical: 4 }}>
      <MutedText ctx={ctx}>{item.label}</MutedText>
    </View>
  );
}

export function NativeCompaction({ item, ctx }: ItemProps<CompactionItem>): ReactNode {
  return (
    <View style={{ alignItems: "center", paddingVertical: 4 }}>
      <MutedText ctx={ctx}>{item.label}</MutedText>
    </View>
  );
}

export function NativeUnknown({ item, ctx }: ItemProps<UnknownItem>): ReactNode {
  return (
    <Collapsible
      itemKey={item.key}
      expanded={item.expanded}
      ctx={ctx}
      header={
        <MutedText ctx={ctx}>
          {item.label} ({item.typeName})
        </MutedText>
      }
    >
      {item.raw !== null ? (
        <Text style={{ color: ctx.tokens.palette.inkMuted, fontSize: ctx.tokens.fontSize - 3, fontFamily: ctx.tokens.monoFontFamily }}>
          {JSON.stringify(item.raw, null, 2)}
        </Text>
      ) : (
        <MutedText ctx={ctx}>{ctx.strings.bytes(item.byteSize)}</MutedText>
      )}
    </Collapsible>
  );
}

// ─── R12 / §4 ──────────────────────────────────────────────────────────────

export function NativeStatus({ item, ctx }: ItemProps<StatusLineItem>): ReactNode {
  const { tokens } = ctx;
  return (
    <View accessibilityLiveRegion="polite" accessible style={{ paddingHorizontal: tokens.pad, paddingVertical: 2 }}>
      <MutedText ctx={ctx}>
        {item.copy}
        {item.detail !== null ? ` · ${item.detail}` : ""}
      </MutedText>
    </View>
  );
}

// ─── The component map ─────────────────────────────────────────────────────

/** One component per §3 override slot — the native mirror of the web map. */
export interface NativeTranscriptComponents {
  userMessage: ComponentType<ItemProps<UserMessageItem>>;
  text: ComponentType<ItemProps<TextItem>>;
  reasoning: ComponentType<ItemProps<ReasoningItem>>;
  tool: ComponentType<ItemProps<ToolItem>>;
  toolGroup: ComponentType<ItemProps<ToolGroupItem>>;
  dataResult: ComponentType<ItemProps<DataResultItem>>;
  view: ComponentType<ItemProps<ViewMountItem>>;
  viewRef: ComponentType<ItemProps<ViewRefItem>>;
  media: ComponentType<ItemProps<MediaItem>>;
  code: ComponentType<ItemProps<CodeItem>>;
  citations: ComponentType<ItemProps<CitationsItem>>;
  prompt: ComponentType<ItemProps<PromptItem>>;
  notice: ComponentType<ItemProps<NoticeItem>>;
  error: ComponentType<ItemProps<ErrorItem>>;
  history: ComponentType<ItemProps<HistoryBoundaryItem>>;
  compaction: ComponentType<ItemProps<CompactionItem>>;
  unknown: ComponentType<ItemProps<UnknownItem>>;
  status: ComponentType<ItemProps<StatusLineItem>>;
}

export const nativeTranscriptComponents: NativeTranscriptComponents = {
  userMessage: NativeUserMessage,
  text: NativeText,
  reasoning: NativeReasoning,
  tool: NativeTool,
  toolGroup: NativeToolGroup,
  dataResult: NativeDataResult,
  view: NativeView,
  viewRef: NativeViewRef,
  media: NativeMedia,
  code: NativeCode,
  citations: NativeCitations,
  prompt: NativePrompt,
  notice: NativeNotice,
  error: NativeError,
  history: NativeHistoryBoundary,
  compaction: NativeCompaction,
  unknown: NativeUnknown,
  status: NativeStatus,
};

/** Dispatch one display item through the (possibly overridden) map. */
export function renderNativeItem(
  item: DisplayItem,
  components: NativeTranscriptComponents,
  ctx: NativeTranscriptItemContext,
): ReactNode {
  switch (item.kind) {
    case "user": {
      const C = components.userMessage;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "text": {
      const C = components.text;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "reasoning": {
      const C = components.reasoning;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "tool": {
      const C = components.tool;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "tool-group": {
      const C = components.toolGroup;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "data-result": {
      const C = components.dataResult;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "view": {
      const C = components.view;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "viewRef": {
      const C = components.viewRef;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "media": {
      const C = components.media;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "code": {
      const C = components.code;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "citations": {
      const C = components.citations;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "prompt": {
      const C = components.prompt;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "notice": {
      const C = components.notice;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "error": {
      const C = components.error;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "history-boundary": {
      const C = components.history;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "compaction": {
      const C = components.compaction;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "unknown": {
      const C = components.unknown;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
  }
}
