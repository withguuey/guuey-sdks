/**
 * The **ggui render** channel: narrowing + self-contained shell construction
 * for a generative-UI card produced by the ggui MCP server (`ggui_render`).
 *
 * ## Why this is a second channel and not the existing one
 *
 * `block-ui.ts`'s original narrowing accepts exactly one shape — an mcp-ui
 * embedded resource that carries its HTML INLINE (`{uri, text|blob}`). A ggui
 * render carries no HTML at all. Its `tool.done` looks like this on the wire
 * (shaped identically to the production capture the widget's fixtures
 * replay, but with the SAME synthetic ids those redacted fixtures use —
 * `apps/widget/src/fixtures/issue2627-render-capture.sse.txt` seq 48):
 *
 * ```jsonc
 * {"type":"tool.done", "toolCallId":"toolu_0000…0005",
 *  "uiData":{"sessionId":"render_0000…0001",
 *            "resourceUri":"ui://ggui/render/render_0000…0001/c10a2055…", … },
 *  "_meta":{"ai.ggui/render":{"sessionId":"render_0000…0001","appId":"APP00000",
 *              "runtimeUrl":"https://dev.mcp.sandbox.ggui.ai/_ggui/iframe-runtime.js",
 *              "wsUrl":"wss://…/ws","wsToken":"eyJ…","expiresAt":"…",
 *              "propsJson":"{…}"},
 *           "ui":{"resourceUri":"ui://ggui/render/…"}}}
 * ```
 *
 * Two facts follow, and they shape everything below:
 *
 *  1. **`uiData.resourceUri` is the RECOGNITION signal.** It is the only part
 *     of the render's identity that survives `@silverprotocol/core`'s fold
 *     (the reducer copies `uiData` onto the `tool-result` block but drops
 *     `ev._meta` — see `fold.ts` for the guuey-side carriage that puts it
 *     back).
 *  2. **`_meta["ai.ggui/render"]` is the MOUNT MATERIAL.** Everything needed
 *     to boot the card — which runtime bundle to load, which live-channel to
 *     open, which props to seed — lives there and nowhere else.
 *
 * ## How the card mounts (the ggui-documented self-contained shell)
 *
 * ggui's iframe runtime accepts its bootstrap from three delivery channels;
 * the highest-priority one is the **self-contained shell**: HTML that inlines
 * the slice envelope at `globalThis.__GGUI_META__` synchronously BEFORE the
 * runtime bundle's `<script type="module">` evaluates, after which the runtime
 * autostarts, creates its own mount container and renders — no postMessage
 * round-trip, no host-side ggui code. That contract is stated verbatim by the
 * runtime's own reader (`@ggui-ai/iframe-runtime`'s `parseMetaFromGlobal`:
 * *"The global carries the SAME slice envelope shape as the wire `_meta`
 * (`{ "ai.ggui/render": {...} }`) … per-render shells populate this
 * synchronously BEFORE the runtime bundle's `<script type="module">`
 * evaluates"*), and by its boot resolver (`runtime.js`'s autostart:
 * `readSelfContainedMeta()` first, postMessage channels after).
 *
 * {@link gguiShellHtml} builds exactly that shell. Because the shell IS a
 * string of HTML, the ggui card then rides the host's EXISTING mcp-ui mount
 * path unchanged: it narrows to the same `McpUiResourcePayload` an inline
 * resource does, so `@mcp-ui/client`'s `AppRenderer` posts it as `srcdoc` into
 * the second-origin `mcp-app-sandbox.html` page — same double-iframe rule,
 * same sandbox origin, same opaque inner frame. No second mount mechanism.
 *
 * The slice is inlined **verbatim**: `runtimeUrl` is honored as given (ggui's
 * host checklist item 8 — "no fallback URL, no substitution"), and every other
 * field is passed through untouched for the runtime's own projector to
 * validate. This module reads exactly one field (`runtimeUrl`) and only to
 * prove the slice is mountable at all.
 *
 * NOT in scope here: rehydrating a ggui card from persisted history. The
 * bootstrap's `wsToken` expires minutes after the render (`expiresAt` in the
 * capture above), so a stored bootstrap is dead on arrival — a history card
 * without a live bootstrap correctly resolves to `undefined` and renders the
 * host's placeholder rather than a broken mount.
 */
import type { AgBlock, JsonValue } from "@silverprotocol/core";
import { isJsonObject, type McpUiResourcePayload } from "./block-ui";

/** The `_meta` key the ggui render bootstrap rides on (MCP-Apps slice convention). */
export const GGUI_RENDER_META_KEY = "ai.ggui/render";

/** The `ui://` scheme prefix every ggui render resource uri carries. */
const UI_SCHEME = "ui://";

/**
 * A ggui render bootstrap: the runtime bundle URL this module reads, plus the
 * WHOLE `ai.ggui/render` slice, verbatim, for the shell to inline.
 */
export interface GguiRenderBootstrap {
  /** `runtimeUrl` — the ESM bundle the shell loads. Honored as given. */
  runtimeUrl: string;
  /**
   * The verbatim slice. Open-ended by construction: it is ggui's wire
   * contract, not one this package owns, and the runtime's own projector is
   * the authority on every field. Re-declaring it here would duplicate a
   * contract we do not own and rot at ggui's next field addition.
   */
  slice: { [key: string]: JsonValue };
}

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

