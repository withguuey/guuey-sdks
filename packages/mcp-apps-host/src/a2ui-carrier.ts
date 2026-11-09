/**
 * The guuey A2UI carrier reader (guuey#2366, spec §4): a tool result whose
 * `structuredContent` holds one namespaced key, `"com.guuey/a2ui"`, carries a
 * native A2UI surface envelope.
 *
 * This is marker extraction and the byte bound ONLY. The schema, the limits
 * and the surface fold live in `@guuey/chat/a2ui`, which judges whatever this
 * returns. It is protocol-free, so the persistence side, the history mapper
 * and the planner all read the one rule.
 *
 * Why this carrier is safe on an old client: it is not a `uiData` MCP-UI
 * resource and not a `ui://` locator, so `toolResultViewMount` returns nothing
 * and an old planner draws its data result (a bounded JSON preview), never
 * HTML. A server that stamps `_meta.ui` moves `structuredContent` to `uiData`;
 * a plain-object `uiData` holding the marker is read too, and it cannot mount
 * either (it has no `uri` and no `text`).
 */
import type { JsonValue } from "@silverprotocol/core";
import { isJsonObject } from "./block-ui.js";
import { summaryText } from "./tap-labels.js";

/** The namespaced marker key (the store's `com.guuey/` marker convention). */
export const A2UI_CARRIER_KEY = "com.guuey/a2ui";

/**
 * The carrier bound, in UTF-16 code units of its `JSON.stringify` text: the
 * planner's giant-result threshold, so live, history and limit checks agree.
 */
export const A2UI_CARRIER_MAX_UNITS = 16_384;

/** Where the marker was found. */
export type A2uiCarrierSource = "structuredContent" | "uiData";

/** What a tool result carries under the marker. */
export type A2uiCarrierRead =
  /** The marker's value, unjudged, within the bound. */
  | { kind: "carrier"; carrier: JsonValue; via: A2uiCarrierSource; units: number }
  /**
   * The marker is there but its value is over the bound: an envelope fault.
   * The value is handed on only so a reader can name the surfaces it targets
   * (a bounded scan, `@guuey/chat/a2ui`'s `namedA2uiSurfaceIds`); it is never
   * judged or drawn.
   */
  | { kind: "oversize"; carrier: JsonValue; via: A2uiCarrierSource; units: number };

/** The size of a JSON value in UTF-16 code units of its `JSON.stringify` text. */
export function a2uiCarrierUnits(value: JsonValue): number {
  return JSON.stringify(value).length;
}

/** The fields of a `tool-result` block the reader looks at. */
export interface A2uiCarrierBlock {
  structuredContent?: JsonValue;
  uiData?: JsonValue;
}

function readFrom(container: JsonValue | undefined, via: A2uiCarrierSource): A2uiCarrierRead | undefined {
  if (!isJsonObject(container) || !Object.hasOwn(container, A2UI_CARRIER_KEY)) return undefined;
  const carrier = container[A2UI_CARRIER_KEY];
  if (carrier === undefined) return undefined;
  const units = a2uiCarrierUnits(carrier);
  return { kind: units > A2UI_CARRIER_MAX_UNITS ? "oversize" : "carrier", carrier, via, units };
}

/**
 * The A2UI carrier a tool result holds, or `undefined` when it holds none.
 * `structuredContent` is read first; a plain-object `uiData` holding the
 * marker is the fallback (spec §4.2).
 */
export function readA2uiCarrier(block: A2uiCarrierBlock): A2uiCarrierRead | undefined {
  return readFrom(block.structuredContent, "structuredContent") ?? readFrom(block.uiData, "uiData");
}

// ─── The action text form (guuey#2384, spec §9.3) ───────────────────────────

/**
 * The resolved action payload's bound, in UTF-16 code units of its escaped
 * JSON line ({@link a2uiActionPayload}): over it the send is refused.
 */
export const A2UI_ACTION_PAYLOAD_MAX_UNITS = 4_096;

/** The tag line's attribute charset: the id charset the carrier validator enforces on every agent-chosen id. */
const ACTION_ATTR = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The opening line, its attributes in the writer's one order, alone on its line. */
const ACTION_OPEN_LINE =
  /^<guuey_a2ui_action surface="([A-Za-z0-9_.:-]{1,64})" action="([A-Za-z0-9_.:-]{1,64})" source="([A-Za-z0-9_.:-]{1,64})" id="([A-Za-z0-9_.:-]{1,64})">$/;

/** The closing line. */
const ACTION_CLOSE_LINE = "</guuey_a2ui_action>";

/**
 * A pressed A2UI action, resolved (spec §5.5): the surface, the action's name,
 * the button that sent it, the turn's `clientMessageId`, and the action's
 * `context` with every `{path}` read from the surface's data model.
 */
