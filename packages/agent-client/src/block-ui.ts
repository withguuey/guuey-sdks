/**
 * Pure block-walk / resource-narrowing helpers for a block-preserving agent
 * transcript — no React, no DOM, so the narrowing logic stays unit-testable in
 * isolation (this package's vitest runs a `node` environment) and can be shared
 * by every host renderer (Studio's `AgentBlocks`, Portal-web's agent chat).
 *
 * The pod's AgJSON wire carries generative-UI payloads on `tool.done` events,
 * which the reducer folds onto `tool-result` blocks. Two channels reach us:
 *
 *  1. **`uiData`** — the MCP-Apps *surface* channel. The pod's Claude facet
 *     routes a tool result's `structuredContent` here when the server stamped
 *     `_meta.ui`. Any resource here is intended as UI.
 *  2. **`provider-raw` content blocks** — an MCP embedded `resource` content
 *     part does NOT survive as a first-class `resource` AgBlock in the Claude
 *     facet; it degrades to `{ type:'provider-raw', vendor, raw:<part> }`. So a
 *     `ui://` resource can be hiding inside `provider-raw.raw` and must be
 *     scanned for defensively.
 *
 * The resource-narrowing (opaque `JsonValue` → typed payload) mirrors the
 * proven `create-agentic-app` web template — structural validation, never a cast.
 */
import type { AgBlock, AgMessage, JsonValue } from "@silverprotocol/core";
import type { HistoryCard } from "./types";

