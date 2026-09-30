/**
 * A card tap, read at tap time (guuey#2031).
 *
 * When a visitor taps a control on a ggui card, the card's runtime relays a
 * `ggui_runtime_submit_action` `tools/call` through the host. That call carries
 * no words, only ids; after the relay answers, the runtime may ring the host's
 * `ui/message` doorbell, whose first content block's `_meta` names the same
 * `actionId`. The host joins the two on that id and draws the tap at once, in
 * the tapped control's own words when the host holds them.
 *
 *  - {@link readSubmitActionTap} reads the tap out of the relayed call, through
 *    ggui's own envelope guard;
 *  - {@link readUserActionMeta} reads the doorbell's structured mirror;
 *  - {@link submitActionOutcome} predicts whether the runtime will ring at all
 *    (a MIRROR of the runtime's classifier — see its docblock);
 *  - {@link resolveTapLabel} names the words: a quick reply's label from the
 *    props the host already holds, or `null` (the continuation copy).
 *
 * Trust: the card contributes only its session id and the tapped reply's id;
 * the words come from props the host holds (the paint the visitor sees), so a
 * card can at most select another on-screen chip label. The label is
 * display-only: it never reaches a model path.
 */
import {
  isGguiSubmitActionInput,
  isGguiSubmitDispatchInput,
  type GguiUserActionMeta,
} from "@ggui-ai/protocol/integrations/mcp-apps";
import type { McpToolCallResult, UiActionRequest } from "./action.js";
import { latestPaintProps, quickReplyLabel, type CardProps, type PaintPart } from "./paint-props.js";
import { tapText } from "./tap-labels.js";

/** The one runtime tool that carries a user gesture. */
const SUBMIT_ACTION_TOOL = "ggui_runtime_submit_action";

/** What a relayed gesture says about itself: its render session, its action id, and the id of the reply it chose. */
export interface SubmitActionTap {
  renderSessionId: string;
  /** ggui mints one per gesture; the doorbell repeats it. The join key. */
  actionId: string;
  /** `actionData.id` when the dispatch carries a string one (a chip does); `null` for anything else. */
  dataId: string | null;
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tap inside a relayed `tools/call`, or `null` unless it is a
 * `ggui_runtime_submit_action` whose arguments ggui's own guard admits as a
 * `dispatch`.
 */
export function readSubmitActionTap(request: UiActionRequest): SubmitActionTap | null {
  if (request.name !== SUBMIT_ACTION_TOOL) return null;
  const args = request.arguments;
  if (!isGguiSubmitActionInput(args) || !isGguiSubmitDispatchInput(args)) return null;
  const data = args.payload.actionData;
  const dataId = isObject(data) && typeof data["id"] === "string" ? data["id"] : null;
  return { renderSessionId: args.sessionId, actionId: args.actionId, dataId };
}

/**
 * The doorbell's structured mirror — `content[0]._meta["ai.ggui/userAction"]`
 * on the `ui/message` params — reduced to the two ids the host joins on, or
 * `null` when the first content block carries none. ggui's runtime writes the
 * mirror on the FIRST block only; nothing else is searched.
 */
export function readUserActionMeta(
  params: { readonly [key: string]: unknown },
): Pick<GguiUserActionMeta, "actionId" | "sessionId"> | null {
  const content = params["content"];
  if (!Array.isArray(content)) return null;
  const first: unknown = content[0];
  if (!isObject(first) || !isObject(first["_meta"])) return null;
  const meta = first["_meta"]["ai.ggui/userAction"];
  if (!isObject(meta) || meta["kind"] !== "user-action") return null;
  const actionId = meta["actionId"];
  const sessionId = meta["sessionId"];
  if (typeof actionId !== "string" || actionId === "" || typeof sessionId !== "string" || sessionId === "") return null;
  return { actionId, sessionId };
}

/**
 * What the card's runtime will do with a relay result:
 *
 *  - `"enqueued"` — the gesture is on the render's pipe and no live consumer is
 *    confirmed, so the runtime rings the doorbell;
 *  - `"consumed-live"` — a live `ggui_consume` confirmed it drains the pipe; no
 *    doorbell, no user row;
 *  - `"not-enqueued"` — the gesture is not on any pipe; no doorbell.
 *
 * A MIRROR of `@ggui-ai/iframe-runtime` 0.25's classifier
 * (`classifySubmitActionResponse` + `extractConsumerPresent` over its shared
 * three-tier unwrap): `structuredContent`, else the first content block's text
 * parsed as a JSON object, else the bare result. `ok === true` is success, and
 * success rings unless `consumerPresent === true`. The bare tier carries no
 * payload fields on this host: a relay result is re-narrowed to `content`,
 * `isError` and `structuredContent` before the card sees it (`action.ts`). The
 * mirror is a coupling to the runtime's internals; it goes when ggui exports the
 * classifier.
 */
export function submitActionOutcome(result: McpToolCallResult): "enqueued" | "consumed-live" | "not-enqueued" {
  const payload = submitResultPayload(result);
  if (payload === null || payload["ok"] !== true) return "not-enqueued";
  return payload["consumerPresent"] === true ? "consumed-live" : "enqueued";
}

function submitResultPayload(result: McpToolCallResult): { readonly [key: string]: unknown } | null {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const first = result.content[0];
  if (first !== undefined && first.type === "text") {
    const parsed = parsedJsonObject(first.text);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** The text parsed as a JSON object, or `null` when it is not one (the runtime then falls through to its bare tier). */
function parsedJsonObject(text: string): { readonly [key: string]: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isObject(parsed) ? parsed : null;
}

/** A mounted card's own props, keyed by the render session its document names (see `mountedCardProps`). */
export interface MountedCardProps {
  sessionId: string;
  props: CardProps;
}

export interface ResolveTapLabelInput {
  /** The relayed `tools/call`. */
  request: UiActionRequest;
  /** The host's live fold, flattened to its parts in transcript order. */
  parts: readonly PaintPart[];
  /**
   * The render session the HOST bound this mount to, when it owns one (the
   * widget's persisted locator does). A tap naming another session resolves
   * to `null`: the same session the runtime's action door binds.
   */
  boundSessionId?: string;
  /**
   * The props a mounted card's own document carries, by session: the base for
   * a card whose paints are not in the live fold (every card painted before a
   * reload). Its repaints in the fold still layer on top.
   */
  mountedFor?: (renderSessionId: string) => MountedCardProps | undefined;
}

/**
 * The words a tap shows as the visitor's turn: the tapped quick reply's label,
 * normalized by `tapText`, from the latest paint of the tap's session the host
 * holds — or `null` when it has none (not a quick reply, no paint in hand, a
 * session mismatch, or a label the normalizer refuses). The host-held props
 * label is the only source today; a card-reported visible text, when ggui
 * sends one, is used only where the props have no label.
 */
export function resolveTapLabel(input: ResolveTapLabelInput): string | null {
  const tap = readSubmitActionTap(input.request);
  if (tap === null || tap.dataId === null) return null;
  if (input.boundSessionId !== undefined && input.boundSessionId !== tap.renderSessionId) return null;
  const mounted = input.mountedFor?.(tap.renderSessionId);
  const base = mounted !== undefined && mounted.sessionId === tap.renderSessionId ? mounted.props : undefined;
  const paint = latestPaintProps(input.parts, tap.renderSessionId, base);
  const label = quickReplyLabel(paint?.props, tap.dataId);
  return label === null ? null : tapText(label);
}