export interface A2uiActionRecord {
  surfaceId: string;
  name: string;
  sourceComponentId: string;
  actionId: string;
  context: { [key: string]: JsonValue };
}

/** The words of the human line: the button's label, then each submitted field's label and value. */
export interface A2uiActionSummary {
  label: string;
  pairs: ReadonlyArray<{ label: string; value: string }>;
}

/** An action turn read back: the record and its human line. */
export interface A2uiActionText extends A2uiActionRecord {
  summary: string;
}

/** `<`, `>`, `&`, U+2028 and U+2029 as JSON escapes: the payload line then holds no character that could close or forge the block. */
function escapeLine(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The action's payload line: its `context` as one line of JSON, escaped. Its
 * length is what {@link A2UI_ACTION_PAYLOAD_MAX_UNITS} bounds.
 */
export function a2uiActionPayload(context: { [key: string]: JsonValue }): string {
  return escapeLine(JSON.stringify(context));
}

/**
 * THE writer of an A2UI action turn's text (spec §9.3): line 1 is the human
 * summary (the button's label, then `Field label = value` pairs, each part
 * through `summaryText`), then the block: the opening tag alone on its line,
 * the payload line, the closing tag alone on its line. `undefined` (never a
 * throw) when an attribute is outside the id charset, the label reads as no
 * words, or the payload is over its bound: nothing agent-chosen reaches the
 * tag line unconstrained.
 */
export function writeA2uiActionText(record: A2uiActionRecord, summary: A2uiActionSummary): string | undefined {
  const label = summaryText(summary.label);
  if (label === null) return undefined;
  const pairs: string[] = [];
  for (const pair of summary.pairs) {
    const name = summaryText(pair.label);
    const value = summaryText(pair.value);
    if (name !== null && value !== null) pairs.push(`${name} = ${value}`);
  }
  return actionText(record, pairs.length > 0 ? `${label}: ${pairs.join("; ")}` : label);
}

/**
 * An action turn's text written again under another id (guuey#2384): a
 * retried turn carries a new `clientMessageId`, and the block's `id` must
 * name it. The same record and human line, through the same block writer;
 * `undefined` when `text` is not the action form or the id is outside the
 * charset.
 */
export function reissueA2uiActionText(text: string, actionId: string): string | undefined {
  const turn = parseA2uiActionText(text);
  return turn === undefined ? undefined : actionText({ ...turn, actionId }, turn.summary);
}

/** The text form itself, under a written human line: the one place the block is put together. */
function actionText(record: A2uiActionRecord, line: string): string | undefined {
  const attrs = [record.surfaceId, record.name, record.sourceComponentId, record.actionId];
  if (!attrs.every((a) => ACTION_ATTR.test(a))) return undefined;
  const payload = a2uiActionPayload(record.context);
  if (payload.length > A2UI_ACTION_PAYLOAD_MAX_UNITS) return undefined;
  return [
    line,
    `<guuey_a2ui_action surface="${record.surfaceId}" action="${record.name}" source="${record.sourceComponentId}" id="${record.actionId}">`,
    payload,
    ACTION_CLOSE_LINE,
  ].join("\n");
}

/**
 * THE reader of an A2UI action turn's text, anchored to the writer's own form
 * in one pass over its lines: exactly four lines (a line's surrounding
 * whitespace, a CRLF join's `\r` included, is not part of the form): a
 * non-empty human line, the opening tag with its four attributes in order,
 * one JSON object, the closing tag. Anything else (an inline tag, an unclosed
 * or reordered block, more prose around it) is `undefined`. Read on USER rows
 * only: an agent that echoes the block draws as its own text.
 */
export function parseA2uiActionText(text: string): A2uiActionText | undefined {
  if (!text.includes(ACTION_CLOSE_LINE)) return undefined;
  const lines = text.trim().split("\n");
  if (lines.length !== 4) return undefined;
  const [summary, open, json, close] = lines.map((line) => line.trim());
  if (summary === undefined || summary === "" || close !== ACTION_CLOSE_LINE || json === undefined || !json.startsWith("{")) {
    return undefined;
  }
  const tag = ACTION_OPEN_LINE.exec(open ?? "");
  if (tag === null) return undefined;
  const [, surfaceId = "", name = "", sourceComponentId = "", actionId = ""] = tag;
  let context: JsonValue;
  try {
    context = JSON.parse(json);
  } catch {
    // Not JSON: the row is not the form (it draws as the user's own text).
    return undefined;
  }
  if (!isJsonObject(context)) return undefined;
  return { surfaceId, name, sourceComponentId, actionId, context, summary };
}
