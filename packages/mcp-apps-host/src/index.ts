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
  resolveViewMount,
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
export {
  asToolCallResult,
  createMcpUiActionRelay,
  unavailableToolCallResult,
  UI_ACTION_TOOLS,
  UI_ACTION_UNAVAILABLE_TEXT,
  type CreateMcpUiActionRelayDeps,
  type McpToolCallContent,
  type McpToolCallResult,
  type McpToolStructuredContent,
  type UiActionRequest,
} from "./action.js";
export {
  initializeResult,
  initialViewHostState,
  teardownMessage,
  toolCallResponse,
  TOOLS_CALL_METHOD,
  viewHostElapsed,
  viewHostReceive,
  type ViewHostBehavior,
  type ViewHostEffect,
  type ViewHostOutbound,
  type ViewHostPhase,
  type ViewHostInfo,
  type ViewHostState,
  type ViewHostTransition,
  type ViewRequestId,
} from "./view-host-protocol.js";
export {
  attachViewHost,
  viewDocumentHtml,
  type AttachViewHostConfig,
  type ViewFrameLike,
  type ViewHostEvents,
} from "./view-host.js";
export {
  attachSandboxPageDelivery,
  isSandboxProxyReady,
  SANDBOX_PROXY_READY_METHOD,
  SANDBOX_RESOURCE_READY_METHOD,
  type SandboxPageDeliveryConfig,
} from "./sandbox-page.js";
