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
  createUiResourceReader,
  type CreateUiResourceReaderOptions,
  type ResolvedUiResourceMount,
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
// Transcript labeling/ordering helpers (mount narrowing itself moved to
// @guuey/mcp-apps-host — the SEP-1865 Host role package; import it directly).
export { sortHistoryCards, toolNameFor } from "./history";
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
  AgentInvokeStatus,
  HistoryLoadResult,
  UseAgentInvokeOptions,
  UseAgentInvokeReturn,
} from "./types";
