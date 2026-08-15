/**
 * `attachViewHost` — the DOM glue around `view-host-protocol.ts`'s pure
 * machine (guuey#186 Gap 1). Framework-agnostic: any embedder with an
 * iframe can play the MCP Apps Host role with one call; `react.tsx` is one
 * convenience composition of exactly this, and a future full transcript
 * renderer composes the same primitive differently.
 *
 * This module is glue by DESIGN — every decision (what to answer, what to
 * refuse, when the negotiation window lapses) lives in the machine, which
 * the Node-only publish gate can test. What genuinely needs a browser is
 * this file's five moves: listen, identity-filter, post, time, detach —
 * covered by the monorepo's Playwright leg (`e2e/`), which the guuey-sdks
 * mirror deliberately does not carry.
 *
 * ## The identity filter (security invariant)
 *
 * Messages are matched by `event.source === frame.contentWindow`, NEVER by
 * `event.origin`: a view frame runs `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin`, so its origin is opaque — every message it posts
 * carries `"null"`, a value every other sandboxed frame on the page
 * shares, identifying nobody. The window handle is the only identity that
 * names the frame; a frame with no `contentWindow` matches nothing rather
 * than everything. Responses target `'*'` for the same reason: an opaque
 * origin is not addressable by name, and the handshake payload carries no
 * secrets — it is the result the spec defines for any host.
 *
 * Seeded from ggui's console `surface-host.ts` (donated, guuey#186 audit);
 * re-derived here against the pure machine + our own tests.
 */
