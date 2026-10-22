/**
 * @guuey/threads — universal session/thread persistence for AgJSON agents
 * (guuey#107).
 *
 * The pieces:
 *   - {@link ThreadStore} — the storage-agnostic logic: thread resolution,
 *     atomic sequencing, idempotency, turn-level fold persistence
 *     (messages + card rows + snapshot), prompt-lane history.
 *   - {@link ThreadPersistencePort} — the narrow surface a binding
 *     implements. `InMemoryThreadPersistence` ships here; guuey's hosted
 *     runtime binds DynamoDB; `HttpThreadPersistence` points an ejected
 *     agent at guuey's hosted thread API with an end-user token ("eject
 *     the code, keep your memory"); or bring your own store.
 *   - fold↔row mapping — `agMessageToRow`/`reassembleFold`/friends, the
 *     byte-identity persistence of an `AgReduceResult`, including the
 *     UI-card projection (`uiCardArtifactsFromMessages`, guuey#86).
 *   - `@guuey/threads/testing` — the port contract suite: run it against
 *     your binding for the same guarantees the hosted one carries.
 */
export type {
  HandoffEvent,
  ReportEvent,
  SealInterval,
  StoredHistoryMessage,
  ThreadMessageEvent,
  ThreadMessageKind,
  ThreadMessageRole,
  RowBudget,
  ThreadClosure,
  ThreadMessageRow,
  ThreadPersistencePort,
  ThreadRow,
  ThreadSnapshotRow,
  TurnOrigin,
  ClientClass,
  ThreadInputKind,
} from "./rows.js";
export { THREAD_INPUT_KINDS } from "./rows.js";
export {
  DYNAMODB_ITEM_LIMIT_BYTES,
  DYNAMODB_ROW_BUDGET,
  DYNAMODB_ROW_BUDGET_BYTES,
  dynamoItemBytes,
  dynamoNumberFits,
} from "./item-size.js";
export {
  ThreadStore,
  STORED_TURN_TOO_LARGE_CODE,
  STORED_TURN_UNSTORABLE_NUMBER_CODE,
  type AppendFoldInput,
  type AppendFoldUnstorable,
  type AppendFoldResult,
  type ElidedToolInput,
  type AppendMessageInput,
  type AppendMessageResult,
  type EnsureThreadInput,
} from "./store.js";
export { InMemoryThreadPersistence } from "./in-memory.js";
export { ThreadClosedError, threadClosure } from "./closed.js";
export {
  hasSealedPart,
  isSeqSealed,
  previewDigest,
  readableThreadPreview,
  readSealState,
  threadSealState,
  type StoredPreviewSlice,
  type ThreadSealState,
} from "./seal.js";
export {
  AGENT_ERROR_ROW_SUFFIX,
  classifyStoredRow,
  type ClassifiedRowInput,
  isBlankBlock,
  isInformationless,
  type StoredRowClass,
} from "./stored-row.js";
export {
  HttpThreadPersistence,
  HttpThreadStoreError,
  type HttpThreadPersistenceOptions,
  type ThreadScope,
} from "./http.js";
export {
  planSnapshot,
  type PlanSnapshotInput,
  type PlannedSnapshot,
  type SnapshotRefusal,
  type SnapshotRefusalReason,
} from "./snapshot-plan.js";
export {
  agArtifactToCardRow,
  agMessageToBoundedRow,
  agMessageToRow,
  assertRowFits,
  cardUiDataByCallId,
  type CardUiData,
  type CardUiDataByCallId,
  ELIDED_VALUE_KEY,
  isStoredRowRefusal,
  StoredRowTooLargeError,
  StoredRowUnstorableNumberError,
  type ElidedField,
  type ElisionReason,
  type RefusedRowKind,
  type StoredElision,
  type StoredRowRefusal,
  cardRowToAgArtifact,
  messageFullText,
  messageNarration,
  messageText,
  producingToolName,
  storedTextParts,
  type StoredRowText,
  type StoredTextParts,
  joinStoredThreadMemory,
  reassembleFold,
  rowToAgMessage,
  seedEventsForReducer,
  splitStoredThreadMemory,
  toolNamesByCallId,
  uiCardArtifactsFromMessages,
  type RowCtx,
} from "./fold-rows.js";
// guuey#2031 — the card-tap contract, re-exported for the persistence side (the
// runtime stamps a user row's tap labels; the read plane forwards them) so a
// server imports it from the package it already uses. The names live in
// `@guuey/mcp-apps-host`'s protocol-free subpath: the writer and the reader of a
// row's `tapLabels`, the one directive predicate, and the one paint reducer the
// runtime reads a tapped card with, with the quick-reply intent it labels under.
export {
  isViewDirectiveText,
  latestPaintProps,
  paintPartsOfStored,
  QUICK_REPLY_INTENT,
  quickReplyLabel,
  readTapLabels,
  writeTapLabels,
  type CardPaint,
  type CardProps,
  type LatestPaint,
  type PaintPart,
  type TapLabels,
} from "@guuey/mcp-apps-host/narrowing";
