/**
 * The card-mount dispatcher: ONE narrowing that answers "what, if anything,
 * does this block mount?" for every generative-UI shape a guuey pod emits.
 *
 *   1. **inline mcp-ui resource** — `{uri, text|blob}` on `uiData`, or a
 *      `ui://` resource degraded into a `provider-raw` content part. Handled
 *      verbatim by `block-ui.ts`; this module does not touch that path, it
 *      only tries it FIRST.
 *   2. **`ui://` locator** — the durable identity of a view produced by ANY
 *      MCP server (ggui's `ggui_render` included), on `uiData.resourceUri`
 *      when the producer sent `_meta.ui` (AgJSON §2.1 surface routing) or on
 *      `structuredContent.resourceUri` when it did not. The host resolves it
 *      by a fresh, authenticated `resources/read` of the uri
 *      ({@link UiResourceReader}) — the spec-consistent template fetch, on
 *      the live turn (pod door) and on rehydration (persisted door) alike.
 *
 * ## The ggui vendor arm is retired (guuey#209, 2026-08-16)
 *
 * This dispatcher used to carry a THIRD arm: when a `tool-result` carried the
 * `_meta["ai.ggui/render"]` bootstrap it built ggui's self-contained shell
 * inline and mounted it without a read — a fast path that existed only
 * because the pod holds the MCP connection and a live locator had no host-
 * side read channel. That precondition is gone: the pod door
 * (`GET <pod>/agent/ui-resource`) answers live-turn locators, the persisted
 * door answers rehydration, and ggui's `resources/read` mints the live-
 * channel material FRESH at read time — strictly fresher than any inlined
 * bootstrap. A ggui render is therefore just another locator producer; live
 * == rehydrated == spec. The arm's narrowing helpers were exported one
 * minor as `@deprecated` and removed at 0.8.0 (`ggui-render.ts` deleted).
 *
 * ## Why the CHANNEL is returned alongside the resource
 *
 * The payload alone cannot say where it came from — ggui's shell is a string
 * of HTML like any other. But a host has one decision that genuinely depends
 * on the origin of that HTML: WHICH sandbox host page to mount it in. A ggui
 * shell must load ggui's runtime bundle and open its WSS, so it needs a page
 * whose CSP names the ggui origins; an inline card is arbitrary tenant HTML
 * and must keep the self-only page it has always had. Since the flip the
 * channel is assigned at RESOLUTION time from the requested locator uri
 * (`uiResourceChannel` in `reader.ts` — `ui://ggui/…` → `"ggui"`), never
 * from the response and never from mount material a producer inlined.
 */
import { snapshotUiResource, toolResultLocator, toolResultUiResource, type McpUiResourcePayload } from "./block-ui.js";
import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";
import type { AgBlock, JsonValue } from "@silverprotocol/core";

/**
 * Which sandbox-trust channel a mount rides. See this module's header.
 * `"ggui"` is assigned at RESOLUTION time from the requested locator uri
 * (`uiResourceChannel`) — a `toolResultViewMount` result is only ever
 * `"inline"` or `"locator"`.
 */
export type ViewMountChannel = "inline" | "ggui" | "locator";

/**
 * A mountable card, or the locator to fetch one with.
 *
 * `"inline"` — the server's own HTML, untrusted tenant content.
 * `"ggui"` — a shell that boots the ggui runtime from a platform-pinned
 * origin, and therefore needs a host page whose CSP allows that origin.
 * `"locator"` — no mount material in hand, only the durable `ui://`
 * identity (guuey#122) — read from `uiData` OR, for a producer that
 * withheld `_meta` (AgJSON §2.1 then routes it to `structuredContent`),
 * from `structuredContent` (guuey#209): the host resolves it with a fresh, authenticated
 * `resources/read` of the uri ({@link UiResourceReader}) — the spec-consistent
 * template fetch, vendor-neutral. (The spec defers persistence/restoration
 * itself; a full remount additionally owes the View `ui/notifications/tool-input`
 * + its tool result — see the conformance map.) Until a reader is wired, the honest render
 * is the host's own placeholder, never a stale mount.
 */
export type ViewMount = ResolvedViewMount | LocatorViewMount;

/**
 * A view with mount material in hand — the arms a host can render directly,
 * and the ONLY arms a `UiResourceReader` resolves (guuey#127): a read either
 * yields mount material or the honest placeholder, never another locator.
 * `"ggui"` here always comes from a reader (`uiResourceChannel` on the
 * requested uri) — no dispatcher in this module produces it.
 */
export interface ResolvedViewMount {
  channel: "inline" | "ggui";
  /** The payload an mcp-ui host mounts, identical in shape for both channels. */
  resource: McpUiResourcePayload;
  /**
   * The server's per-resource CSP declaration (`_meta.ui.csp` on the
   * `resources/read` result — MCP Apps SEP-1865; guuey#312), when the read
   * path saw one. Spec-schema-validated at the reader
   * (`declaredResourceCsp`) — never fabricated, absent = undeclared. This
   * is the generic successor to the uri-prefix channel heuristic: hosts
   * derive per-card sandbox CSP / tripwire filters from it
   * (`<GuueyView>` defaults its `cspOrigins` from here).
   */
  csp?: McpUiResourceCsp;
}

