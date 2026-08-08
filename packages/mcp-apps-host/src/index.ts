/**
 * @guuey/mcp-apps-host — the MCP Apps (SEP-1865) Host role: view-mount
 * narrowing, ui:// locator rehydration, sandbox-trust channels. See README +
 * the conformance map (guuey#123).
 */
export {
  asResourcePayload,
  asUiResource,
  blockUiResource,
  isJsonObject,
  resourceHtml,
  scanProviderRawForUiResource,
  snapshotUiResource,
  toolResultUiResource,
  uiLocator,
  type McpUiResourcePayload,
} from "./block-ui.js";
export {
  asGguiRender,
  asGguiRenderBootstrap,
  blockGguiRender,
  gguiRenderResource,
  gguiShellHtml,
  toolResultGguiRender,
  GGUI_RENDER_META_KEY,
  type GguiRenderBootstrap,
  type GguiRenderDescriptor,
  type GguiShellHtmlOptions,
} from "./ggui-render.js";
export {
  snapshotViewMount,
  toolResultViewMount,
  type LocatorViewMount,
  type ResolvedViewMount,
  type UiResourceReader,
  type ViewMount,
  type ViewMountChannel,
} from "./card-mount.js";
export {
  createMcpUiResourceReader,
  uiResourceChannel,
  type CreateMcpUiResourceReaderDeps,
  type McpResourceReadResult,
} from "./reader.js";
