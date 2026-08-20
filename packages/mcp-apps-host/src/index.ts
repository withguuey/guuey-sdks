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
  toolResultLocator,
  toolResultUiResource,
  uiLocator,
  type McpUiResourcePayload,
} from "./block-ui.js";
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
  declaredResourceCsp,
  uiResourceChannel,
  type CreateMcpUiResourceReaderDeps,
  type McpResourceReadResult,
} from "./reader.js";
// The spec's own per-resource CSP type (SEP-1865 `_meta.ui.csp`) — the
// shape of `ResolvedViewMount.csp` (guuey#312); identical to
// `ViewCspOrigins`, re-exported under its spec name for mount consumers.
export type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";
export {
  asToolCallResult,
  createMcpUiActionRelay,
  unavailableToolCallResult,
  UI_ACTION_TOOLS,
  UI_ACTION_UNAVAILABLE_TEXT,
  UI_SEMANTIC_ACTION_TOOLS,
  type CreateMcpUiActionRelayDeps,
  type McpToolCallContent,
  type McpToolCallResult,
  type McpToolStructuredContent,
  type UiActionRequest,
} from "./action.js";
export {
  initializeResult,
  initialViewHostState,
  resourceReadResponse,
  RESOURCES_READ_METHOD,
  teardownMessage,
  toolCallResponse,
  TOOLS_CALL_METHOD,
  viewHostElapsed,
  viewHostReceive,
  diagnoseCspViolation,
  type CspViolationLike,
  type ViewCspDiagnosis,
  type ViewCspOrigins,
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
  type ViewCspEvents,
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
