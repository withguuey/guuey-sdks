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
  UI_ACTION_WAKE_BUDGET_MS,
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
export {
  withSaturationRetry,
  withColdStartRetry,
  sendUnderWakeBudget,
  WAKE_BUDGET_MS,
  type SaturationRetryOptions,
  type ColdStartRetryOptions,
  type WakeBudgetOptions,
  type WakeWaitInfo,
  type SendUnderWakeBudgetOptions,
} from "./saturation-retry.js";
// The refusal error and the one builder of it: a host transport that brings
// its own `fetch` builds its refusals with `agentResponseErrorFrom`, so the
// status, code, Retry-After hint and waking marker read the same way the web
// transport reads them and the wrappers above see the same shape.
export {
  AgentResponseError,
  agentResponseErrorFrom,
  isWakingRefusal,
  parseRetryAfterSeconds,
  WAKE_TIMED_OUT_MESSAGE,
  WAKING_HEADER,
  WakeTimedOutError,
  RequestCancelledError,
  type RequestCancelReason,
  type RequestCancelCode,
} from "./errors.js";
// guuey#2492: the `signal` / `timeoutMs` every one-shot call accepts.
export type { OneShotRequestOptions } from "./one-shot.js";
// The pod's wire-code vocabulary, mirrored — branch on these instead of
// re-typing the string literals (see the module docblock for the sync guard).
export {
  AGENT_ERROR_CODES,
  type AgentErrorCode,
  CLIENT_ERROR_CODES,
  type ClientErrorCode,
} from "./error-codes.js";
// guuey#2549: a turn without words (`SendOptions.inputKind`): the kinds, the
// session frame's offer and the refusal reader the hook uses.
export {
  INPUT_KINDS,
  isInputKind,
  isInputKindRefusal,
  readAccepts,
  readAcceptedInputKinds,
  userInputKindOf,
  type Accepts,
  type InputKind,
} from "./input-kinds.js";
// A turn's parts (`SendOptions.parts`): the four kinds, the caps (a mirror of
// the runtime's), the one judge `send` runs, and shape 1's images-only form,
// for a host that checks a pick before sending. The suggested media types are
// a picker's hint, never a gate.
export {
  MEDIA_INBOUND_MAX_AUDIO_PARTS_PER_TURN,
  describeUserPartRefusal,
  isUserPartKind,
  MEDIA_INBOUND_MAX_IMAGES_PER_TURN,
  MEDIA_INBOUND_MAX_PARTS_PER_TURN,
  MEDIA_INBOUND_MAX_STORAGE_REFS_PER_TURN,
  MEDIA_INBOUND_PART_MAX_BASE64_CHARS,
  MEDIA_INBOUND_TURN_MAX_BASE64_CHARS,
  PART_FILE_ID_MAX_CHARS,
  PART_URL_MAX_CHARS,
  shape1AttachmentsOf,
  shape1FormOf,
  USER_PART_KINDS,
  USER_PART_SUGGESTED_MIME_TYPES,
  validateUserParts,
  type Shape1Form,
  type UserPart,
  type UserPartCandidate,
  type UserPartKind,
  type UserPartRefusal,
  type UserPartsContext,
  type UserPartsVerdict,
} from "./user-parts.js";
// The turn-context caps, judged at send the way the server counts them (its sanitiser is the authority).
export {
  describeTurnContextRefusal,
  TURN_CONTEXT_MAX_BLOCKS,
  TURN_CONTEXT_MAX_BYTES,
  validateTurnContext,
  type TurnContextRefusal,
  type TurnContextVerdict,
} from "./turn-context.js";
// The invoke body, request shape 2 (the silverprotocol `AgInput` start arm),
// and the reader of an older runtime's refusal of it (W1).
export {
  buildInvokeBodyV2,
  isRequestShapeRefusal,
  type InvokeBodyV2,
  type InvokeBodyV2Input,
} from "./invoke-body-v2.js";
// guuey#2293: the image attachments of request shape 1 — the V1 allowlist, its
// caps and its judge, for a host that checks an image pick before sending
// (`send` itself judges `SendOptions.parts` with `validateUserParts`).
export {
  IMAGE_ATTACHMENT_MIME_TYPES,
  IMAGE_ATTACHMENTS_MAX_COUNT,
  IMAGE_ATTACHMENT_MAX_BASE64_CHARS,
  IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS,
  isImageAttachmentMimeType,
  isStandardBase64,
  validateImageAttachments,
  describeImageAttachmentRefusal,
  type ImageAttachment,
  type ImageAttachmentCandidate,
  type ImageAttachmentMimeType,
  type ImageAttachmentRefusal,
  type ImageAttachmentsVerdict,
  type ImageLinkAttachment,
  type TurnAttachment,
} from "./attachments.js";
export {
  fetchThreadHistory,
  fetchThreadHistoryRows,
  threadHistoryRowsToMessages,
  threadHistoryRowsToCards,
  threadHistoryRowsToToolResults,
  threadHistoryRowsToToolCalls,
  HistoryUnauthorizedError,
  TOOL_RESULTS_INCLUDE,
  TOOL_CALLS_INCLUDE,
  type ThreadHistoryRow,
  type ThreadHistoryToolResultRow,
  type ThreadHistoryFetchOptions,
  type ThreadHistoryRowsOptions,
  type ThreadHistoryRowsResult,
} from "./history.js";
// After a guest signs in with the app's own sign-in: move the guest's
// threads in this app to the signed-in user (the BYO guest merge door).
export {
  mergeGuestThreads,
  type MergeGuestThreadsOptions,
  type MergeGuestThreadsResult,
} from "./guest-merge.js";
export { ingestMessageFrame } from "./blocks.js";
// guuey#2386: the A2UI catalog ids, spelled once (React-free).
export { A2UI_GUUEY_CATALOG_ID, JSON_RENDER_CATALOG_ID } from "./catalogs.js";
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
  HistoryToolResult,
  HistoryToolCall,
  ProfileLinkRequest,
  ThreadIdStore,
  GenerateId,
  InvokeRequest,
  InvokeTransport,
  AgentInvokeAdapters,
  AgentInvokeHistoryAdapter,
  AgentInvokeStatus,
  HistoryLoadResult,
  ThreadClosed,
  StallRecoveryOptions,
  UseAgentInvokeOptions,
  PageContext,
  SendOptions,
  TurnContextBlock,
  UseAgentInvokeReturn,
} from "./types.js";
