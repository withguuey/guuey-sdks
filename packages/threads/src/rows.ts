/**
 * Row shapes + the persistence port — the storage-agnostic half of the
 * thread contract (guuey#107, extracted from the hosted runtime's
 * thread-store so ejected/self-hosted agents share ONE session model).
 *
 * A binding implements {@link ThreadPersistencePort} against its store
 * (guuey's hosted runtime binds DynamoDB; `InMemoryThreadPersistence`
 * ships here for dev/tests) and runs the exported contract suite
 * (`@guuey/threads/testing`) so "works in-memory" and "works on the real
 * thing" are the same mechanical guarantee — the `@guuey/state` pattern.
 */
import type { AgMemoryRecord, JsonValue } from "@silverprotocol/core";

export type ThreadMessageRole = "user" | "agent" | "system";
export type ThreadMessageKind = "text" | "card" | "event";

export interface ThreadRow {
  id: string;
  userId: string;
  appId: string;
  servingRegion: string;
  title: string;
  status: string;
  pinned: boolean;
  /** Monotonic seq counter — bumped atomically on each append. */
  lastSeq: number;
  lastMessageAt: string;
  lastMessagePreview: string;
  threadMode: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMessageRow {
  threadId: string;
  seq: number;
  userId: string;
  clientMessageId: string;
  at: string;
  kind: ThreadMessageKind;
  authorRole: ThreadMessageRole;
  text?: string;
  content?: unknown;
  /** Verbatim `AgArtifact` stored on kind='card' rows. */
  cardSnapshot?: unknown;
  /** `AgTurnRecord` stored on agent-fold rows for context recovery. */
  aiContext?: unknown;
}

/** Latest-replace fold snapshot for a thread. */
export interface ThreadSnapshotRow {
  threadId: string;
  userId: string;
  /** AgReduceResult.state — opaque working blob. */
  workingState?: JsonValue;
  /** AgReduceResult.memory filtered to scope='thread'. */
  threadMemory: AgMemoryRecord[];
  lastTurnId?: string;
  updatedAt: string;
}

/** A prior message loaded for context injection — narrow projection. */
export interface StoredHistoryMessage {
  seq: number;
  authorRole: ThreadMessageRole;
  kind: ThreadMessageKind;
  text: string | null;
  content: unknown;
  at: string;
}

/**
 * The only surface {@link ThreadStore} needs from a backing store. Keep
 * implementations honest with the contract suite in
 * `@guuey/threads/testing`.
 */
export interface ThreadPersistencePort {
  /** Point-read a Thread by id; `undefined` when the row does not exist. */
  getThread(threadId: string): Promise<ThreadRow | undefined>;
  /** Put a new Thread row (conditional create — must reject an existing id). */
  createThread(row: ThreadRow): Promise<void>;
  /**
   * Atomically bump `lastSeq` (+ set `lastMessageAt`/`updatedAt`) on an
   * EXISTING Thread and return the NEW `lastSeq`. `preview: null`
   * allocates the seq WITHOUT touching `lastMessagePreview` (card rows and
   * text-less agent turns must not clobber the last real preview);
   * a string preview replaces it.
   */
  incrementSeq(threadId: string, preview: string | null, atIso: string): Promise<number>;
  /** Put a ThreadMessage row (conditional — must reject a duplicate seq). */
  putMessage(row: ThreadMessageRow): Promise<void>;
  /** Up to `limit` most-recent messages for a thread, returned seq-ASCending. */
  listRecentMessages(threadId: string, limit: number): Promise<ThreadMessageRow[]>;
  /** Existing message by (clientMessageId, threadId) for idempotency dedup. */
  findByClientMessageId(
    threadId: string,
    clientMessageId: string,
  ): Promise<ThreadMessageRow | undefined>;
  /** Point-read the thread's snapshot; undefined when none yet. */
  getSnapshot(threadId: string): Promise<ThreadSnapshotRow | undefined>;
  /** Upsert (full replace) the thread's snapshot row. */
  putSnapshot(row: ThreadSnapshotRow): Promise<void>;
}
