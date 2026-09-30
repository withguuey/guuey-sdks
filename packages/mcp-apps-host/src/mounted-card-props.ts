/**
 * A mounted ggui card's OWN props (guuey#2031): the props its document paints
 * from, read off the self-contained shell the host already holds.
 *
 * Every ggui card is mounted from a `resources/read` of its `ui://` locator, and
 * ggui's answer is its shell document, whose inlined render slice carries the
 * render session and ggui's stored CURRENT props (`propsJson`). So a card
 * painted before a reload, whose render the host's live fold never saw, still
 * tells the host what it shows: a tap on one of its quick replies resolves its
 * label from exactly the props the card painted.
 *
 * Trust: the document speaks only for the session its own mount names. Only a
 * `"ggui"` mount (a channel the host assigns from the locator it requested,
 * never from the response) is read, and its slice's session must be the one
 * the mount's own render locator names (the doors' rule,
 * {@link gguiRenderSessionId}): an inline mount is tenant HTML, which may
 * declare any slice it likes, and a slice naming another session describes a
 * card this mount is not.
 *
 * Narrow on purpose. It reads two fields with its own guard rather than the full
 * slice parser, which refuses a slice with any half-present field it validates:
 * the label needs the session and the props, nothing else. A missing or
 * malformed field is `undefined`, never a guess, so the tap falls back to the
 * continuation copy rather than to wrong words.
 *
 * The coupling is ggui's shell format (the writer `gguiShellHtml`, the reader
 * `readGguiShellEnvelope`, both ggui's own); the ask that `propsJson` stays on
 * the read shell as a stable host contract rides guuey#2031's ggui hand-off.
 */
import { MCP_APP_AI_GGUI_RENDER_META_KEY, readGguiShellEnvelope } from "@ggui-ai/protocol/integrations/mcp-apps";
import { gguiRenderSessionId } from "./action.js";
import type { ResolvedViewMount } from "./card-mount.js";
import type { MountedCardProps } from "./card-tap.js";
import { viewDocumentHtml } from "./view-host.js";

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The render session and props a mounted card's shell declares, or `undefined`
 * when the mount is not on the ggui channel, its own uri is not a ggui render
 * locator, its document is not a ggui shell, its slice lacks either field or
 * names another session than that locator, or `propsJson` is not a JSON object.
 */
export function mountedCardProps(mount: ResolvedViewMount): MountedCardProps | undefined {
  if (mount.channel !== "ggui") return undefined;
  const ownSession = gguiRenderSessionId(mount.resource.uri);
  if (ownSession === undefined) return undefined;
  const html = viewDocumentHtml(mount.resource);
  if (html === undefined) return undefined;
  const envelope: unknown = readGguiShellEnvelope(html);
  if (!isObject(envelope)) return undefined;
  const slice = envelope[MCP_APP_AI_GGUI_RENDER_META_KEY];
  if (!isObject(slice)) return undefined;
  const propsJson = slice["propsJson"];
  if (slice["sessionId"] !== ownSession || typeof propsJson !== "string") return undefined;
  let props: unknown;
  try {
    props = JSON.parse(propsJson);
  } catch {
    // A slice whose propsJson does not parse names no props: no base, so the continuation copy.
    return undefined;
  }
  return isObject(props) ? { sessionId: ownSession, props } : undefined;
}
