/**
 * A native MCP Apps frame (guuey#3377): a WebView the host supplies, answered
 * by the same SEP-1865 host machine the web host uses (`attachViewHost` from
 * `@guuey/mcp-apps-host`). Hand the component `createMcpAppFrame` returns to
 * `createNativeViewHost({ McpAppIframe })`.
 *
 * The kit's native tier ships no WebView dependency: the host passes the
 * `WebView` from its own `react-native-webview`, typed here against the
 * structural slice this frame uses ({@link McpAppWebViewProps},
 * {@link McpAppWebViewHandle}). The host's own typecheck against the real
 * component is the guard that the slice matches it.
 *
 * Posture, stated: the document mounts from inline `text` (or a `blob`
 * decoded by the web host's own decoder), never a bare `uri`; the shim is
 * injected into the main frame only; a top-level navigation anywhere but
 * `about:blank` is refused (links go only
 * through `ui/open-link`, whose `http:`/`https:` gate is the machine's);
 * popups and gesture-free media are off; `incognito` keeps the card's
 * cookies and storage apart from every other WebView. A card's NETWORK reach
 * is not confined on native (on web the sandbox page's CSP confines it); that
 * is its own row.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentType,
  type ReactNode,
  type RefAttributes,
} from "react";
import { Linking, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import {
  attachViewHost,
  viewDocumentHtml,
  type ViewFrameLike,
  type ViewHostEvents,
} from "@guuey/mcp-apps-host";
import type { NativeMcpAppFrameProps } from "../view-host.js";
import { buildDeliveryScript, buildInjectedBridgeScript, mintBridgeNonce, readBridgeEnvelope } from "./bridge.js";

/** The WebView `onMessage` event, as far as this frame reads it. */
export interface McpAppWebViewMessageEvent {
  readonly nativeEvent: { readonly data: string };
}

/** A load the WebView asks about (`onShouldStartLoadWithRequest`). */
export interface McpAppWebViewLoadRequest {
  readonly url: string;
  /** iOS reports it; absent means the top frame. */
  readonly isTopFrame?: boolean;
}

