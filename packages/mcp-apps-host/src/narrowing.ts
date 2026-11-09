/**
 * Protocol-free subpath (`@guuey/mcp-apps-host/narrowing`): ONLY the
 * recognition/narrowing helpers, so lean consumers (e.g. `@guuey/threads`'
 * persistence projection) never pull `@ggui-ai/protocol` into their runtime
 * graph through the barrel (which re-exports the ggui render arm until its
 * retirement — conformance-map step 4).
 *
 * guuey#2031 adds the two protocol-free halves of the card-tap contract that a
 * persistence side reads: the tap-label contract and the one paint reducer.
 * Nothing that imports `@ggui-ai/protocol` at runtime (the tap reader, a
 * mounted shell's props) is reachable from here.
 *
 * guuey#2366 adds the A2UI carrier reader (marker extraction and the byte
 * bound only), so the planner and any persistence side read one rule.
 */
export {
  asResourcePayload,
  asUiResource,
  blockUiResource,
  isJsonObject,
  resourceHtml,
  snapshotUiResource,
  toolResultLocator,
  toolResultMountSource,
  toolResultUiResource,
  uiLocator,
  type McpUiResourcePayload,
} from "./block-ui.js";
export {
  isViewDirectiveText,
  MAX_TAP_LABEL_UNITS,
  MAX_TAP_LABELS,
  MAX_TAP_LABELS_BYTES,
  MAX_TAP_LABELS_READ,
  readTapLabels,
  tapText,
  writeTapLabels,
  type TapLabels,
} from "./tap-labels.js";
export {
  A2UI_CARRIER_KEY,
  A2UI_CARRIER_MAX_UNITS,
  a2uiCarrierUnits,
  readA2uiCarrier,
  type A2uiCarrierBlock,
  type A2uiCarrierRead,
  type A2uiCarrierSource,
} from "./a2ui-carrier.js";
export {
  latestPaintProps,
  paintPartsOfStored,
  QUICK_REPLY_INTENT,
  quickReplyLabel,
  type CardPaint,
  type CardProps,
  type LatestPaint,
  type PaintPart,
} from "./paint-props.js";
