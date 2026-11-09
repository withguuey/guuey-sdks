/**
 * The A2UI bounds (guuey#2366, spec §6) — one table, read by the validator,
 * the surface fold and the planner.
 *
 * Units are UTF-16 code units of `JSON.stringify` text, measured once by
 * mcp-apps-host's `a2uiCarrierUnits`, so live, history and limit checks agree.
 *
 * Over an envelope bound (carrier, messages, surfaces, components, depth, data
 * path depth, action context keys) the carrier takes the old face: today's
 * tool row with a JSON preview. The drops and truncations, and the refused
 * data-model update, degrade in place only on a read-only surface; on a drawn
 * component of an interactive surface each is a component fault and the
 * surface takes the old face too (spec §5.7). On a component nothing draws
 * they are counted only. A URL over its bound is outside policy (chip or inert,
 * in place on every surface). The action payload bound is a send-time check.
 */
import { A2UI_ACTION_PAYLOAD_MAX_UNITS, A2UI_CARRIER_MAX_UNITS } from "@guuey/mcp-apps-host/narrowing";

export const A2UI_LIMITS = {
  /** Carrier JSON (the carrier reader's own bound): envelope fault. */
  carrierUnits: A2UI_CARRIER_MAX_UNITS,
  /** Messages per carrier: envelope fault. */
  messagesPerCarrier: 32,
  /** Distinct surfaces per carrier: envelope fault. */
  surfacesPerCarrier: 4,
  /** Components per surface, after replace-by-id: envelope fault. */
  componentsPerSurface: 200,
  /** Tree depth from the root (the root alone is depth 1): envelope fault. */
  treeDepth: 12,
  /** Children per Row/Column: extra children dropped (a component fault). */
  childrenPerContainer: 50,
  /** List items: extra items dropped (a component fault). */
  listItems: 100,
  /** `Text.text` (resolved): truncated with an ellipsis (a component fault). */
  textUnits: 4_000,
  /** Labels, placeholders, `alt`, `title`, option labels, confirm copy: truncated (a component fault). */
  labelUnits: 200,
  /** `ChoicePicker.options`: extra options dropped (a component fault). */
  choiceOptions: 50,
  /** A `src`, `href` or `Text` link longer than this is outside policy (chip or inert). */
  urlUnits: 2_048,
  /** A surface's data model JSON: the update is refused (a component fault). */
  dataModelUnits: 8_192,
  /** Segments in a data path: envelope fault. */
  dataPathDepth: 8,
  /** Units in one data path segment (after unescaping): envelope fault. */
  dataPathSegmentUnits: 64,
  /** Keys in one action's `context`: envelope fault. */
  actionContextKeys: 32,
  /** The resolved action payload (escaped JSON, the action text writer's own bound): the send is refused (S4, send time). */
  actionPayloadUnits: A2UI_ACTION_PAYLOAD_MAX_UNITS,
  /** `a2ui` items planned per transcript: later carriers draw the old face. */
  itemsPerTranscript: 64,
  /** The largest `TextField.maxLength` a carrier may declare. */
  textFieldMaxLength: 4_000,
  /**
   * Steps one json-render conversion may take (spec §12): every element visit
   * (hidden, dangling and repeated ones included), every `visible` term read
   * and every element the interaction check reads. Past it the carrier is
   * too large (an envelope fault). A work budget about 100× the component
   * bound: every surface the other bounds allow sits far below it, and the
   * carriers that reach it are the fan-in ones (one element referenced from
   * many places), so the conversion's work is bounded whatever it references.
   */
  jsonRenderSteps: 20_000,
  /**
   * Faults of one kind one message adds (spec §12): a json-render drop count
   * and a bad-id count are clamped to it, where the count is made and where
   * the fold reads it. A count only says that something was dropped (and
   * whether it was interactive), so any bound of 1 or more keeps its meaning;
   * 200 is the component bound, and the fold's work stays bounded.
   */
  faultsPerMessage: 200,
} as const;

/** The ellipsis a truncated string ends with (one unit). */
const ELLIPSIS = "…";

/**
 * A string cut to at most `max` UTF-16 units: unchanged when it fits, else
 * cut so the last unit is an ellipsis, never splitting a surrogate pair.
 */
export function truncateUnits(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = Math.max(0, max - ELLIPSIS.length);
  // A high surrogate at the cut would orphan its pair: cut before it.
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end) + ELLIPSIS, truncated: true };
}
