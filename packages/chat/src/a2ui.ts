/**
 * `@guuey/chat/a2ui` (guuey#2366) — guuey's A2UI v0.9 subset, without the
 * transcript: the one schema, the carrier validator, the surface fold, the
 * limits and the URL policy. Pure, with no DOM and no React, for a producer
 * checking what it emits and for the planner's own `a2ui` kind.
 *
 * A carrier rides a tool result's `structuredContent` under
 * {@link A2UI_CARRIER_KEY}: `{ format?: "a2ui", version: "v0.9", messages }`.
 */
export { A2UI_CARRIER_KEY, A2UI_CARRIER_MAX_UNITS, a2uiCarrierUnits } from "@guuey/mcp-apps-host/narrowing";
export {
  foldA2uiCarrier,
  parseA2uiCarrier,
  validateA2uiCarrier,
  type A2uiEnvelopeResult,
  type A2uiFoldResult,
  type A2uiValidation,
} from "./a2ui/validate.js";
export {
  EMPTY_A2UI_STATE,
  readA2uiModel,
  type A2uiFoldState,
  type A2uiResolvedSurface,
  type A2uiSurfaceOutcome,
} from "./a2ui/fold.js";
export { A2UI_LIMITS } from "./a2ui/limits.js";
export {
  a2uiImageDisplay,
  DEFAULT_A2UI_MEDIA_POLICY,
  httpsLink,
  isPolicyAImageSrc,
  type A2uiImageDisplay,
  type A2uiLink,
  type A2uiMediaPolicy,
} from "./a2ui/url-policy.js";
export {
  A2UI_CARVE_OUTS,
  A2UI_COMPONENT_FAULTS,
  A2UI_COMPONENT_NAMES,
  A2UI_ENVELOPE_FAULTS,
  A2UI_GAP_TOKENS,
  A2UI_GUUEY_CATALOG_ID,
  A2UI_ID_PATTERN,
  A2UI_INPUT_COMPONENTS,
  A2UI_MESSAGE_KEYS,
  A2UI_TEXT_VARIANTS,
  A2UI_VERSION,
  A2uiAction,
  isA2uiCarveOut,
  isA2uiComponentName,
  readA2uiDataPath,
  type A2uiBound,
  type A2uiCarveOut,
  type A2uiComponentFault,
  type A2uiComponentName,
  type A2uiDegradeCounts,
  type A2uiEnvelopeFault,
  type A2uiFieldSpec,
  type A2uiInvalidReason,
  type A2uiJsonObject,
  type A2uiNode,
  type A2uiPathBinding,
} from "./a2ui/schema.js";
