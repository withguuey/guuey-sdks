/**
 * Protocol-free subpath (`@guuey/mcp-apps-host/narrowing`): ONLY the
 * recognition/narrowing helpers, so lean consumers (e.g. `@guuey/threads`'
 * persistence projection) never pull `@ggui-ai/protocol` into their runtime
 * graph through the barrel (which re-exports the ggui render arm until its
 * retirement — conformance-map step 4).
 */
export {
  asResourcePayload,
  asUiResource,
  blockUiResource,
  isJsonObject,
  resourceHtml,
  scanProviderRawForUiResource,
  snapshotUiResource,
  toolResultLocator,
  toolResultUiResource,
  uiLocator,
  type McpUiResourcePayload,
} from "./block-ui.js";
