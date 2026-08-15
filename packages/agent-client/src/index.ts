export {
  parseSseEvents,
  extractAssistantText,
  reduceAssistantText,
  stringField,
  parseConsentRequest,
  parseLinkRequest,
  type ParsedSseEvent,
} from "./sse.js";
export { dismissLinkPrompt } from "./link-prompt.js";
// One agent turn as a pure async generator — the wire walk `useAgentInvoke`
// wraps, for hosts that drive their own turn state machine (guuey#186 G5).
export { invokeTurn, toInvokeUrl, type InvokeTurnEvent } from "./invoke-turn.js";
export {
  createUiActionRelay,
  type CreateUiActionRelayOptions,
  createUiResourceReader,
  type CreateUiResourceReaderOptions,
  createWebAdapters,
  localStorageThreadStore,
  webGenerateId,
  type CreateWebAdaptersOptions,
} from "./web-adapters.js";
// The invoke transport + guest-identity wire pieces, in their own
// mcp-apps-host-free module. Consumers that want ONLY this graph (no
// host-role card layer riding along) import `@guuey/agent-client/transport`
// instead of the barrel — see that module's docblock (guuey#186 G2).
export { fetchStreamTransport, sendableGuestSecret, GUEST_HEADER } from "./transport.js";
// The `POD_SATURATED` single-retry wrapper, transport-agnostic: a host that
// brings its own `fetch` (Portal's React-Native transport) wraps it to wear the
// same semantics as the web transport instead of hand-rolling a second copy.
// `parseRetryAfterSeconds` ships with it because filling
// `AgentResponseError.retryAfterSeconds` the same way is what makes the wrapper
// honour the pod's hint.
export {
  withSaturationRetry,
  parseRetryAfterSeconds,
  type SaturationRetryOptions,
} from "./saturation-retry.js";
export { AgentResponseError } from "./errors.js";
// The pod's wire-code vocabulary, mirrored — branch on these instead of
// re-typing the string literals (see the module docblock for the sync guard).
export { AGENT_ERROR_CODES, type AgentErrorCode } from "./error-codes.js";
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
} from "./types.js";
