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

/**
 * The human-handoff event payload (guuey#552 §3.2): the MACHINE half of a
 * `kind:'event'` handoff row — the notify Lambda's stream filter reads
 * `event.type === 'handoff'` and the fields below; the human half is the
 * row's `text`. `question` is untrusted visitor content — consumers quote,
 * truncate, and never interpolate it into anything executable.
 */
export interface HandoffEvent {
  type: "handoff";
  question: string;
  contactEmail?: string;
  contactName?: string;
}

/**
 * The typed payload on a `kind:'event'` row (guuey#552) — a discriminated
 * union on `type`, seeded with its one v1 member. Future event kinds
 * EXTEND THIS UNION (never a loose `{type: string}` bag — the union IS the
 * shared contract between the pod's fold-seam writer and every raw-DDB
 * stream reader).
 */
export type ThreadMessageEvent = HandoffEvent;

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
  /**
   * The producing tool's RAW wire name on kind='card' rows (guuey#402) —
   * resolved at fold time from the paired `tool-call` block, which is the
   * only place the name rides (the tool-RESULT block carries just the
   * `toolCallId`). Raw on purpose: humanization is the kit's #307 voice
   * layer, one owner. Absent on pre-enabler rows and when the producing
   * call is not in the fold — readers fall back, never invent.
   */
  toolName?: string;
  /** `AgTurnRecord` stored on agent-fold rows for context recovery. */
  aiContext?: unknown;
  /**
   * guuey#524 (pass-3 correction 3): the message persisted from a
   * PAGE-AWARE turn — content that may derive from untrusted host-page
   * context. Stamped by the pod's direct write at persist time, NEVER
   * client-claimed. The one-hop history-carry residual is disclosed by
   * design: these rows DO ride into later turns' conversation history;
   * this flag is what lets read-side policy see them coming. Absent on
   * every row written before the flag existed (absent == trusted-origin).
   */
  untrustedOrigin?: boolean;
  /**
   * guuey#552: the typed payload on `kind:'event'` rows (the DDB schema
   * field existed — `backend/amplify/data/threads.ts` `event: a.json()` —
   * the row types never carried it). Absent on every non-event row.
   */
  event?: ThreadMessageEvent;
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
