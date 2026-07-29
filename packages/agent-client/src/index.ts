export {
  parseSseEvents,
  extractAssistantText,
  reduceAssistantText,
  stringField,
  parseConsentRequest,
  parseLinkRequest,
  type ParsedSseEvent,
} from "./sse";
export { dismissLinkPrompt } from "./link-prompt";
export {
  createWebAdapters,
  localStorageThreadStore,
  webGenerateId,
  fetchStreamTransport,
  AgentResponseError,
  type CreateWebAdaptersOptions,
} from "./web-adapters";
export {
  fetchThreadHistory,
  threadHistoryRowsToMessages,
  threadHistoryRowsToCards,
  HistoryUnauthorizedError,
  type ThreadHistoryRow,
  type ThreadHistoryFetchOptions,
} from "./history";
export { ingestMessageFrame } from "./blocks";
// Pure block-walk / resource-narrowing helpers for a block-preserving renderer
// (shared by Studio's `AgentBlocks` and Portal-web's agent chat). React-free.
export {
  asResourcePayload,
  asUiResource,
  blockUiResource,
  cardUiResource,
  isJsonObject,
  resourceHtml,
  scanProviderRawForUiResource,
  sortHistoryCards,
  toolNameFor,
  toolResultUiResource,
  type McpUiResourcePayload,
} from "./block-ui";
// The ggui render channel (`uiData.resourceUri` + the `_meta["ai.ggui/render"]`
// bootstrap) and the dispatcher that mounts EITHER channel through the same
// second-origin sandbox path.
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
} from "./ggui-render";
export { cardCardResource, toolResultCardResource } from "./card-mount";
// The block-preserving fold: the pinned `Reducer` plus `_meta` carriage onto
// `tool-result` blocks (which the reducer drops, and generative UI needs).
export { BlockFold, withToolResultMeta } from "./fold";
// Re-export the AgJSON types the block-preserving transcript surfaces, so
// consumers can name `reduceResult` / block types without a direct
// `@silverprotocol/core` import.
export type { AgEvent, AgReduceResult, AgMessage, AgBlock } from "@silverprotocol/core";
export type {
  AgentMessage,
  HistoryCard,
  ProfileConsentRequest,
  ProfileLinkRequest,
  ThreadIdStore,
  GenerateId,
  InvokeRequest,
  InvokeTransport,
  AgentInvokeAdapters,
  AgentInvokeHistoryAdapter,
  HistoryLoadResult,
  UseAgentInvokeOptions,
  UseAgentInvokeReturn,
} from "./types";
