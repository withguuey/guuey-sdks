/**
 * @deprecated — the ggui vendor arm is RETIRED (guuey#209, 2026-08-16).
 *
 * Everything in this module is kept exported for ONE MINOR under the
 * post-launch compatibility rule and is removed in the minor after the one
 * that ships this notice. Nothing in `@guuey/mcp-apps-host` calls it any
 * more: `toolResultViewMount` hands a ggui render back as a `ui://`
 * **locator** (`toolResultLocator`, either channel), the mount material
 * comes from a `resources/read` through a `UiResourceReader` (pod door
 * live, persisted door on rehydration), and the `"ggui"` sandbox-trust
 * channel is assigned at resolution from the requested uri
 * (`uiResourceChannel` in `reader.ts`). Migration per symbol:
 *
 *  - {@link asGguiRender} / {@link toolResultGguiRender} /
 *    {@link blockGguiRender} → `toolResultLocator(block)` — the locator is
 *    the recognition signal; there is no descriptor to build.
 *  - {@link gguiRenderResource} → resolve the locator through a reader
 *    (`resolveViewMount(mount, reader)`); ggui's `resources/read` returns
 *    the shell with live-channel material minted FRESH at read time.
 *  - {@link GGUI_RENDER_META_KEY} → the wire key is ggui's; import
 *    `MCP_APP_AI_GGUI_RENDER_META_KEY` from
 *    `@ggui-ai/protocol/integrations/mcp-apps` if you still inspect
 *    `_meta` (nothing here does).
 *  - {@link asGguiRenderBootstrap} / {@link gguiShellHtml} and their types
 *    are pure re-exports of ggui's protocol package — import them from
 *    `@ggui-ai/protocol/integrations/mcp-apps` directly.
 *
 * ## Why the arm existed, for the record
 *
 * A ggui render's `tool.done` used to carry two signals: `uiData.resourceUri`
 * (recognition — the only part surviving the fold) and the
 * `_meta["ai.ggui/render"]` bootstrap (mount material: runtime bundle,
 * live channel, seeded props). Because guuey's chat client is not an MCP
 * client (the pod holds the connection), a live locator had no host-side
 * read channel, so the bootstrap was inlined as a read-skipping fast path
 * and this module built ggui's self-contained shell from it. The pod door
 * (`GET <pod>/agent/ui-resource`, guuey#209 C1) closed that gap; ggui's
 * read-time mint (C2) made the read strictly fresher than the inlined
 * copy; the vendor arm's only reason to exist was gone.
 */
import type { AgBlock, JsonValue } from "@silverprotocol/core";
import {
  asGguiRenderBootstrap,
  gguiShellHtml,
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  type GguiRenderBootstrap,
} from "@ggui-ai/protocol/integrations/mcp-apps";
import { isJsonObject, type McpUiResourcePayload } from "./block-ui.js";

export {
  /** @deprecated import from `@ggui-ai/protocol/integrations/mcp-apps` (guuey#209; removed next minor). */
  asGguiRenderBootstrap,
  /** @deprecated import from `@ggui-ai/protocol/integrations/mcp-apps` (guuey#209; removed next minor). */
  gguiShellHtml,
} from "@ggui-ai/protocol/integrations/mcp-apps";
export type {
  /** @deprecated import from `@ggui-ai/protocol/integrations/mcp-apps` (guuey#209; removed next minor). */
  GguiRenderBootstrap,
  /** @deprecated import from `@ggui-ai/protocol/integrations/mcp-apps` (guuey#209; removed next minor). */
  GguiShellHtmlOptions,
} from "@ggui-ai/protocol/integrations/mcp-apps";

/**
 * The `_meta` key the ggui render bootstrap rides on. Alias of the
 * protocol package's own constant — one spelling, owned upstream.
 *
 * @deprecated guuey#209 — nothing in this package reads `_meta` any more.
 * Import `MCP_APP_AI_GGUI_RENDER_META_KEY` from
 * `@ggui-ai/protocol/integrations/mcp-apps` if you still need the key.
 * Removed in the minor after the one shipping this notice.
 */
export const GGUI_RENDER_META_KEY = MCP_APP_AI_GGUI_RENDER_META_KEY;

/** The `ui://` scheme prefix every ggui render resource uri carries. */
const UI_SCHEME = "ui://";

/**
 * A ggui render recognised on a tool result: its resource uri + mount material.
 * @deprecated guuey#209 — the locator (`toolResultLocator`) is the whole
 * recognition signal now; there is no descriptor to build. Removed next minor.
 */
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
 *
 * @deprecated guuey#209 — use `toolResultLocator(block)`; the vendor arm is
 * retired and nothing consumes the descriptor. Removed next minor.
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
 *
 * @deprecated guuey#209 — use `toolResultLocator(block)`. Removed next minor.
 */
export function toolResultGguiRender(
  block: Extract<AgBlock, { type: "tool-result" }>,
): GguiRenderDescriptor | undefined {
  return asGguiRender(block.uiData, block._meta);
}

/**
 * An untyped (persisted-snapshot) block → its ggui render descriptor, if it is one.
 * @deprecated guuey#209 — use `snapshotViewMount(cardSnapshot)`, whose locator
 * arm is the persisted path. Removed next minor.
 */
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
 * @deprecated guuey#209 — resolve the locator through a `UiResourceReader`
 * (`resolveViewMount`); ggui's `resources/read` returns the shell with
 * live-channel material minted FRESH at read time, which this inlined
 * copy could never be. Removed next minor.
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