/** The props this frame sets on the host's `WebView` (react-native-webview's names). */
export interface McpAppWebViewProps {
  source: { html: string };
  injectedJavaScriptBeforeContentLoaded: string;
  /** Always `true`: the shim, which carries this mount's nonce, must never reach a nested frame. */
  injectedJavaScriptBeforeContentLoadedForMainFrameOnly: boolean;
  onMessage: (event: McpAppWebViewMessageEvent) => void;
  onShouldStartLoadWithRequest: (request: McpAppWebViewLoadRequest) => boolean;
  onError?: () => void;
  javaScriptEnabled: boolean;
  setSupportMultipleWindows: boolean;
  javaScriptCanOpenWindowsAutomatically: boolean;
  mediaPlaybackRequiresUserAction: boolean;
  incognito: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** The one method this frame calls on the WebView instance. */
export interface McpAppWebViewHandle {
  injectJavaScript(script: string): void;
}

/** The host's `WebView` component, as far as this frame uses it. */
export type McpAppWebView = ComponentType<McpAppWebViewProps & RefAttributes<McpAppWebViewHandle>>;

/** Options for {@link createMcpAppFrame}. */
export interface CreateMcpAppFrameOptions {
  /** `WebView` from the host's own `react-native-webview`. */
  WebView: McpAppWebView;
}

/**
 * A top-frame load is allowed only to `about:blank`, the URL the inline
 * document (`source={{ html }}`) is expected to load as on both platforms
 * (to be confirmed on iOS and Android in the first real-WebView run: if a
 * platform reports another URL, the card does not mount, the loud and safe
 * failure); every other
 * top-frame navigation is refused (links go through `ui/open-link`). A
 * card's own sub-frame loads are allowed: they follow from its unconfined
 * network reach, and are not a confinement.
 */
export function isInitialDocumentLoad(request: McpAppWebViewLoadRequest): boolean {
  if (request.isTopFrame === false) return true;
  return request.url === "about:blank";
}

/** The machine's phase → the lifecycle state the frame reports (the view host maps it). */
function phaseLifecycle(phase: string): { readonly state: string } {
  return { state: phase };
}

/**
 * Build the native frame from the host's `WebView`. The result takes exactly
 * `NativeMcpAppFrameProps`, so it is what `createNativeViewHost` expects.
 */
export function createMcpAppFrame({ WebView }: CreateMcpAppFrameOptions): ComponentType<NativeMcpAppFrameProps> {
  function McpAppFrame(props: NativeMcpAppFrameProps): ReactNode {
    const { resource, containerDimensions } = props;
    const html = useMemo(() => viewDocumentHtml(resource), [resource]);

    // Callbacks read through a ref, so the host machine attached once per
    // document always calls the latest props.
    const latest = useRef(props);
    latest.current = props;

    // The last mounted WebView. Kept through unmount (never reset to null), so
    // the machine's teardown, posted from the effect cleanup after React has
    // detached refs, still reaches the page.
    const webView = useRef<McpAppWebViewHandle | null>(null);
    const keepWebView = useCallback((handle: McpAppWebViewHandle | null) => {
      if (handle !== null) webView.current = handle;
    }, []);
    const layout = useRef({ width: 0, height: 0 });
    const nonce = useMemo(() => mintBridgeNonce(), []);
    const injected = useMemo(() => buildInjectedBridgeScript(nonce), [nonce]);

    // ONE contentWindow for the life of the mount: the machine accepts a
    // message only when its source IS this object (on native, the nonce is
    // what earns that source).
    const contentWindow = useMemo(
      () => ({
        postMessage(message: unknown): void {
          webView.current?.injectJavaScript(buildDeliveryScript(message));
        },
      }),
      [],
    );
    const listeners = useRef(new Set<(event: { data: unknown; source: unknown }) => void>());

    useEffect(() => {
      if (html === undefined) {
        latest.current.onError?.({ kind: "malformed-resource" });
        return undefined;
      }
      const frame: ViewFrameLike = {
        contentWindow,
        get clientWidth() {
          return layout.current.width;
        },
        get clientHeight() {
          return layout.current.height;
        },
      };
      const events: ViewHostEvents = {
        addEventListener: (_type, listener) => {
          listeners.current.add(listener);
        },
        removeEventListener: (_type, listener) => {
          listeners.current.delete(listener);
        },
      };
      return attachViewHost(frame, {
        events,
        resourceUri: resource.uri,
        onCallTool: (request) => {
          const onToolCall = latest.current.onToolCall;
          if (onToolCall === undefined) {
            return Promise.resolve({
              content: [{ type: "text", text: "This card's actions are not available here." }],
              isError: true,
            });
          }
          return onToolCall(request.name, request.arguments ?? {});
        },
        onSizeChanged: (size) => latest.current.onSizeChanged?.(size),
        onOpenLink: (url) => {
          Linking.openURL(url).catch(() => latest.current.onError?.({ kind: "open-link-failed" }));
        },
        onPhaseChange: (phase) => latest.current.onLifecycle?.(phaseLifecycle(phase)),
      });
    }, [html, resource.uri, contentWindow]);

    const onMessage = useCallback(
      (event: McpAppWebViewMessageEvent) => {
        const envelope = readBridgeEnvelope(event.nativeEvent.data, nonce);
        if (envelope === undefined) return;
        for (const listener of [...listeners.current]) listener({ data: envelope.payload, source: contentWindow });
      },
      [nonce, contentWindow],
    );
    const onLayout = useCallback((event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      layout.current = { width, height };
    }, []);
    const onWebViewError = useCallback(() => latest.current.onError?.({ kind: "webview-error" }), []);

    const height = containerDimensions?.height;
    return (
      <View style={{ flex: height === undefined ? 1 : undefined, height }} onLayout={onLayout}>
        {html === undefined ? null : (
          <WebView
            ref={keepWebView}
            testID="mcp-app-frame-webview"
            source={{ html }}
            injectedJavaScriptBeforeContentLoaded={injected}
            injectedJavaScriptBeforeContentLoadedForMainFrameOnly
            onMessage={onMessage}
            onShouldStartLoadWithRequest={isInitialDocumentLoad}
            onError={onWebViewError}
            javaScriptEnabled
            setSupportMultipleWindows={false}
            javaScriptCanOpenWindowsAutomatically={false}
            mediaPlaybackRequiresUserAction
            incognito
            style={{ flex: 1, backgroundColor: "transparent" }}
          />
        )}
      </View>
    );
  }
  return McpAppFrame;
}
