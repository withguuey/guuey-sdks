export {
  parseSseEvents,
  extractAssistantText,
  reduceAssistantText,
  stringField,
  parseConsentRequest,
  type ParsedSseEvent,
} from "./sse";
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
// Re-export the AgJSON types the block-preserving transcript surfaces, so
// consumers can name `reduceResult` / block types without a direct
// `@silverprotocol/core` import.
export type { AgEvent, AgReduceResult, AgMessage, AgBlock } from "@silverprotocol/core";
export type {
  AgentMessage,
  HistoryCard,
  ProfileConsentRequest,
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