import {
  initialViewHostState,
  resourceReadResponse,
  teardownMessage,
  toolCallResponse,
  viewHostElapsed,
  viewHostReceive,
  type ViewHostBehavior,
  type ViewHostOutbound,
  type ViewHostPhase,
  type ViewHostState,
} from "./view-host-protocol.js";
import type { McpResourceReadResult } from "./reader.js";
import {
  unavailableToolCallResult,
  type McpToolCallResult,
  type McpToolStructuredContent,
  type UiActionRequest,
} from "./action.js";
import type { McpUiResourcePayload } from "./block-ui.js";
import type { McpUiHostCapabilities, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { ViewHostInfo } from "./view-host-protocol.js";

/**
 * The slice of an `HTMLIFrameElement` this host actually touches — a
 * structural type so Node tests (and non-DOM hosts) can hand in a fake
 * without a single cast, same injection idiom as the package's readers and
 * relays. A real iframe element satisfies it as-is.
 */
export interface ViewFrameLike {
  readonly contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

/** The inbound side: what this host needs from `window`. */
export interface ViewHostEvents {
  addEventListener(
    type: "message",
    listener: (event: { data: unknown; source: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown; source: unknown }) => void,
  ): void;
}

export interface AttachViewHostConfig {
  /**
   * Capabilities to advertise in the initialize result. Default: `{}` —
   * correct for views that ride their own live channel (ggui views do;
   * they boot from their seeded envelope and talk to their pod directly),
   * and the honest floor for everyone else: advertise only what the
   * embedder implements. Exception: wiring {@link onCallTool} advertises
   * `serverTools` automatically — a wired relay IS the implementation —
   * and an explicit `hostCapabilities.serverTools` still wins.
   */
  hostCapabilities?: McpUiHostCapabilities;
  /** Host identity for the initialize result. */
  hostInfo?: ViewHostInfo;
  /**
   * Extra context merged over the derived defaults (locale from
   * `navigator`, container dimensions from the frame when it has laid
   * out — a 0×0 pre-layout reading is a lie the spec type shouldn't be
   * told). Keys given here win.
   */
  hostContext?: McpUiHostContext;
  /**
   * The `tools/call` relay — a PRIVILEGE boundary, default off: with no
   * hook, the machine refuses `tools/call` in-band and advertises no
   * `serverTools`. Wire `createMcpUiActionRelay` (or your own) to let the
   * mounted view reach tools over a transport the embedder owns. The
   * request's `name`/`arguments` are VIEW-CONTROLLED wire data — the hook
   * owns allowlisting and validation (`createMcpUiActionRelay` does both).
   */
  onCallTool?: (request: UiActionRequest) => Promise<McpToolCallResult>;
  /**
   * The mounted resource's `ui://` locator — the scope stamped on every
   * relayed {@link UiActionRequest}. Required for the relay to fire;
   * `<GuueyView>` fills it from the mount automatically.
   */
  resourceUri?: string;
  /**
   * The `resources/read` relay — a PRIVILEGE boundary like
   * {@link onCallTool}, default off: with no hook, the machine refuses
   * `resources/read` in-band and advertises no `serverResources`. The hook
   * is structurally the SAME transport `createMcpUiResourceReader`
   * assembles over ({@link CreateMcpUiResourceReaderDeps.readResource}) —
   * a host with a locator reader wires the identical function here. Trust
   * rules ride the reader discipline (`reader.ts`): enforcement lives
   * INSIDE the transport; a miss, a deny, and a throw all answer the view
   * with the one `Resource not found` error (deny == miss — no oracle).
   */
  onReadResource?: (uri: string) => Promise<McpResourceReadResult | undefined>;
  /**
   * The view reported its content size (`ui/notifications/size-changed` —
   * spec notification). Whether and how to resize the frame is the
   * embedder's layout decision; `<GuueyView autoResize>` is one wiring of
   * exactly this callback.
   */
  onSizeChanged?: (size: { width?: number; height?: number }) => void;
  /** Observe phase transitions (see {@link ViewHostPhase}). */
  onPhaseChange?: (phase: ViewHostPhase) => void;
  /**
   * How long to wait for `ui/initialize` before declaring
   * `"no-handshake"` (ms). `0` disables the timer. Default 8000 — a view
   * runtime negotiates immediately after parse; this bound exists to turn
   * "blank forever" into a labeled state, not to race slow networks.
   */
  negotiationTimeoutMs?: number;
  /** Message-event source, injectable for tests. Default: `window`. */
  events?: ViewHostEvents;
}

const DEFAULT_HOST_INFO: ViewHostInfo = { name: "guuey-view-host", version: "1" };
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 8000;

/** Derived + configured context, per the {@link AttachViewHostConfig.hostContext} contract. */
function hostContextFor(frame: ViewFrameLike, config: AttachViewHostConfig): McpUiHostContext {
  return {
    locale: typeof navigator !== "undefined" ? navigator.language : "en-US",
    ...(frame.clientWidth > 0 && frame.clientHeight > 0
      ? { containerDimensions: { width: frame.clientWidth, height: frame.clientHeight } }
      : {}),
    ...config.hostContext,
  };
}

function behaviorFor(frame: ViewFrameLike, config: AttachViewHostConfig): ViewHostBehavior {
  const relayWired = config.onCallTool !== undefined && config.resourceUri !== undefined;
  const readWired = config.onReadResource !== undefined;
  return {
    hostInfo: config.hostInfo ?? DEFAULT_HOST_INFO,
    hostCapabilities: {
      // A wired relay IS the implementation — advertise it; an explicit
      // hostCapabilities entry still wins (the serverTools precedent).
      ...(relayWired ? { serverTools: {} } : {}),
      ...(readWired ? { serverResources: {} } : {}),
      ...config.hostCapabilities,
    },
    hostContext: hostContextFor(frame, config),
    toolRelay: relayWired,
    resourceRelay: readWired,
  };
}

/**
 * Re-narrow a read hook's answer at the trust boundary — hooks are embedder
 * code (possibly plain JS), and the wire entry the view receives must be a
 * real `contents[]` entry: `uri` required, a string payload arm required
 * (a payload-less entry is a miss — the `createMcpUiResourceReader`
 * discipline, applied to the WIRE entry rather than the mountable payload).
 */
function narrowReadEntry(entry: McpResourceReadResult | undefined): McpResourceReadResult | undefined {
  if (entry === undefined || typeof entry.uri !== "string") return undefined;
  if (typeof entry.text !== "string" && typeof entry.blob !== "string") return undefined;
  return {
    uri: entry.uri,
    ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
    ...(typeof entry.text === "string" ? { text: entry.text } : {}),
    ...(typeof entry.blob === "string" ? { blob: entry.blob } : {}),
  };
}

/**
 * Attach the Host role to a mounted view frame. Returns a detach function;
 * call it before the frame unmounts — it stops listening and posts the
 * spec-mannered `ui/resource-teardown` farewell through the CACHED window
 * handle (post-removal, `frame.contentWindow` is already null).
 */
export function attachViewHost(frame: ViewFrameLike, config: AttachViewHostConfig = {}): () => void {
  const cachedWindow = frame.contentWindow;

  let state: ViewHostState = initialViewHostState();

  const setState = (next: ViewHostState): void => {
    const phaseChanged = next.phase !== state.phase;
    state = next;
    if (phaseChanged) config.onPhaseChange?.(next.phase);
  };

  const post = (message: ViewHostOutbound): void => {
    frame.contentWindow?.postMessage(message, "*");
  };

  const relay = (id: number | string, name: string, args?: McpToolStructuredContent): void => {
    const { onCallTool, resourceUri } = config;
    // The machine only emits the effect when the relay is wired (behavior
    // is derived from this same config), so these are invariants, not
    // runtime branches a view can steer.
    if (onCallTool === undefined || resourceUri === undefined) return;
    onCallTool({ resourceUri, name, ...(args === undefined ? {} : { arguments: args }) }).then(
      (result) => post(toolCallResponse(id, result)),
      // A relay hook that rejects (createMcpUiActionRelay never does, but
      // the hook is embedder code) still owes the view an answer — the
      // same in-band unavailable the relay itself uses, never a hang.
      () => post(toolCallResponse(id, unavailableToolCallResult())),
    );
  };

  const relayRead = (id: number | string, uri: string): void => {
    const { onReadResource } = config;
    if (onReadResource === undefined) return; // machine-guarded invariant, as with `relay`
    onReadResource(uri).then(
      (entry) => post(resourceReadResponse(id, narrowReadEntry(entry))),
      // A throwing hook still owes the view an answer — the same not-found
      // the reader discipline gives a deny (deny == miss), never a hang.
      () => post(resourceReadResponse(id, undefined)),
    );
  };

  const onMessage = (event: { data: unknown; source: unknown }): void => {
    if (frame.contentWindow === null || event.source !== frame.contentWindow) return;
    const { state: next, effects } = viewHostReceive(state, behaviorFor(frame, config), event.data);
    setState(next);
    for (const effect of effects) {
      if (effect.kind === "respond") post(effect.message);
      else if (effect.kind === "relay-tool-call") relay(effect.id, effect.name, effect.arguments);
      else if (effect.kind === "relay-resource-read") relayRead(effect.id, effect.uri);
      else {
        config.onSizeChanged?.({
          ...(effect.width !== undefined ? { width: effect.width } : {}),
          ...(effect.height !== undefined ? { height: effect.height } : {}),
        });
      }
    }
  };

  // One listener, two subscription paths: the injectable seam for Node
  // tests, and `window` — whose lib.dom listener typing wants the concrete
  // `MessageEvent` — for the browser default.
  const subscribe = (): (() => void) => {
    const { events } = config;
    if (events !== undefined) {
      events.addEventListener("message", onMessage);
      return () => events.removeEventListener("message", onMessage);
    }
    const domListener = (event: MessageEvent): void => onMessage(event);
    window.addEventListener("message", domListener);
    return () => window.removeEventListener("message", domListener);
  };
  const unsubscribe = subscribe();

  const timeoutMs = config.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS;
  const timer =
    timeoutMs > 0 ? setTimeout(() => setState(viewHostElapsed(state)), timeoutMs) : undefined;

  return () => {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    cachedWindow?.postMessage(teardownMessage(), "*");
  };
}

/**
 * The document a {@link McpUiResourcePayload} mounts: `text` verbatim, or
 * `blob` base64-decoded as UTF-8. `undefined` when the payload carries
 * neither — nothing to put in `srcdoc`.
 */
export function viewDocumentHtml(resource: McpUiResourcePayload): string | undefined {
  if (typeof resource.text === "string") return resource.text;
  if (typeof resource.blob === "string") {
    try {
      const bytes = Uint8Array.from(atob(resource.blob), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      // Malformed base64 is producer-side wire data, not an embedder bug —
      // the honest answer is "no document" (the same labeled state a
      // payload with neither field gets), not a render-time throw.
      return undefined;
    }
  }
  return undefined;
}
