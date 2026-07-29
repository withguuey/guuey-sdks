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
 */
import { cardUiResource, toolResultUiResource, type McpUiResourcePayload } from "./block-ui";
import { blockGguiRender, gguiRenderResource, toolResultGguiRender } from "./ggui-render";
import type { AgBlock, JsonValue } from "@silverprotocol/core";

/**
 * A live `tool-result` block → the resource to mount, across both channels.
 * `undefined` when the block carries no generative UI at all (or carries a
 * ggui render whose bootstrap did not reach us — see `ggui-render.ts`).
 */
export function toolResultCardResource(
  block: Extract<AgBlock, { type: "tool-result" }>,
): McpUiResourcePayload | undefined {
  const inline = toolResultUiResource(block);
  if (inline) return inline;
  const ggui = toolResultGguiRender(block);
  return ggui ? gguiRenderResource(ggui) : undefined;
}

/**
 * A persisted `HistoryCard`'s `cardSnapshot` → the resource to mount, across
 * both channels.
 *
 * The ggui arm is reached only for a snapshot that stored the render's
 * `_meta`; a bootstrap old enough to have been persisted has an expired
 * `wsToken` anyway, so in practice a ggui history card resolves to `undefined`
 * and the host renders its placeholder — honest, and NOT a broken mount.
 */
export function cardCardResource(cardSnapshot: JsonValue): McpUiResourcePayload | undefined {
  const inline = cardUiResource(cardSnapshot);
  if (inline) return inline;
  for (const block of snapshotBlocks(cardSnapshot)) {
    const ggui = blockGguiRender(block);
    const resource = ggui ? gguiRenderResource(ggui) : undefined;
    if (resource) return resource;
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