/** A narrowed MCP embedded UI resource (the `_meta.ui.resource` shape). */
export interface McpUiResourcePayload {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** Narrow an opaque `JsonValue` to a plain (non-array) JSON object. */
export function isJsonObject(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A JSON object → an MCP UI resource, if it has a `uri` plus renderable
 * payload (`text` or base64 `blob`). Returns `undefined` for anything else.
 */
export function asResourcePayload(v: JsonValue | undefined): McpUiResourcePayload | undefined {
  if (!isJsonObject(v)) return undefined;
  if (typeof v.uri !== "string") return undefined;
  if (typeof v.text !== "string" && typeof v.blob !== "string") return undefined;
  return {
    uri: v.uri,
    ...(typeof v.mimeType === "string" ? { mimeType: v.mimeType } : {}),
    ...(typeof v.text === "string" ? { text: v.text } : {}),
    ...(typeof v.blob === "string" ? { blob: v.blob } : {}),
  };
}

/**
 * Does a `tool-result` block's `uiData` carry an MCP embedded UI resource?
 * Accepts the resource inlined directly, or wrapped as `{ resource: {...} }`
 * (the shape an MCP `resource` content part carries). No `ui://` scheme gate
 * here on purpose: `uiData` is the explicit *surface* channel (the server
 * stamped `_meta.ui`), so any resource on it is meant to render.
 */
export function asUiResource(uiData: JsonValue | undefined): McpUiResourcePayload | undefined {
  if (!isJsonObject(uiData)) return undefined;
  const direct = asResourcePayload(uiData);
  if (direct) return direct;
  return asResourcePayload(uiData.resource);
}

/**
 * Scan a `provider-raw` block's `raw` (the vendor tool_result content part)
 * for a *generative-UI* resource. Unlike {@link asUiResource}, this path IS
 * gated on the `ui://` scheme: `provider-raw` degradation is a lossy catch-all,
 * so a plain file/text resource riding it is NOT a UI to mount — only the
 * mcp-ui `ui://` convention is.
 */
export function scanProviderRawForUiResource(
  raw: JsonValue | undefined,
): McpUiResourcePayload | undefined {
  if (!isJsonObject(raw)) return undefined;
  const candidate =
    raw.resource !== undefined ? asResourcePayload(raw.resource) : asResourcePayload(raw);
  if (!candidate) return undefined;
  return candidate.uri.startsWith("ui://") ? candidate : undefined;
}

/**
 * Extract a mountable UI resource from an opaque AgBlock-shaped `JsonValue`
 * (used for persisted card snapshot parts, which arrive untyped). Dispatches
 * by `block.type`:
 *   - `tool-result` → its `uiData` surface channel
 *   - `provider-raw` → a `ui://` resource hiding in `raw`
 *   - `resource`     → a first-class embedded resource (gated on `ui://`)
 * Everything else → `undefined`.
 */
export function blockUiResource(block: JsonValue): McpUiResourcePayload | undefined {
  if (!isJsonObject(block)) return undefined;
  switch (block.type) {
    case "tool-result":
      return asUiResource(block.uiData);
    case "provider-raw":
      return scanProviderRawForUiResource(block.raw);
    case "resource": {
      const r = asResourcePayload(block.resource);
      return r && r.uri.startsWith("ui://") ? r : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * A live `tool-result` AgBlock → its mountable UI resource, checking BOTH
 * channels the Claude facet uses:
 *   1. the `uiData` surface channel (server stamped `_meta.ui`), and
 *   2. an embedded `ui://` resource that degraded into a `provider-raw`
 *      content part inside the tool result (MCP `resource` parts do NOT survive
 *      as first-class `resource` AgBlocks here).
 * First-class `resource` content parts are intentionally not scanned in this
 * typed live path (the Claude facet never emits them); the untyped card path
 * ({@link blockUiResource}) covers them for other facets' persisted snapshots.
 */
export function toolResultUiResource(
  block: Extract<AgBlock, { type: "tool-result" }>,
): McpUiResourcePayload | undefined {
  const fromUiData = asUiResource(block.uiData);
  if (fromUiData) return fromUiData;
  for (const part of block.content) {
    if (part.type === "provider-raw") {
      const found = scanProviderRawForUiResource(part.raw);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * A persisted `HistoryCard`'s `cardSnapshot` → a mountable UI resource. The
 * snapshot is the verbatim `AgArtifact` the pod stored (`{ parts: AgBlock[] }`),
 * so walk its `parts` for the first block that yields a resource; fall back to
 * treating the snapshot root itself as a block.
 *
 * NOTE (`no-ggui-tools`): a ggui-rendered card carries NO inline HTML resource —
 * its UI rides `_meta.ggui.bootstrap` and mounts via `@ggui-ai/react`'s
 * `McpAppIframe`. That branch is OUT OF SCOPE for v1 (deferred-pending-capture).
 * So a real ggui card resolves to `undefined` here and renders as the host's
 * coherent placeholder, not a broken mount.
 */
export function cardUiResource(cardSnapshot: JsonValue): McpUiResourcePayload | undefined {
  if (!isJsonObject(cardSnapshot)) return undefined;
  const parts = cardSnapshot.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const found = blockUiResource(part);
      if (found) return found;
    }
  }
  return blockUiResource(cardSnapshot);
}

/**
 * The resource's HTML: inline `text` wins; else base64-decode `blob`. `atob`
 * alone yields a Latin-1 string (mojibake on multibyte UTF-8), so decode via
 * bytes + `TextDecoder`. Invalid base64 → `undefined` (no renderable payload).
 */
export function resourceHtml(resource: McpUiResourcePayload): string | undefined {
  if (resource.text !== undefined) return resource.text;
  if (resource.blob !== undefined) {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(resource.blob), (c) => c.charCodeAt(0)));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The tool name for a `tool-result` block, read off its paired `tool-call`
 * block in the same message (the reducer keeps both in one message's content).
 * Falls back to `"tool"` when the pair is missing.
 */
export function toolNameFor(message: AgMessage, toolCallId: string): string {
  for (const b of message.content) {
    if (b.type === "tool-call" && b.toolCallId === toolCallId) return b.name;
  }
  return "tool";
}

/**
 * Persisted cards, ascending by transcript `seq` (stable; input untouched).
 * These are PRIOR-turn cards — they always precede the live fold, so a
 * block-preserving renderer surfaces them first (e.g. under an "Earlier in
 * this conversation" divider).
 */
export function sortHistoryCards(cards: readonly HistoryCard[]): HistoryCard[] {
  return [...cards].sort((a, b) => a.seq - b.seq);
}
