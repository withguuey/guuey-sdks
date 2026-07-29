/**
 * The card-mount dispatcher: ONE narrowing that answers "what, if anything,
 * does this block mount?" across BOTH generative-UI channels a guuey pod
 * emits.
 *
 *   1. **inline mcp-ui resource** — `{uri, text|blob}` on `uiData`, or a
 *      `ui://` resource degraded into a `provider-raw` content part. Handled
 *      verbatim by `block-ui.ts`; this module does not touch that path, it
 *      only tries it FIRST.
 *   2. **ggui render** — `uiData.resourceUri` + the `_meta["ai.ggui/render"]`
 *      bootstrap, mounted through ggui's self-contained shell. See
 *      `ggui-render.ts`.
 *
 * Both channels land on the SAME `McpUiResourcePayload`, which is the whole
 * point: a host that already mounts inline resources through
 * `@mcp-ui/client`'s `AppRenderer` in a second-origin sandbox gains ggui cards
 * without a second mount mechanism, a second iframe contract, or a second
 * security posture to review.
 *
 * Precedence is inline-first and deliberate: an inline resource is the
 * server's explicit, self-sufficient HTML. A ggui render only ever wins when
 * there is no inline resource to prefer, so this dispatcher can never change
 * what an existing inline card renders.
 *
 * ## Why the CHANNEL is returned alongside the resource
 *
 * The payload alone cannot say where it came from — a ggui shell is a string
 * of HTML like any other. But a host has one decision that genuinely depends
 * on the origin of that HTML: WHICH sandbox host page to mount it in. A ggui
 * shell must load ggui's runtime bundle and open its WSS, so it needs a page
 * whose CSP names the ggui origins; an inline card is arbitrary tenant HTML
 * and must keep the self-only page it has always had. Handing back the channel
 * keeps that one narrowing in one place — the alternative was for every host
 * to re-run `toolResultGguiRender` beside this call and ask again.
 */
import { cardUiResource, toolResultUiResource, type McpUiResourcePayload } from "./block-ui";
import { blockGguiRender, gguiRenderResource, toolResultGguiRender } from "./ggui-render";
import type { AgBlock, JsonValue } from "@silverprotocol/core";

/** Which generative-UI channel produced a mount. See this module's header. */
export type CardMountChannel = "inline" | "ggui";

/** A mountable card: the resource to hand the host, and where it came from. */
export interface CardMount {
  /** The payload an mcp-ui host mounts, identical in shape for both channels. */
  resource: McpUiResourcePayload;
  /**
   * `"inline"` — the server's own HTML, untrusted tenant content.
   * `"ggui"` — a shell that boots the ggui runtime from a platform-pinned
   * origin, and therefore needs a host page whose CSP allows that origin.
   */
  channel: CardMountChannel;
}

/**
 * A live `tool-result` block → the card to mount, across both channels.
 * `undefined` when the block carries no generative UI at all (or carries a
 * ggui render whose bootstrap did not reach us — see `ggui-render.ts`).
 */
export function toolResultCardMount(
  block: Extract<AgBlock, { type: "tool-result" }>,
): CardMount | undefined {
  const inline = toolResultUiResource(block);
  if (inline) return { resource: inline, channel: "inline" };
  const ggui = toolResultGguiRender(block);
  const resource = ggui ? gguiRenderResource(ggui) : undefined;
  return resource ? { resource, channel: "ggui" } : undefined;
}

/**
 * A persisted `HistoryCard`'s `cardSnapshot` → the card to mount, across both
 * channels.
 *
 * The ggui arm is reached only for a snapshot that stored the render's
 * `_meta`; a bootstrap old enough to have been persisted has an expired
 * `wsToken` anyway, so in practice a ggui history card resolves to `undefined`
 * and the host renders its placeholder — honest, and NOT a broken mount.
 */
export function cardCardMount(cardSnapshot: JsonValue): CardMount | undefined {
  const inline = cardUiResource(cardSnapshot);
  if (inline) return { resource: inline, channel: "inline" };
  for (const block of snapshotBlocks(cardSnapshot)) {
    const ggui = blockGguiRender(block);
    const resource = ggui ? gguiRenderResource(ggui) : undefined;
    if (resource) return { resource, channel: "ggui" };
  }
  return undefined;
}

/**
 * The blocks to scan inside a card snapshot: the stored `AgArtifact`'s `parts`
 * when present, then the snapshot root itself — exactly `cardUiResource`'s own
 * walk order, so both channels see the same candidates in the same order.
 */
function snapshotBlocks(cardSnapshot: JsonValue): JsonValue[] {
  if (typeof cardSnapshot !== "object" || cardSnapshot === null || Array.isArray(cardSnapshot)) {
    return [];
  }
  const parts = cardSnapshot.parts;
  return Array.isArray(parts) ? [...parts, cardSnapshot] : [cardSnapshot];
}
