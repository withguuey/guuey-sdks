/**
 * The **ggui render** channel: narrowing + self-contained shell construction
 * for a generative-UI card produced by the ggui MCP server (`ggui_render`).
 *
 * ## Where the pieces live (guuey#108 / ggui#427)
 *
 * The two halves of this channel have different owners, and the module is
 * split along that line:
 *
 *  - **ggui's wire contract** — what makes a `_meta` slice a mountable
 *    render bootstrap, and what the self-contained shell must contain — is
 *    OWNED by ggui and imported from
 *    `@ggui-ai/protocol/integrations/mcp-apps` ({@link asGguiRenderBootstrap},
 *    {@link gguiShellHtml}, the `ai.ggui/render` key). This package used to
 *    carry byte-compatible private copies (lifted upstream as ggui#427);
 *    re-exporting the originals means a shell-contract change lands here by
 *    bumping the pin, not by mirror-editing two repos.
 *  - **host/silverprotocol shapes** — the `uiData`-keyed RECOGNITION signal,
 *    the `AgBlock` tool-result narrowing, and the `McpUiResourcePayload`
 *    adapter onto the host's existing mcp-ui mount path — are guuey-side
 *    contracts and stay implemented here.
 *
 * ## Why recognition and mounting are separate
 *
 * A ggui render's `tool.done` carries two distinct signals:
 *
 *  1. **`uiData.resourceUri` is the RECOGNITION signal.** It is the only part
 *     of the render's identity that survives `@silverprotocol/core`'s fold
 *     (the reducer copies `uiData` — and, as of `@silverprotocol/core`
 *     0.4.1 (workspace#9), `_meta` — onto the `tool-result` block).
 *  2. **`_meta["ai.ggui/render"]` is the MOUNT MATERIAL.** Everything needed
 *     to boot the card — which runtime bundle to load, which live-channel to
 *     open, which props to seed — lives there and nowhere else.
 *
 * The shell {@link gguiShellHtml} builds is a string of HTML, so the ggui
 * card rides the host's EXISTING mcp-ui mount path unchanged: it narrows to
 * the same `McpUiResourcePayload` an inline resource does, so
 * `@mcp-ui/client`'s `AppRenderer` posts it as `srcdoc` into the
 * second-origin `mcp-app-sandbox.html` page — same double-iframe rule, same
 * sandbox origin, same opaque inner frame. No second mount mechanism.
 *
 * NOT in scope here: rehydrating a ggui card from persisted history. The
 * bootstrap's `wsToken` expires minutes after the render, so a stored
 * bootstrap is dead on arrival — a history card without a live bootstrap
 * correctly resolves to `undefined` and renders the host's placeholder
 * rather than a broken mount.
 */
import type { AgBlock, JsonValue } from "@silverprotocol/core";
import {
  asGguiRenderBootstrap,
  gguiShellHtml,
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  type GguiRenderBootstrap,
} from "@ggui-ai/protocol/integrations/mcp-apps";
import { isJsonObject, type McpUiResourcePayload } from "./block-ui";

export {
  asGguiRenderBootstrap,
  gguiShellHtml,
} from "@ggui-ai/protocol/integrations/mcp-apps";
export type {
  GguiRenderBootstrap,
  GguiShellHtmlOptions,
} from "@ggui-ai/protocol/integrations/mcp-apps";

/**
 * The `_meta` key the ggui render bootstrap rides on. Alias of the
 * protocol package's own constant — one spelling, owned upstream.
 */
export const GGUI_RENDER_META_KEY = MCP_APP_AI_GGUI_RENDER_META_KEY;

/** The `ui://` scheme prefix every ggui render resource uri carries. */
const UI_SCHEME = "ui://";

/** A ggui render recognised on a tool result: its resource uri + mount material. */
export interface GguiRenderDescriptor {
  /** `uiData.resourceUri` — `ui://ggui/render/<sessionId>/<contractHash>`. */
  resourceUri: string;
  /** `uiData.sessionId`, when present. */
  sessionId?: string;
  /**
   * The `_meta["ai.ggui/render"]` slice, when it reached us. Absent for a
   * persisted history card and for any consumer folding without `fold.ts`'s
   * `_meta` carriage — such a descriptor is recognised but NOT mountable.
   */
  bootstrap?: GguiRenderBootstrap;
}

