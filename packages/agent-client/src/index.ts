export {
  parseSseEvents,
  extractAssistantText,
  reduceAssistantText,
  stringField,
  parseLinkRequest,
  type ParsedSseEvent,
} from "./sse.js";
export { dismissLinkPrompt } from "./link-prompt.js";
// One agent turn as a pure async generator — the wire walk `useAgentInvoke`
// wraps, for hosts that drive their own turn state machine (guuey#186 G5).
export { invokeTurn, toInvokeUrl, type InvokeTurnEvent } from "./invoke-turn.js";
export {
  createHitlAnswerRelay,
  type CreateHitlAnswerRelayOptions,
  type HitlAnswerRelayResult,
  createUiActionRelay,
  type CreateUiActionRelayOptions,
  createUiResourceReader,
  type CreateUiResourceReaderOptions,
  createWebAdapters,
  deleteThread,
  type DeleteThreadOptions,
  type DeleteThreadResult,
  localStorageThreadStore,
  webGenerateId,
  type CreateWebAdaptersOptions,
} from "./web-adapters.js";
// The invoke transport + guest-identity wire pieces, in their own
// mcp-apps-host-free module. Consumers that want ONLY this graph (no
// host-role card layer riding along) import `@guuey/agent-client/transport`
// instead of the barrel — see that module's docblock (guuey#186 G2).
export {
  fetchStreamTransport,
  sendableGuestSecret,
  GUEST_HEADER,
  withActivityObserver,
  type FetchStreamTransportOptions,
} from "./transport.js";
// The invoke-refusal retry wrappers, transport-agnostic: a host that brings
// its own `fetch` (Portal's React-Native transport) wraps them to wear the
// same semantics as the web transport instead of hand-rolling second copies.
// `parseRetryAfterSeconds` ships with them because filling
// `AgentResponseError.retryAfterSeconds` the same way is what makes the
// wrappers honour the pod's hint.
export {
  withSaturationRetry,
  withColdStartRetry,
  parseRetryAfterSeconds,
  type SaturationRetryOptions,
  type ColdStartRetryOptions,
} from "./saturation-retry.js";
export { AgentResponseError } from "./errors.js";
// The pod's wire-code vocabulary, mirrored — branch on these instead of
// re-typing the string literals (see the module docblock for the sync guard).
export {
  AGENT_ERROR_CODES,
  type AgentErrorCode,
  CLIENT_ERROR_CODES,
  type ClientErrorCode,
} from "./error-codes.js";
export {
  fetchThreadHistory,
  threadHistoryRowsToMessages,
  threadHistoryRowsToCards,
  HistoryUnauthorizedError,
  type ThreadHistoryRow,
  type ThreadHistoryFetchOptions,
} from "./history.js";
export { ingestMessageFrame } from "./blocks.js";
// Pure block-walk / resource-narrowing helpers for a block-preserving renderer
// (shared by Studio's `AgentBlocks` and Portal-web's agent chat). React-free.
// Transcript labeling/ordering helpers (mount narrowing itself moved to
// @guuey/mcp-apps-host — the SEP-1865 Host role package; import it directly).
export { sortHistoryCards, toolNameFor } from "./history.js";
// Re-export the AgJSON types the block-preserving transcript surfaces, so
// consumers can name `reduceResult` / block types without a direct
// `@silverprotocol/core` import — and the `Reducer` CLASS beside them, so a
// host folding `invokeTurn`'s agEvents outside the hook builds its transcript
// on the same terms (the types alone forced the direct dep back, guuey#186 G4).
export { Reducer } from "@silverprotocol/core";
export type {
  AgEvent,
  AgReduceResult,
  AgMessage,
  AgBlock,
  // The client→pod capability advertisement + the HITL answer the relay
  // delivers (guuey#207) — re-exported so a host names them without a direct
  // `@silverprotocol/core` import.
  AgClientCapabilities,
  AgHitlAnswer,
} from "@silverprotocol/core";
export type {
  AgentMessage,
  HistoryCard,
  ProfileLinkRequest,
  ThreadIdStore,
  GenerateId,
  InvokeRequest,
  InvokeTransport,
  AgentInvokeAdapters,
  AgentInvokeHistoryAdapter,
  AgentInvokeStatus,
  HistoryLoadResult,
  StallRecoveryOptions,
  UseAgentInvokeOptions,
  UseAgentInvokeReturn,
} from "./types.js";