/** The durable-identity arm: no mount material, only the uri to re-fetch. */
export interface LocatorViewMount {
  channel: "locator";
  /** The durable `ui://` locator to re-fetch (`uiData.resourceUri`, else `structuredContent.resourceUri`). */
  resourceUri: string;
}

/**
 * Resolves a `"locator"` mount by a fresh `resources/read` of the uri over
 * an AUTHENTICATED channel the HOST owns — guuey must enforce its own
 * user-ownership before fetching on a user's behalf, and a deny is
 * byte-identical to a miss (`undefined` → placeholder, never an error
 * surface). The reader returns a full {@link ViewMount} because only the
 * transport knows which sandbox trust the fetched HTML needs (a ggui shell
 * wants the ggui-CSP page; arbitrary tenant HTML wants the self-only page).
 */
export type UiResourceReader = (
  resourceUri: string,
  hints?: UiResourceReadHints,
) => Promise<ViewMount | undefined>;

/**
 * Optional per-read hints (guuey#421). `origin: "history"` tells a
 * two-door reader the locator came from a PERSISTED card — the pod door
 * serves live turns only and 404s such reads by construction, so a
 * history read may go straight to the platform door (kills the 2×404
 * noise on every old-conversation load). Absent/`"live"` keeps pod-first.
 * Purely advisory: a reader that ignores hints stays correct.
 */
export interface UiResourceReadHints {
  origin?: "live" | "history";
}

/**
 * A live `tool-result` block → the card to mount: an inline resource, else the
 * `ui://` locator (either channel — see `toolResultLocator`), else `undefined`
 * when the block carries no generative UI at all.
 *
 * A locator on a LIVE turn resolves through the pod door (its live-card
 * ledger registers the locator the moment the result streams — guuey#209
 * C1/C5); the same locator persisted resolves through the platform door.
 * One authority per lifecycle phase, one dispatcher for both.
 */
export function toolResultViewMount(
  block: Extract<AgBlock, { type: "tool-result" }>,
): ViewMount | undefined {
  const inline = toolResultUiResource(block);
  if (inline) return { resource: inline, channel: "inline" };
  const locator = toolResultLocator(block);
  return locator !== undefined ? { channel: "locator", resourceUri: locator } : undefined;
}

/**
 * A persisted `HistoryCard`'s `cardSnapshot` → the card to mount.
 *
 * Same two arms as the live dispatcher (since guuey#209 there is no third):
 * an inline resource, else the `ui://` locator. Persistence strips
 * tool-result `_meta` (see `@guuey/threads`' fold-rows), and a foreign
 * snapshot that still carries a stale bootstrap is ignored — its `wsToken`
 * expired minutes after the render. Rehydration is a fresh `resources/read`
 * of the uri, the spec-consistent template fetch, vendor-neutral.
 */
export function snapshotViewMount(cardSnapshot: JsonValue): ViewMount | undefined {
  const inline = snapshotUiResource(cardSnapshot);
  if (inline) return { resource: inline, channel: "inline" };
  for (const block of snapshotBlocks(cardSnapshot)) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    if (block.type !== "tool-result") continue;
    const locator = toolResultLocator(block);
    if (locator !== undefined) return { channel: "locator", resourceUri: locator };
  }
  return undefined;
}

/**
 * The resolved-only convenience over the mount union (guuey#186 G6): every
 * consumer that renders was writing the same two-call walk — narrow the
 * union, then feed the `"locator"` arm to a reader. This collapses it:
 *
 *  - already-resolved mounts pass through untouched (no reader round-trip);
 *  - a `"locator"` arm resolves via the reader — or the honest `undefined`
 *    (placeholder) when no reader is wired: never a stale mount;
 *  - a reader that answers with ANOTHER locator is treated as a miss. The
 *    {@link UiResourceReader} contract says a read yields mount material or
 *    nothing (guuey#127); a locator answer would loop, so the honest
 *    reading is "could not resolve", not recursion.
 *
 * Takes `ViewMount | undefined` so it chains directly off
 * `toolResultViewMount`/`snapshotViewMount` without a narrowing dance at
 * the call site.
 */
export async function resolveViewMount(
  mount: ViewMount | undefined,
  reader?: UiResourceReader,
  hints?: UiResourceReadHints,
): Promise<ResolvedViewMount | undefined> {
  if (mount === undefined || mount.channel !== "locator") return mount;
  if (reader === undefined) return undefined;
  const read = await reader(mount.resourceUri, hints);
  return read === undefined || read.channel === "locator" ? undefined : read;
}

/**
 * The blocks to scan inside a card snapshot: the stored `AgArtifact`'s `parts`
 * when present, then the snapshot root itself — exactly `snapshotUiResource`'s own
 * walk order, so both channels see the same candidates in the same order.
 */
function snapshotBlocks(cardSnapshot: JsonValue): JsonValue[] {
  if (typeof cardSnapshot !== "object" || cardSnapshot === null || Array.isArray(cardSnapshot)) {
    return [];
  }
  const parts = cardSnapshot.parts;
  return Array.isArray(parts) ? [...parts, cardSnapshot] : [cardSnapshot];
}
