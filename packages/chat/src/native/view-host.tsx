/**
 * A reference `view` slot for `<NativeTranscript>`: mounts each view item in
 * an injected MCP App WebView host — `<McpAppIframe>` from
 * `@ggui-ai/mcp-apps-react-native` is the one it is shaped for.
 *
 * The kit's native tier ships no WebView dependency, so the host is passed
 * in rather than imported: this module adds no dependency and no peer.
 *
 * What the slot does (the decisions live in `./view-host-logic.ts`):
 *  - mounts direct material, or the locator's resolution from
 *    `ctx.resolvedMounts`; pending and expired views render the kit's
 *    labeled placeholder, never a blank;
 *  - hands the frame inline `text`/`blob` content only, never a bare `uri`;
 *  - sizes the frame from the app's size reports, clamped;
 *  - reports `connected` / `no-handshake` through `ctx.onViewPhase`, the
 *    web host's phase vocabulary;
 *  - relays the app's `tools/call` through `onUiAction`, scoped to the
 *    item's `actionScope`.
 */
import { useCallback, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Text, View } from "react-native";
import type {
  McpToolCallResult,
  McpToolStructuredContent,
  ViewHostPhase,
} from "@guuey/mcp-apps-host";
import type { ViewMountItem } from "../types.js";
import {
  NativeView,
  type NativeTranscriptItemContext,
  type NativeTranscriptItemProps,
} from "./components.js";
import {
  NATIVE_VIEW_DEFAULT_HEIGHT,
  NATIVE_VIEW_MAX_HEIGHT,
  NATIVE_VIEW_MIN_HEIGHT,
  chooseNativeViewMount,
  clampNativeViewHeight,
  lifecycleSignal,
  nextNativeViewPhase,
  relayNativeToolCall,
  toNativeFrameResource,
  type NativeFrameSignal,
  type NativeMcpAppFrameResource,
  type NativeUiActionRelay,
  type NativeViewHeightBounds,
} from "./view-host-logic.js";

/**
 * The props the view host passes its frame component — a structural subset
 * of `<McpAppIframe>`'s props, so that component is accepted as is.
 */
export interface NativeMcpAppFrameProps {
  /** Inline content only: `text`, or a base64 `blob`. */
  resource: NativeMcpAppFrameResource;
  /** The frame's height; echoed to the app as its container dimensions. */
  containerDimensions?: { height?: number };
  /** The app's `ui/notifications/size-changed` report. */
  onSizeChanged?: (size: { readonly width?: number; readonly height?: number }) => void;
  /** A `tools/call` from the app; the resolved value is its result. */
  onToolCall?: (toolName: string, args: McpToolStructuredContent) => Promise<McpToolCallResult>;
  /** A renderer lifecycle report (`code-ready`, `error`, …). */
  onLifecycle?: (event: { readonly state: string }) => void;
  /** A protocol error the frame classified. */
  onError?: (error: { readonly kind: string }) => void;
}

/** Options for {@link createNativeViewHost}. */
export interface CreateNativeViewHostOptions {
  /** The WebView host component — `McpAppIframe` from `@ggui-ai/mcp-apps-react-native`. */
  McpAppIframe: ComponentType<NativeMcpAppFrameProps>;
  /**
   * Relays a card's `tools/call` (`createUiActionRelay`'s result fits). Absent:
   * every call is answered in-band as "not available".
   */
  onUiAction?: NativeUiActionRelay;
  /** Height before the app's first size report. Default 360, clamped. */
  initialHeight?: number;
  /** Lower clamp for reported heights. Default 160. */
  minHeight?: number;
  /** Upper clamp for reported heights, so no app can take the screen. Default 760. */
  maxHeight?: number;
}

/** The `view` slot component {@link createNativeViewHost} returns. */
export type NativeViewHost = ComponentType<NativeTranscriptItemProps<ViewMountItem>>;

/**
 * Build a `view` slot override for `<NativeTranscript components={{ view }}>`.
 * Create it once (module scope or `useMemo`): a new component per render
 * remounts every WebView.
 */