/** A non-empty JSON string field. */
function isNonEmptyString(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Does this slice carry at least one MOUNT MODE discriminator?
 *
 * Mirrors `@ggui-ai/iframe-runtime`'s `validateMeta` (see
 * `node_modules/@ggui-ai/iframe-runtime/dist/meta-parse.d.ts`) and the
 * `McpAppAiGguiRenderMeta` doc comment it implements
 * (`@ggui-ai/protocol/integrations/mcp-apps`): the runtime needs `runtimeUrl`
 * PLUS one of live mode (`wsUrl` + `wsToken` together), `codeUrl`, or `kind` —
 * without one of those three the iframe has nothing to mount.
 */
function hasModeDiscriminator(slice: { [key: string]: JsonValue }): boolean {
  if (isNonEmptyString(slice.wsUrl) && isNonEmptyString(slice.wsToken)) return true;
  if (isNonEmptyString(slice.codeUrl)) return true;
  if (isNonEmptyString(slice.kind)) return true;
  return false;
}

/**
 * A `_meta` container → the ggui render bootstrap, or `undefined`.
 *
 * Two hard requirements, both the runtime's own `validateMeta` enforces
 * (`MALFORMED_BOOTSTRAP`): a non-empty `runtimeUrl`, AND at least one mode
 * discriminator (see {@link hasModeDiscriminator}). A slice with `runtimeUrl`
 * alone has a bundle to load but nothing for it to mount — the runtime would
 * boot into a blank shell rather than a card, so this guard treats that shape
 * as unmountable too and returns `undefined`.
 */
export function asGguiRenderBootstrap(meta: JsonValue | undefined): GguiRenderBootstrap | undefined {
  if (!isJsonObject(meta)) return undefined;
  const slice = meta[GGUI_RENDER_META_KEY];
  if (!isJsonObject(slice)) return undefined;
  const runtimeUrl = slice.runtimeUrl;
  if (typeof runtimeUrl !== "string" || runtimeUrl.length === 0) return undefined;
  if (!hasModeDiscriminator(slice)) return undefined;
  return { runtimeUrl, slice };
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

/** A live `tool-result` AgBlock → its ggui render descriptor, if it is one. */
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
 * Embed a JSON value inside an inline `<script>` safely.
 *
 * `</script` inside a string literal terminates the element in the HTML
 * parser regardless of JS quoting, and U+2028/U+2029 are line terminators in
 * JS source but not in JSON — both are escaped at the `<`/codepoint level so
 * the emitted text is still exactly the same JSON value.
 */
function inlineJson(value: JsonValue): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Escape a string for use inside a double-quoted HTML attribute. */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The ggui **self-contained shell** for a render bootstrap — see this module's
 * header for the contract it implements.
 *
 * Ordering is guaranteed twice over: the classic `<script>` runs during parse,
 * and the runtime's `<script type="module">` is deferred by definition, so the
 * global is always populated before the bundle evaluates.
 */
export function gguiShellHtml(bootstrap: GguiRenderBootstrap): string {
  const envelope = inlineJson({ [GGUI_RENDER_META_KEY]: bootstrap.slice });
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    "<title>ggui card</title>",
    "<style>html,body{margin:0;height:100%;background:transparent}</style>",
    `<script>globalThis.__GGUI_META__=${envelope};</script>`,
    `<script type="module" src="${attr(bootstrap.runtimeUrl)}"></script>`,
    "</head>",
    "<body></body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * A ggui render descriptor → the mountable resource the host's existing
 * mcp-ui path already knows how to mount, or `undefined` when the descriptor
 * carries no bootstrap (history cards, and any fold that dropped `_meta`).
 *
 * The `uri` is the render's REAL `resourceUri` — the shell is the payload, not
 * a renaming of the resource.
 *
 * **On `_meta` being required to MOUNT (but never to RECOGNISE).** Recognition
 * — "this tool result is a ggui card" — is keyed on `uiData.resourceUri` alone
 * and never waits for anything (see {@link asGguiRender}); nothing in this
 * package is blocked on an upstream change. Mounting is different, and the
 * requirement is ggui's, not ours: its runtime rejects a slice without
 * `runtimeUrl` AND without at least one mode discriminator (`wsUrl`+`wsToken`,
 * `codeUrl`, or `kind`) as `MALFORMED_BOOTSTRAP` and renders nothing. `uiData`
 * carries none of those fields — it has `sessionId`, `resourceUri`, `action`,
 * `contractHash`, `blueprintId`, `variantKey`, `cache`, `nextStep`, and that is
 * all. So a bootstrap-less descriptor could only ever produce a blank frame;
 * returning `undefined` and letting the host show its own placeholder is the
 * honest answer, not a deferral. `@guuey/agent-client`'s `BlockFold` is what
 * puts `_meta` on the block for a live turn, in-repo, today.
 */
export function gguiRenderResource(
  render: GguiRenderDescriptor,
): McpUiResourcePayload | undefined {
  if (!render.bootstrap) return undefined;
  return {
    uri: render.resourceUri,
    mimeType: "text/html",
    text: gguiShellHtml(render.bootstrap),
  };
}