/**
 * A tool result's `uiData` (+ its `_meta`, when carried) → a ggui render
 * descriptor, or `undefined` for anything that is not one.
 *
 * The `ui://` scheme gate is deliberate: `uiData` is a general-purpose channel
 * (every `structuredContent` of a `_meta.ui`-stamped tool lands there), so a
 * bare `resourceUri` string is not on its own a claim of generative UI.
 */
export function asGguiRender(
  uiData: JsonValue | undefined,
  meta: JsonValue | undefined,
): GguiRenderDescriptor | undefined {
  if (!isJsonObject(uiData)) return undefined;
  const resourceUri = uiData.resourceUri;
  if (typeof resourceUri !== "string" || !resourceUri.startsWith(UI_SCHEME)) return undefined;
  const bootstrap = asGguiRenderBootstrap(meta);
  return {
    resourceUri,
    ...(typeof uiData.sessionId === "string" ? { sessionId: uiData.sessionId } : {}),
    ...(bootstrap ? { bootstrap } : {}),
  };
}

/**
 * A live `tool-result` AgBlock → its ggui render descriptor, if it is one.
 *
 * NOTE: `@ggui-ai/protocol/integrations/mcp-apps` exports a helper of the
 * same name that narrows a spec-canonical MCP `CallToolResult` instead. This
 * one is the silverprotocol-side twin — the input is the FOLDED block, whose
 * `uiData`/`_meta` carriage is `@silverprotocol/core`'s contract, not ggui's.
 */
export function toolResultGguiRender(
  block: Extract<AgBlock, { type: "tool-result" }>,
): GguiRenderDescriptor | undefined {
  return asGguiRender(block.uiData, block._meta);
}

/** An untyped (persisted-snapshot) block → its ggui render descriptor, if it is one. */
export function blockGguiRender(block: JsonValue): GguiRenderDescriptor | undefined {
  if (!isJsonObject(block)) return undefined;
  if (block.type !== "tool-result") return undefined;
  return asGguiRender(block.uiData, block._meta);
}

/**
 * A ggui render descriptor → the mountable resource the host's existing
 * mcp-ui path already knows how to mount, or `undefined` when the descriptor
 * carries no bootstrap (history cards, and any fold that dropped `_meta`).
 *
 * The `uri` is the render's REAL `resourceUri` — the shell is the payload, not
 * a renaming of the resource.
 *
 * The shell is built `background: 'transparent'`: every guuey host that
 * mounts through this adapter (widget, portal web, Studio) draws its own
 * card chrome around the iframe, so the host page composits behind the card.
 * The upstream default (`'surface'`) is for standalone served documents —
 * see `GguiShellHtmlOptions` in `@ggui-ai/protocol/integrations/mcp-apps`.
 *
 * **On `_meta` being required to MOUNT (but never to RECOGNISE).** Recognition
 * — "this tool result is a ggui card" — is keyed on `uiData.resourceUri` alone
 * and never waits for anything (see {@link asGguiRender}); nothing in this
 * package is blocked on an upstream change. Mounting is different, and the
 * requirement is ggui's, not ours: its runtime rejects a slice without
 * `runtimeUrl` AND without at least one mode discriminator (`wsUrl`+`wsToken`,
 * `codeUrl`, or `kind`) as `MALFORMED_BOOTSTRAP` and renders nothing. `uiData`
 * carries none of those fields, so a bootstrap-less descriptor could only ever
 * produce a blank frame; returning `undefined` and letting the host show its
 * own placeholder is the honest answer, not a deferral. `@silverprotocol/core`'s
 * `Reducer` is what puts `_meta` on the block for a live turn, in-repo, today.
 */
export function gguiRenderResource(
  render: GguiRenderDescriptor,
): McpUiResourcePayload | undefined {
  if (!render.bootstrap) return undefined;
  return {
    uri: render.resourceUri,
    mimeType: "text/html",
    text: gguiShellHtml(render.bootstrap, { background: "transparent" }),
  };
}
