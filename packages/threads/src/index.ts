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
  StoredHistoryMessage,
  ThreadMessageKind,
  ThreadMessageRole,
  ThreadMessageRow,
  ThreadPersistencePort,
  ThreadRow,
  ThreadSnapshotRow,
} from "./rows.js";
export {
  ThreadStore,
  type AppendFoldInput,
  type AppendFoldResult,
  type AppendMessageInput,
  type AppendMessageResult,
  type EnsureThreadInput,
} from "./store.js";
export { InMemoryThreadPersistence } from "./in-memory.js";
export {
  HttpThreadPersistence,
  HttpThreadStoreError,
  type HttpThreadPersistenceOptions,
  type ThreadScope,
} from "./http.js";
export {
  agArtifactToCardRow,
  agMessageToRow,
  cardRowToAgArtifact,
  messageText,
  reassembleFold,
  rowToAgMessage,
  seedEventsForReducer,
  uiCardArtifactsFromMessages,
  type RowCtx,
} from "./fold-rows.js";
