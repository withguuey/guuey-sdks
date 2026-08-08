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
export type CardMountChannel = "inline" | "ggui" | "locator";

/**
 * A mountable card, or the locator to fetch one with.
 *
 * `"inline"` — the server's own HTML, untrusted tenant content.
 * `"ggui"` — a shell that boots the ggui runtime from a platform-pinned
 * origin, and therefore needs a host page whose CSP allows that origin.
 * `"locator"` — no mount material in hand, only the durable `ui://`
 * identity (guuey#122): the host resolves it with a fresh, authenticated
 * `resources/read` of the uri ({@link UiResourceReader}) — MCP-Apps-spec
 * rehydration, vendor-neutral. Until a reader is wired, the honest render
 * is the host's own placeholder, never a stale mount.
 */
export type CardMount =
  | {
      channel: "inline" | "ggui";
      /** The payload an mcp-ui host mounts, identical in shape for both channels. */
      resource: McpUiResourcePayload;
    }
  | {
      channel: "locator";
      /** The persisted `uiData.resourceUri` (`ui://` scheme) to re-fetch. */
      resourceUri: string;
    };

/**
 * Resolves a `"locator"` mount by a fresh `resources/read` of the uri over
 * an AUTHENTICATED channel the HOST owns — guuey must enforce its own
 * user-ownership before fetching on a user's behalf, and a deny is
 * byte-identical to a miss (`undefined` → placeholder, never an error
 * surface). The reader returns a full {@link CardMount} because only the
 * transport knows which sandbox trust the fetched HTML needs (a ggui shell
 * wants the ggui-CSP page; arbitrary tenant HTML wants the self-only page).
 */
export type UiResourceReader = (resourceUri: string) => Promise<CardMount | undefined>;

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
  if (resource) return { resource, channel: "ggui" };
  // A live locator whose mount material didn't reach us (a fold that
  // dropped `_meta`): re-fetch works on live turns too — the resource is
  // freshly minted (guuey#122).
  return ggui ? { channel: "locator", resourceUri: ggui.resourceUri } : undefined;
}

/**
 * A persisted `HistoryCard`'s `cardSnapshot` → the card to mount.
 *
 * There is deliberately NO bootstrap arm here (guuey#122): persistence
 * strips tool-result `_meta` (see `@guuey/threads`' fold-rows), and a
 * foreign snapshot that still carries one holds an expired `wsToken` — a
 * dead mount. A persisted `ui://` locator resolves to the `"locator"`
 * channel instead: rehydration is a fresh `resources/read` of the uri,
 * MCP-Apps-spec-shaped and vendor-neutral.
 */
export function cardCardMount(cardSnapshot: JsonValue): CardMount | undefined {
  const inline = cardUiResource(cardSnapshot);
  if (inline) return { resource: inline, channel: "inline" };
  for (const block of snapshotBlocks(cardSnapshot)) {
    const render = blockGguiRender(block);
    if (render) return { channel: "locator", resourceUri: render.resourceUri };
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
