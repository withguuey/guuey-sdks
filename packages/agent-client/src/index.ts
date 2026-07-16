export {
  parseSseEvents,
  extractAssistantText,
  reduceAssistantText,
  stringField,
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
// Re-export the AgJSON types the block-preserving transcript surfaces, so
// consumers can name `reduceResult` / block types without a direct
// `@silverprotocol/core` import.
export type { AgEvent, AgReduceResult } from "@silverprotocol/core";
export type {
  AgentMessage,
  HistoryCard,
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
