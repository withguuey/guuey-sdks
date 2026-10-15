/**
 * The decisions behind the native view host (`createNativeViewHost`), kept
 * free of React and React Native so each one is testable on its own:
 *
 *  - which mount material a `view` item mounts (direct material, or the
 *    locator's resolution) — the same choice the web kit's default view makes;
 *  - what the WebView frame is handed: inline `text` or `blob` only, never a
 *    bare `uri` (that would point the WebView at an arbitrary URL);
 *  - the content-reported height, clamped;
 *  - the view-host phase each frame signal moves to;
 *  - the `tools/call` relay, scoped to the item's `actionScope`.
 */
import {
  unavailableToolCallResult,
  type McpToolCallResult,
  type McpToolStructuredContent,
  type McpUiResourcePayload,
  type ResolvedViewMount,
  type UiActionRequest,
  type ViewHostPhase,
} from "@guuey/mcp-apps-host";
import type { ItemKey, ViewMountItem } from "../types.js";

/** What a `view` item mounts right now. */
export type NativeViewMountChoice =
  | { kind: "mount"; mount: ResolvedViewMount }
  /** The locator is dead, or the plan already marked the view expired. */
  | { kind: "expired" }
  /** A locator still resolving. */
  | { kind: "pending" };

/**
 * Resolve what to mount: direct material when the item carries it, else the
 * locator's resolution from `useTranscript` (`"expired"` = a failed read).
 */
export function chooseNativeViewMount(
  item: Pick<ViewMountItem, "key" | "mount" | "phase">,
  resolvedMounts: ReadonlyMap<ItemKey, ResolvedViewMount | "expired">,
): NativeViewMountChoice {
  const resolution = resolvedMounts.get(item.key);
  if (item.phase === "expired" || resolution === "expired") return { kind: "expired" };
  if (item.mount !== null && item.mount.channel !== "locator") {
    return { kind: "mount", mount: item.mount };
  }
  if (resolution !== undefined) return { kind: "mount", mount: resolution };
  return { kind: "pending" };
}

/** The resource a native MCP App frame mounts: always inline content. */
export type NativeMcpAppFrameResource =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string };

/**
 * A card payload → the inline resource the frame mounts, or `null` when it
 * carries no inline content. `mimeType` defaults to `text/html`.
 */
export function toNativeFrameResource(
  resource: McpUiResourcePayload,
): NativeMcpAppFrameResource | null {
  const mimeType = resource.mimeType ?? "text/html";
  if (resource.text !== undefined) return { uri: resource.uri, mimeType, text: resource.text };
  if (resource.blob !== undefined) return { uri: resource.uri, mimeType, blob: resource.blob };
  return null;
}

/** Height bounds for a native view frame, in points. */
export interface NativeViewHeightBounds {
  minHeight: number;
  maxHeight: number;
}

/** Defaults: the height before the first size report, and the clamp. */
export const NATIVE_VIEW_DEFAULT_HEIGHT = 360;
export const NATIVE_VIEW_MIN_HEIGHT = 160;
export const NATIVE_VIEW_MAX_HEIGHT = 760;

/**
 * Clamp a content-reported height into the bounds (rounded up, so the
 * content never clips by a fraction). A report without a usable height
 * returns `null`: keep the current one.
 */
export function clampNativeViewHeight(
  reported: number | undefined,
  bounds: NativeViewHeightBounds,
): number | null {
  if (reported === undefined || !Number.isFinite(reported)) return null;
  return Math.min(bounds.maxHeight, Math.max(bounds.minHeight, Math.ceil(reported)));
}

/**
 * A signal the native frame gives about the app inside it:
 *  - `alive`  — the app spoke the protocol (a size report, a tool call, or a
 *               renderer lifecycle `code-ready`): it is connected;
 *  - `failed` — the frame reported an error, or the renderer's lifecycle
 *               reached `error`.
 */
export type NativeFrameSignal = "alive" | "failed";

/**
 * The phase a signal moves the view to — the web host's vocabulary. Any sign
 * of life connects (a late one too, as on web). A failure counts only while
 * the view is still negotiating: a connected view that later reports an error
 * keeps its content and stays connected.
 */
export function nextNativeViewPhase(current: ViewHostPhase, signal: NativeFrameSignal): ViewHostPhase {
  if (signal === "alive") return "connected";
  return current === "negotiating" ? "no-handshake" : current;
}

/** A renderer lifecycle state → the frame signal it carries, if any. */
export function lifecycleSignal(state: string): NativeFrameSignal | null {
  if (state === "code-ready") return "alive";
  if (state === "error") return "failed";
  return null;
}

/** The relay a host wires for card actions (`createUiActionRelay`'s shape). */
export type NativeUiActionRelay = (request: UiActionRequest) => Promise<McpToolCallResult>;

/**
 * Relay one `tools/call` from the frame, scoped to the item's
 * `actionScope`. No relay, or no scope, answers the in-band "not available"
 * result; a relay that rejects is answered the same way — the view is always
 * answered, never left with a raw rejection.
 */
export async function relayNativeToolCall(
  relay: NativeUiActionRelay | undefined,
  actionScope: string | null,
  name: string,
  args: McpToolStructuredContent,
): Promise<McpToolCallResult> {
  if (relay === undefined || actionScope === null) return unavailableToolCallResult();
  try {
    return await relay({ resourceUri: actionScope, name, arguments: args });
  } catch {
    return unavailableToolCallResult();
  }
}