export function createNativeViewHost(opts: CreateNativeViewHostOptions): NativeViewHost {
  const Frame = opts.McpAppIframe;
  const bounds: NativeViewHeightBounds = {
    minHeight: opts.minHeight ?? NATIVE_VIEW_MIN_HEIGHT,
    maxHeight: opts.maxHeight ?? NATIVE_VIEW_MAX_HEIGHT,
  };
  const initialHeight =
    clampNativeViewHeight(opts.initialHeight ?? NATIVE_VIEW_DEFAULT_HEIGHT, bounds) ??
    bounds.minHeight;
  const relay = opts.onUiAction;

  function NativeViewFrame({
    item,
    ctx,
    resource,
  }: NativeTranscriptItemProps<ViewMountItem> & { resource: NativeMcpAppFrameResource }): ReactNode {
    const [height, setHeight] = useState(initialHeight);
    // The phase this frame last reported; starts from the plan's view of it,
    // so a remounted frame does not report a phase twice.
    const phaseRef = useRef<ViewHostPhase>(item.phase === "expired" ? "negotiating" : item.phase);
    const latest = useRef<{ ctx: NativeTranscriptItemContext; item: ViewMountItem }>({ ctx, item });
    latest.current = { ctx, item };

    const signal = useCallback((s: NativeFrameSignal) => {
      const next = nextNativeViewPhase(phaseRef.current, s);
      if (next === phaseRef.current) return;
      phaseRef.current = next;
      latest.current.ctx.onViewPhase(latest.current.item.key, next);
    }, []);
    const onSizeChanged = useCallback(
      (size: { readonly width?: number; readonly height?: number }) => {
        signal("alive");
        const clamped = clampNativeViewHeight(size.height, bounds);
        if (clamped !== null) setHeight(clamped);
      },
      [signal],
    );
    const onToolCall = useCallback(
      (toolName: string, args: McpToolStructuredContent) => {
        signal("alive");
        return relayNativeToolCall(relay, latest.current.item.actionScope, toolName, args);
      },
      [signal],
    );
    const onLifecycle = useCallback(
      (event: { readonly state: string }) => {
        const s = lifecycleSignal(event.state);
        if (s !== null) signal(s);
      },
      [signal],
    );
    const onError = useCallback(() => signal("failed"), [signal]);

    return (
      <View style={{ gap: 4 }}>
        <View
          style={{
            height,
            borderRadius: ctx.tokens.radius,
            overflow: "hidden",
          }}
        >
          <Frame
            resource={resource}
            containerDimensions={{ height }}
            onSizeChanged={onSizeChanged}
            onToolCall={onToolCall}
            onLifecycle={onLifecycle}
            onError={onError}
          />
        </View>
        {item.attribution !== null ? (
          <Text
            style={{
              color: ctx.tokens.palette.inkMuted,
              fontSize: ctx.tokens.fontSize - 2,
              fontFamily: ctx.tokens.fontFamily,
            }}
          >
            {item.attribution}
          </Text>
        ) : null}
      </View>
    );
  }

  function NativeViewHostSlot({ item, ctx }: NativeTranscriptItemProps<ViewMountItem>): ReactNode {
    const choice = chooseNativeViewMount(item, ctx.resolvedMounts);
    if (choice.kind === "expired") {
      return <NativeView item={{ ...item, phase: "expired" }} ctx={ctx} />;
    }
    if (choice.kind === "pending") return <NativeView item={item} ctx={ctx} />;
    const resource = toNativeFrameResource(choice.mount.resource);
    // No inline content: nothing this host will mount. The kit's labeled
    // placeholder, never a WebView pointed at a bare uri.
    if (resource === null) return <NativeView item={{ ...item, label: null }} ctx={ctx} />;
    return <NativeViewFrame key={resource.uri} item={item} ctx={ctx} resource={resource} />;
  }

  return NativeViewHostSlot;
}
