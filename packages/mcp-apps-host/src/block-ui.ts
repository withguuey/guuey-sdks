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
import type { AgBlock, JsonValue } from "@silverprotocol/core";

/**
 * A narrowed MCP UI resource payload — the `resources/read` `contents[]`
 * entry shape of SEP-1865 (uri + mimeType + text|blob), which is also the
 * pre-SEP mcp-ui embedded `resource` content-part shape. (No `_meta.ui.resource`
 * path exists in the spec; recognition rides `uiData`/content parts.)
 */
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
 *   - `tool-result` → its `uiData` surface channel, then a `ui://` resource
 *     degraded into a `provider-raw` content part — the SAME two channels
 *     the live path ({@link toolResultUiResource}) mounts. The write side
 *     (`nocode-runtime`'s `uiCardArtifactsFromMessages`, guuey#86) persists
 *     card rows for both, so the snapshot arm must mount both or
 *     provider-raw-only cards rehydrate as placeholders.
 *   - `provider-raw` → a `ui://` resource hiding in `raw`
 *   - `resource`     → a first-class embedded resource (gated on `ui://`)
 * Everything else → `undefined`.
 */
export function blockUiResource(block: JsonValue): McpUiResourcePayload | undefined {
  if (!isJsonObject(block)) return undefined;
  switch (block.type) {
    case "tool-result": {
      const fromUiData = asUiResource(block.uiData);
      if (fromUiData) return fromUiData;
      if (Array.isArray(block.content)) {
        for (const part of block.content) {
          if (isJsonObject(part) && part.type === "provider-raw") {
            const found = scanProviderRawForUiResource(part.raw);
            if (found) return found;
          }
        }
      }
      return undefined;
    }
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
/**
 * A `tool-result` block's `uiData.resourceUri` when it is a `ui://` locator
 * (MCP-Apps durable identity), else `undefined`. Vendor-neutral: ggui renders
 * are one producer of this shape.
 */
export function uiLocator(uiData: JsonValue | undefined): string | undefined {
  if (!isJsonObject(uiData)) return undefined;
  const uri = uiData.resourceUri;
  return typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined;
}

/**
 * The `ui://` locator a `tool-result` block carries, from EITHER channel it
 * can arrive on — the single seam every locator reader goes through.
 *
 * AgJSON §2.1 routes a tool result's `structuredContent` by its `_meta.ui`
 * sibling: WITH the sibling it is surface data and the normalizer stamps
 * `uiData`; WITHOUT it, it is model-channel data and lands in
 * `structuredContent`. A producer that withholds `_meta` (ggui's non-prod
 * posture; any plain-locator MCP server) therefore delivers a locator that
 * is byte-identical in shape but lives one field over — reading `uiData`
 * alone renders NOTHING for it (dark, not "expired"), and the persistence
 * projector minted no placeholder row (the read plane 404s). `uiData` wins
 * when both carry one (guuey#209 route-A finding).
 */
export function toolResultLocator(block: {
  uiData?: JsonValue;
  structuredContent?: JsonValue;
}): string | undefined {
  return uiLocator(block.uiData) ?? uiLocator(block.structuredContent);
}

export function snapshotUiResource(cardSnapshot: JsonValue): McpUiResourcePayload | undefined {
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
