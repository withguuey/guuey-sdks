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
