/**
 * The ONE paint reducer (guuey#2031): which props a ggui card's render session
 * paints last, read off a flat list of tool parts in transcript order.
 *
 * Two readers need this, and they must agree: the host, which labels a tap on
 * the card the visitor sees (the live fold's blocks), and the runtime, which
 * tells the model which quick reply was chosen (the thread's stored parts).
 * Both hand this function the same shape: the fold's typed AgJSON blocks and a
 * stored message's parts are one block shape (the store persists the fold's
 * messages as rows), so one derivation serves both. {@link paintPartsOfStored}
 * is the stored side's narrower.
 *
 * The rule, in order over the parts:
 *
 *  - a `*ggui_render` call whose OK result names the session (`uiData` or
 *    `structuredContent` `sessionId`) opens it with its input's `props`;
 *  - a `*ggui_amend` or `*ggui_update` call whose `input.sessionId` is the
 *    session repaints it: `kind:'replace'` sets `props`, `kind:'merge'` merges
 *    `patch` over the props so far (shallow; a patch without `quickReplies`
 *    keeps the earlier list);
 *  - a call whose result did not complete ok (an MCP `isError`, or any
 *    `outcome` other than `ok`) painted nothing and is skipped.
 *
 * With a `base` (the props a mounted card's own document carries — see
 * `mountedCardProps`), the base is the card and only the repaints layer on top:
 * the render's input is older than the document the card paints from.
 *
 * Protocol-free: this module rides the `./narrowing` subpath.
 */

/**
 * One tool part, as the fold's blocks and a stored message's parts both carry
 * it. Every member but `type` is read, never trusted: a stored part is JSON off
 * a row, and the fold's `AgBlock` members are assignable here as they are.
 */
export interface PaintPart {
  readonly type: string;
  readonly toolCallId?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly uiData?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: unknown;
  readonly outcome?: unknown;
}

/**
 * A card's props as a paint carries them: the component's own JSON object,
 * open by contract (the tenant's component declares it), its members unknown
 * until checked. The one member this package reads is `quickReplies`.
 */
export type CardProps = { readonly [key: string]: unknown };

/** How the latest paint reached the card. `null`: the base alone (no repaint of it in the parts). */
export type CardPaint = "render" | "amend" | "update";

export interface LatestPaint {
  props: CardProps;
  paint: CardPaint | null;
  /** The render call that opened the session, when the parts carry it (`null` with a base). */
  renderCallId: string | null;
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A ggui tool by its wire name: bare (`ggui_render`) or SDK-namespaced
 * (`mcp__<server>__ggui_render`). The suffix is the whole tool name, so
 * `ggui_render_blueprint` is not a render.
 */
function isGguiTool(name: unknown, tool: string): boolean {
  return typeof name === "string" && (name === tool || name.endsWith(`__${tool}`));
}

function resultFailed(part: PaintPart): boolean {
  return part.isError === true || (part.outcome !== undefined && part.outcome !== "ok");
}

function renderSessionOf(part: PaintPart): string | undefined {
  for (const data of [part.uiData, part.structuredContent]) {
    if (isObject(data) && typeof data["sessionId"] === "string") return data["sessionId"];
  }
  return undefined;
}

/**
 * The latest paint of render session `sessionId` over `parts` (transcript
 * order), or `undefined` when nothing in the parts paints it and no `base` was
 * given. See this module's header for the rule.
 */
export function latestPaintProps(
  parts: readonly PaintPart[],
  sessionId: string,
  base?: CardProps,
): LatestPaint | undefined {
  const renderCallIds = new Set<string>();
  const failedCallIds = new Set<string>();
  for (const part of parts) {
    if (part.type !== "tool-result" || typeof part.toolCallId !== "string") continue;
    if (resultFailed(part)) failedCallIds.add(part.toolCallId);
    else if (renderSessionOf(part) === sessionId) renderCallIds.add(part.toolCallId);
  }
  let props: CardProps | undefined = base;
  let paint: CardPaint | null = null;
  let renderCallId: string | null = null;
  for (const part of parts) {
    const id = part.toolCallId;
    const input = part.input;
    if (part.type !== "tool-call" || typeof id !== "string" || !isObject(input)) continue;
    if (base === undefined && renderCallIds.has(id) && isGguiTool(part.name, "ggui_render")) {
      const next = input["props"];
      if (!isObject(next)) continue;
      props = next;
      paint = "render";
      renderCallId = id;
      continue;
    }
    const repaint = isGguiTool(part.name, "ggui_amend") ? "amend" : isGguiTool(part.name, "ggui_update") ? "update" : undefined;
    if (repaint === undefined || input["sessionId"] !== sessionId || failedCallIds.has(id)) continue;
    const replaced = input["kind"] === "replace" ? input["props"] : undefined;
    const patch = input["kind"] === "merge" ? input["patch"] : undefined;
    if (isObject(replaced)) props = replaced;
    else if (isObject(patch)) props = { ...props, ...patch };
    else continue;
    paint = repaint;
  }
  return props === undefined ? undefined : { props, paint, renderCallId };
}

/**
 * The label of quick reply `id` on a card's props: the strict
 * `quickReplies[{id, label}]` convention (a well-formed entry is two strings;
 * anything else is skipped), never widened to any object carrying an id.
 * `null` when there is no such reply.
 */
export function quickReplyLabel(props: CardProps | undefined, id: string): string | null {
  const replies = props?.["quickReplies"];
  if (!Array.isArray(replies)) return null;
  for (const reply of replies) {
    if (isObject(reply) && reply["id"] === id && typeof reply["label"] === "string") return reply["label"];
  }
  return null;
}

/** A stored message's parts (`{ content: [part, …] }` on a thread row), objects only. */
export function paintPartsOfStored(content: unknown): PaintPart[] {
  if (!isObject(content)) return [];
  const parts = content["content"];
  if (!Array.isArray(parts)) return [];
  const out: PaintPart[] = [];
  for (const part of parts) {
    if (isObject(part) && typeof part["type"] === "string") out.push({ ...part, type: part["type"] });
  }
  return out;
}
