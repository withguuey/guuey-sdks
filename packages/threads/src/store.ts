/**
 * ThreadStore — the storage-agnostic session logic: thread resolution +
 * ownership, atomic gap-free sequencing, clientMessageId idempotency,
 * turn-level fold persistence (messages + card rows + snapshot), and the
 * prompt-lane history projection. Depends only on
 * {@link ThreadPersistencePort}; bindings supply the storage
 * (`InMemoryThreadPersistence` here; guuey's hosted runtime binds
 * DynamoDB).
 */
import { randomUUID } from "node:crypto";
import type { AgMemoryRecord, AgReduceResult, JsonValue } from "@silverprotocol/core";
import {
  agMessageToBoundedRow,
  agArtifactToCardRow,
  assertRowFits,
  isStoredRowRefusal,
  StoredRowTooLargeError,
  type ElidedField,
  type ElisionReason,
  type RefusedRowKind,
  type StoredElision,
  type StoredRowRefusal,
  keepUnchangedThreadMemory,
  producingMessageIndex,
  producingToolName,
  toolNamesByCallId,
  toolResultMessageIndexByCallId,
  uiCardArtifactsFromMessages,
  storedTextParts,
} from "./fold-rows.js";
import { classifyStoredRow } from "./stored-row.js";
import { threadClosure } from "./closed.js";
import { planSnapshot, type SnapshotRefusal } from "./snapshot-plan.js";
import { writeTapLabels, type TapLabels } from "@guuey/mcp-apps-host/narrowing";
import type {
  ThreadMessageEvent,
  StoredHistoryMessage,
  ThreadMessageKind,
  ThreadMessageRole,
  ThreadMessageRow,
  ThreadClosure,
  ThreadPersistencePort,
  ThreadRow,
  ThreadSnapshotRow,
  TurnOrigin,
  ClientClass,
} from "./rows.js";

/** Max history messages fed back as context — bounds latency on long threads. */
const DEFAULT_HISTORY_LIMIT = 40;

const PREVIEW_MAX_LEN = 240;

export interface EnsureThreadInput {
  /** Client-supplied thread id (localStorage). Absent on first contact. */
  threadId?: string;
  /** Resolved end-user id (`g_<hash>`). */
  userId: string;
  appId: string;
  /** Region pin for a freshly-created Thread (the pod's `AWS_REGION`). */
  region: string;
}

export interface AppendMessageInput {
  threadId: string;
  userId: string;
  role: ThreadMessageRole;
  /** Arbitrary JSON persisted on the row (string for plain text turns). */
  content: unknown;
  /** Plain-text projection for the preview + transcript render. */
  text?: string;
  /** Idempotency key — a retried invoke with the same key won't double-write. */
  clientMessageId: string;
  kind?: ThreadMessageKind;
  /**
   * guuey#524: this write belongs to a PAGE-AWARE turn — the pod (the only
   * honest caller; never client-claimed) passes `true` and the row is
   * stamped `untrustedOrigin`. Vocabulary is {absent, true}: omit on every
   * trusted-origin write, never pass `false`.
   */
  untrustedOrigin?: boolean;
  /**
   * guuey#552: the typed event payload for `kind:'event'` rows — carried
   * verbatim onto the row. The caller sets `kind:'event'` alongside; the
   * store does not infer one from the other.
   */
  event?: ThreadMessageEvent;
  /** A user row's origin (see {@link ThreadMessageRow.turnOrigin}); carried verbatim. */
  turnOrigin?: TurnOrigin;
  /** A `card_action` user row's answered card session id; carried verbatim. */
  answeredCardSessionId?: string;
  /** A user row's client class (see {@link ThreadMessageRow.clientClass}); carried verbatim. */
  clientClass?: ClientClass;
  /**
   * A card-action user row's tap labels (see {@link ThreadMessageRow.tapLabels}).
   * The store re-judges them by the writer contract (`writeTapLabels`) before
   * it writes: a list the contract refuses is not stored (the row lands
   * without the key, so it draws the continuation copy), and an admitted one is
   * stored as the writer's fresh copy. The reader contract is a display guard,
   * never a store's check.
   */
  tapLabels?: TapLabels;
}

export interface AppendMessageResult {
  seq: number;
  /** True when an existing row matched `clientMessageId` (no new write). */
  deduped: boolean;
}

export interface AppendFoldInput {
  threadId: string;
  userId: string;
  fold: AgReduceResult;
  /** Base for the turn-level idempotency sentinel + per-row derived keys. */
  clientMessageIdBase: string;
  /**
   * Suppress the `putSnapshot` upsert (rows still write). Set by the caller
   * when the prior snapshot read failed OR the reducer parked
   * (`needsResync`), so a degraded/partial fold never clobbers a good
   * snapshot. Default: write the snapshot.
   */
  skipSnapshot?: boolean;
  /**
   * guuey#524: the whole fold belongs to a PAGE-AWARE turn — every row it
   * writes (messages AND cards) is stamped `untrustedOrigin`. Same
   * {absent, true} vocabulary as {@link AppendMessageInput.untrustedOrigin}.
   */
  untrustedOrigin?: boolean;
  /**
   * The prior snapshot's `carriedThreadMemory`: stored thread-memory elements
   * this runtime did not read or own. Written back unchanged beside the fold's
   * own thread records, so they are never dropped at rest. Absent = none.
   */
  carriedThreadMemory?: readonly JsonValue[];
  /**
   * The prior snapshot's `threadMemory`: the view the reducer was seeded
   * from. A record this turn did not change is persisted as this prior record,
   * with the members it was stored with (`keepUnchangedThreadMemory`), never as
   * the fold's rebuild of it. Absent = the fold's records as they are.
   */
  priorThreadMemory?: readonly AgMemoryRecord[];
  /**
   * guuey#2120: the prior snapshot's `workingState`: the state the reducer was
   * seeded with. When the turn's state cannot be stored (a number its store
   * cannot hold, or a snapshot over the row budget), the snapshot keeps this
   * one instead and the result reports `refusedSnapshot.state`. Absent = none.
   */
  priorWorkingState?: JsonValue;
  /**
   * guuey#1794: what to store when a row of this turn cannot be stored even
   * with its tool-call values elided: it does not fit the store's row budget,
   * or it carries a number the store cannot hold. Given, the turn is stored
   * as ONE agent row carrying this text and the failure code
   * `stored_turn_too_large` or `stored_turn_unstorable_number` (under the
   * turn sentinel, so the turn is final), and the result reports
   * `unstorable`. Absent, `appendFold` throws the refusal
   * ({@link StoredRowTooLargeError} or `StoredRowUnstorableNumberError`).
   * Either way no other row of the turn is written.
   */
  unstorableNotice?: { text: string };
}

/** One tool-call value stored as the elided marker (guuey#1794). */
export interface ElidedToolInput {
  /** The seq of the message row that carries the marker. */
  seq: number;
  toolCallId: string;
  /** The tool's name. */
  name: string;
  field: ElidedField;
  reason: ElisionReason;
  /** UTF-8 length of the elided value's JSON. */
  bytes: number;
}

/** The turn was stored as its one failure row (see {@link AppendFoldInput.unstorableNotice}). */
export type AppendFoldUnstorable = {
  /** The failure row's seq. */
  seq: number;
  /** The first row that could not be stored. */
  rowKind: RefusedRowKind;
  index: number;
} & (
  | {
      reason: 'size';
      /** That row as its store measured it. */
      bytes: number;
      maxBytes: number;
    }
  | { reason: 'number' }
);

export interface AppendFoldResult {
  messageSeqs: number[];
  artifactSeqs: number[];
  /** Count of non-thread (durable) memory records dropped in v1. */
  droppedDurableMemory: number;
  /**
   * True when the turn-level sentinel matched a committed prior turn and the
   * WHOLE fold-persist was short-circuited (no rows written this call).
   */
  deduped: boolean;
  /** Tool-call values stored as the elided marker so their rows fit; `[]` when none. */
  elidedToolInputs: ElidedToolInput[];
  /** Set when the turn was stored as its one failure row instead of its rows. */
  unstorable?: AppendFoldUnstorable;
  /**
   * guuey#2120: set when part of the turn's snapshot could not be stored and
   * was left out (planned before any row was written; see `planSnapshot`).
   */
  refusedSnapshot?: SnapshotRefusal;
}

/** The failure code of a turn stored as one row because it could not fit (guuey#1794). */
export const STORED_TURN_TOO_LARGE_CODE = 'stored_turn_too_large';

/**
 * The failure code of a turn stored as one row because a row of it carried a
 * number its store cannot hold, outside any tool-call value (guuey#1794).
 */
export const STORED_TURN_UNSTORABLE_NUMBER_CODE = 'stored_turn_unstorable_number';

/**
 * The seq a planned row is measured with before its real seq is allocated:
 * no real seq has more digits, so the real row is never larger.
 */
const PROVISIONAL_SEQ = Number.MAX_SAFE_INTEGER;

/** A fold's snapshot, planned before anything is written (guuey#2120). */
interface FoldSnapshotPlan {
  /** The snapshot to write; undefined = write none (`skipSnapshot`, or it cannot be stored). */
  row: ThreadSnapshotRow | undefined;
  /** Count of non-thread (durable) memory records dropped in v1. */
  droppedDurableMemory: number;
  refusal?: SnapshotRefusal;
}

/** One row of a fold, planned and measured before anything is written. */
interface PlannedRow {
  kind: 'message' | 'card';
  /** The row with its provisional seq and timestamp. */
  row: ThreadMessageRow;
  preview: string | null;
  elided: StoredElision[];
}

// ───────────────────────────────────────────────────────────────────────
// ThreadStore — the logic.
// ───────────────────────────────────────────────────────────────────────

export class ThreadStore {
  constructor(private readonly db: ThreadPersistencePort) {}

  /**
   * Resolve the thread for this invoke:
   * - `threadId` found AND owned by `userId` → return it (the happy path);
   * - otherwise (no `threadId`, stale/unknown id, OR owned by a different
   *   identity) → mint a fresh Thread with a server-assigned id and return it.
   *
   * Minting-fresh on an owner mismatch (rather than erroring) is deliberate:
   * the caller's anon `guuey_guest` cookie can rotate (cleared, or a cross-site
   * request where it isn't sent), which would otherwise orphan a stored
   * `threadId` behind a permanent 403. Minting fresh is both resilient (chat
   * continues on a new conversation) AND safe — the caller never sees another
   * user's thread, and there's no existence oracle. The pod never honours a
   * client-chosen id, so squatting is impossible.
   *
   * A CLOSED thread ({@link ThreadRow.closedAt}) is answered the same way: it
   * takes no new message, so a send on it starts a new conversation.
   */
  async ensureThread(input: EnsureThreadInput): Promise<string> {
    if (input.threadId) {
      const existing = await this.db.getThread(input.threadId);
      if (existing && existing.userId === input.userId && threadClosure(existing) === undefined) {
        return existing.id;
      }
      // Not found, owned by a different identity, OR closed → fall through, mint fresh.
    }
    const now = new Date().toISOString();
    const row: ThreadRow = {
      id: randomUUID(),
      userId: input.userId,
      appId: input.appId,
      servingRegion: input.region,
      title: 'New thread',
      status: 'active',
      pinned: false,
      lastSeq: 0,
      lastMessageAt: now,
      lastMessagePreview: '',
      threadMode: 'single',
      createdAt: now,
      updatedAt: now,
    };
    await this.db.createThread(row);
    return row.id;
  }

  /**
   * Whether `threadId` exists AND is owned by `userId` — the SAME ownership
   * predicate `ensureThread` applies before honouring a client-replayed id,
   * exposed for doors that must BIND a client-echoed thread to the verified
   * caller without minting anything (the pod's consent-answer door binds a
   * `once` grant to a thread this way — guuey#207). No existence oracle: a
   * missing thread and another user's thread are the same `false`, and so is
   * a closed one: nothing binds to a conversation that has ended.
   */
  async ownsThread(threadId: string, userId: string): Promise<boolean> {
    const existing = await this.db.getThread(threadId);
    return existing !== undefined && existing.userId === userId && threadClosure(existing) === undefined;
  }

  /**
   * Whether this binding can close a thread ({@link ThreadPersistencePort.closeThread}
   * present). A caller that writes something before closing (a closing
   * message) reads this first, so a binding that cannot close is left as it was.
   */
  canCloseThreads(): boolean {
    return this.db.closeThread !== undefined;
  }

  /**
   * End the conversation (see {@link ThreadRow.closedAt}): `closed` when this
   * call closed it, `already_closed` when it was closed before (the first
   * closure is kept), `unsupported` when the binding cannot close
   * ({@link ThreadPersistencePort.closeThread} absent; nothing changes).
   * Rejects for a missing thread or a store failure.
   */
  async closeThread(threadId: string, closure: ThreadClosure): Promise<"closed" | "already_closed" | "unsupported"> {
    const close = this.db.closeThread;
    if (close === undefined) return "unsupported";
    return close.call(this.db, threadId, closure);
  }

  /** Prior messages for the thread (seq-ASC, capped to the most recent N). */
  async loadHistory(
    threadId: string,
    limit: number = DEFAULT_HISTORY_LIMIT,
  ): Promise<StoredHistoryMessage[]> {
    const rows = await this.db.listRecentMessages(threadId, limit);
    // This lane feeds the LLM prompt (sse-server → priorMessages →
    // worker <conversation_history>, which serializes {role, text} ONLY —
    // row `content` never reaches the model). Card rows are UI
    // persistence, not conversation: mapped naively they render as empty
    // "Agent:" lines and evict real messages from the history window, so
    // they are dropped here and the model deliberately sees no card HTML.
    // Known trade-off: cards still consume the DynamoDB Limit before this
    // filter, so card-heavy threads under-fill the window (bounded, most-
    // recent-first; revisit with an over-fetch if it bites).
    // The model's text is EVERY text block from the stored message, narration
    // included (`storedTextParts(...).all`): the row's `text` is the answer only
    // since narration split out of it, so reading `text` here would change what
    // the model is replayed. For rows written before the split, `all` is the same
    // bytes their `text` holds. A row whose content is not a stored AgMessage
    // (an event, a managed-adapter row) keeps its `text`.
    //
    // Only CONVERSATION reaches this lane: a failed turn's reader line, a
    // framework notice and a blank agent message are stored rows, never words
    // the agent said, so replaying them made the model (and a hook's
    // transcript) read them as its own ({@link classifyStoredRow}).
    // Two user turns can now sit side by side (the agent row between them
    // dropped). That is fine: every runner renders this history as TEXT lines
    // into its system prompt (`@guuey/host` `withContextPreamble`), never as a
    // role-alternating message list a provider could refuse.
    const conversation = rows
      .filter((r) => r.kind !== 'card' && classifyStoredRow(r).kind === 'conversation')
      .map((r): StoredHistoryMessage => ({
        seq: r.seq,
        authorRole: r.authorRole,
        kind: r.kind,
        text: storedTextParts(r.content)?.all || (r.text ?? null),
        content: r.content ?? null,
        at: r.at,
      }));
    return conversation;
  }

  /**
   * Append one message with an atomic, gap-free seq. Idempotent on
   * `clientMessageId`: a prior row with the same key returns its seq without
   * a second write. Mirrors `ops/append-message.ts` steps 2–4.
   */
  async appendMessage(input: AppendMessageInput): Promise<AppendMessageResult> {
    const prior = await this.db.findByClientMessageId(
      input.threadId,
      input.clientMessageId,
    );
    if (prior) {
      return { seq: prior.seq, deduped: true };
    }

    const now = new Date().toISOString();
    // An event row (a hand-off, a report) is a record ABOUT the conversation,
    // written from all of it (a model-written ask or summary), not a message in
    // it: like a card row it leaves the prior preview standing (null), so the
    // conversation list never shows a copy drawn from the whole thread.
    const preview =
      input.event !== undefined ? null : input.text ? input.text.slice(0, PREVIEW_MAX_LEN) : '';
    // guuey#2031: the store re-judges a row's tap labels; it never trusts its caller's check.
    const tapLabels = input.tapLabels !== undefined ? writeTapLabels(input.tapLabels) : undefined;
    const draft: ThreadMessageRow = {
      threadId: input.threadId,
      seq: PROVISIONAL_SEQ,
      userId: input.userId,
      clientMessageId: input.clientMessageId,
      at: now,
      kind: input.kind ?? 'text',
      authorRole: input.role,
      ...(input.text !== undefined ? { text: input.text } : {}),
      content: input.content,
      ...(input.untrustedOrigin === true ? { untrustedOrigin: true } : {}),
      ...(input.event !== undefined ? { event: input.event } : {}),
      ...(input.turnOrigin !== undefined ? { turnOrigin: input.turnOrigin } : {}),
      ...(input.answeredCardSessionId !== undefined ? { answeredCardSessionId: input.answeredCardSessionId } : {}),
      ...(input.clientClass !== undefined ? { clientClass: input.clientClass } : {}),
      ...(tapLabels !== undefined ? { tapLabels } : {}),
    };
    // guuey#1794: measured before the seq is allocated, so an oversized row
    // spends no seq. The real seq is never longer than the provisional one.
    assertRowFits(draft, this.db.rowBudget, 'append', 0);
    const seq = await this.db.incrementSeq(input.threadId, preview, now);
    await this.db.putMessage({ ...draft, seq });
    return { seq, deduped: false };
  }

  /** The thread's latest fold snapshot, or undefined when none persisted yet. */
  async getSnapshot(threadId: string): Promise<ThreadSnapshotRow | undefined> {
    return this.db.getSnapshot(threadId);
  }

  /**
   * Persist a turn's fold delta: one row per message, one card row per
   * artifact (each via an atomic gap-free seq), turn records inlined on the
   * message rows, and an upserted snapshot for working state + thread-memory.
   *
   * Idempotency is TURN-LEVEL, not per-row. A retried invoke re-runs the LLM
   * and can yield a *different* fold (different message count / content);
   * per-index dedup would keep some prior rows and append new ones for the
   * rest → a Frankenstein/orphan thread + clobbered snapshot. Instead, the
   * FIRST row written (the first message, or — if there are no messages — the
   * first card) claims a single `${base}#agentTurn` sentinel key. On any later
   * call with the same base, the sentinel matches and the WHOLE persist is
   * short-circuited (a committed agent turn is never re-merged).
   *
   * Durable (non-thread) memory is logged-and-dropped in v1. `skipSnapshot`
   * suppresses the snapshot upsert so a degraded/parked fold never overwrites
   * a good snapshot.
   *
   * The snapshot is planned with the rows, before any row is written
   * (guuey#2120): a working state its store cannot hold is refused (the
   * snapshot keeps `priorWorkingState`), and a memory element that cannot be
   * stored is left out, reported as `refusedSnapshot`. The snapshot write is
   * never the write that fails after the turn's rows landed.
   */
  async appendFold(input: AppendFoldInput): Promise<AppendFoldResult> {
    const { threadId, clientMessageIdBase } = input;

    // Turn-level idempotency gate: a committed agent turn is never re-merged.
    const sentinelKey = `${clientMessageIdBase}#agentTurn`;
    const existing = await this.db.findByClientMessageId(threadId, sentinelKey);
    if (existing) {
      return { messageSeqs: [existing.seq], artifactSeqs: [], droppedDurableMemory: 0, deduped: true, elidedToolInputs: [] };
    }

    // guuey#1794 — plan every row of the turn, then write. Nothing is written
    // (no seq spent, no sentinel claimed) until every row is known to fit the
    // store's row budget: a row that failed mid-loop used to leave a partial
    // turn whose sentinel short-circuited every retry. Planned rows carry a
    // provisional seq and timestamp no smaller than the real ones, so the real
    // values can only shrink a row that fit.
    const provisionalAt = new Date().toISOString();
    // guuey#2120 — the snapshot is planned with the rows: what its store
    // cannot hold is left out here, before any row is written, so the
    // snapshot write that follows the rows is never the one that fails.
    const snapshot = this.planFoldSnapshot(input, provisionalAt);
    const planned: PlannedRow[] = [];
    try {
      this.planFoldRows(input, sentinelKey, provisionalAt, planned);
    } catch (err) {
      if (!isStoredRowRefusal(err) || input.unstorableNotice === undefined) throw err;
      return this.writeUnstorableMarker(input, input.unstorableNotice, sentinelKey, err, snapshot);
    }

    const messageSeqs: number[] = [];
    const artifactSeqs: number[] = [];
    const elidedToolInputs: ElidedToolInput[] = [];
    for (const p of planned) {
      const now = new Date().toISOString();
      const seq = await this.db.incrementSeq(threadId, p.preview, now);
      await this.db.putMessage({ ...p.row, seq, at: now });
      (p.kind === 'message' ? messageSeqs : artifactSeqs).push(seq);
      for (const e of p.elided) {
        elidedToolInputs.push({ seq, toolCallId: e.toolCallId, name: e.name, field: e.field, reason: e.reason, bytes: e.bytes });
      }
    }

    await this.writeSnapshot(snapshot);
    return {
      messageSeqs,
      artifactSeqs,
      droppedDurableMemory: snapshot.droppedDurableMemory,
      deduped: false,
      elidedToolInputs,
      ...(snapshot.refusal !== undefined ? { refusedSnapshot: snapshot.refusal } : {}),
    };
  }

  /**
   * The snapshot a fold persists (working state + thread memory + last turn),
   * planned under the store's row budget (guuey#2120). Writes nothing.
   * `row` is undefined when `skipSnapshot` is set or the snapshot cannot be
   * stored at all.
   */
  private planFoldSnapshot(input: AppendFoldInput, provisionalAt: string): FoldSnapshotPlan {
    const { fold } = input;
    const threadMemory = keepUnchangedThreadMemory(input.priorThreadMemory ?? [], fold.memory.filter((m) => m.scope === 'thread'));
    const droppedDurableMemory = fold.memory.length - threadMemory.length;
    if (input.skipSnapshot === true) return { row: undefined, droppedDurableMemory };
    const lastTurnId = fold.turns.length ? fold.turns[fold.turns.length - 1]!.turnId : undefined;
    const planned = planSnapshot(
      {
        row: {
          threadId: input.threadId,
          userId: input.userId,
          threadMemory,
          ...(input.carriedThreadMemory !== undefined && input.carriedThreadMemory.length > 0
            ? { carriedThreadMemory: [...input.carriedThreadMemory] }
            : {}),
          updatedAt: provisionalAt,
          ...(fold.state !== undefined ? { workingState: fold.state } : {}),
          ...(lastTurnId ? { lastTurnId } : {}),
        },
        ...(input.priorWorkingState !== undefined ? { priorWorkingState: input.priorWorkingState } : {}),
        ...(input.priorThreadMemory !== undefined ? { priorThreadMemory: input.priorThreadMemory } : {}),
      },
      this.db.rowBudget,
    );
    return {
      row: planned.row,
      droppedDurableMemory,
      ...(planned.refusal !== undefined ? { refusal: planned.refusal } : {}),
    };
  }

  /** Write a planned snapshot, stamped now (the same length as the provisional stamp it was measured with). */
  private async writeSnapshot(plan: FoldSnapshotPlan): Promise<void> {
    if (plan.row === undefined) return;
    await this.db.putSnapshot({ ...plan.row, updatedAt: new Date().toISOString() });
  }

  /**
   * The turn's one row when a row of it cannot be stored: the caller's notice
   * text, under the turn sentinel (so a retry short-circuits and the turn is
   * final), carrying the failure code readers classify as a failed turn
   * (`stored_turn_too_large` with the counts, or `stored_turn_unstorable_number`).
   * No other row of the turn is written.
   */
  private async writeUnstorableMarker(
    input: AppendFoldInput,
    notice: { text: string },
    sentinelKey: string,
    err: StoredRowRefusal,
    snapshot: FoldSnapshotPlan,
  ): Promise<AppendFoldResult> {
    const { text } = notice;
    const error =
      err instanceof StoredRowTooLargeError
        ? { code: STORED_TURN_TOO_LARGE_CODE, bytes: err.bytes, maxBytes: err.maxBytes }
        : { code: STORED_TURN_UNSTORABLE_NUMBER_CODE };
    const now = new Date().toISOString();
    const seq = await this.db.incrementSeq(input.threadId, text.slice(0, PREVIEW_MAX_LEN), now);
    await this.db.putMessage({
      threadId: input.threadId,
      seq,
      userId: input.userId,
      clientMessageId: sentinelKey,
      at: now,
      kind: 'text',
      authorRole: 'agent',
      text,
      content: {
        kind: 'text',
        text,
        error,
      },
      ...(input.untrustedOrigin === true ? { untrustedOrigin: true } : {}),
    });
    await this.writeSnapshot(snapshot);
    return {
      messageSeqs: [],
      artifactSeqs: [],
      droppedDurableMemory: snapshot.droppedDurableMemory,
      deduped: false,
      elidedToolInputs: [],
      ...(snapshot.refusal !== undefined ? { refusedSnapshot: snapshot.refusal } : {}),
      unstorable:
        err instanceof StoredRowTooLargeError
          ? { seq, rowKind: err.rowKind, index: err.index, reason: 'size', bytes: err.bytes, maxBytes: err.maxBytes }
          : { seq, rowKind: err.rowKind, index: err.index, reason: 'number' },
    };
  }

  /**
   * Build every row a fold writes, in write order, with a provisional seq and
   * timestamp, bounded by the store's row budget (throws a
   * {@link StoredRowRefusal} when one cannot be stored). Writes nothing.
   */
  private planFoldRows(
    input: AppendFoldInput,
    sentinelKey: string,
    provisionalAt: string,
    planned: PlannedRow[],
  ): void {
    const { threadId, userId, fold, clientMessageIdBase } = input;
    const budget = this.db.rowBudget;
    const seq = PROVISIONAL_SEQ;
    // Whichever row is written first claims the sentinel key. Keys are minted
    // in planning order (messages, then cards); the WRITE order below
    // interleaves the cards, and a card only ever follows a message, so the
    // first row written is still the first row keyed.
    let sentinelClaimed = false;
    const messageRows: PlannedRow[] = [];
    /** Per message index, the card rows drawn with it (guuey#2396). */
    const cardsAfterMessage = new Map<number, PlannedRow[]>();
    const tailCards: PlannedRow[] = [];

    for (let i = 0; i < fold.messages.length; i++) {
      const msg = fold.messages[i]!;
      const clientMessageId = sentinelClaimed ? `${clientMessageIdBase}#agent#${i}` : sentinelKey;
      sentinelClaimed = true;
      // The preview is the ANSWER: interim narration (`phase: "interim"`) never becomes a thread's preview,
      // and neither does a framework notice (a non-conversational row).
      const text =
        msg.role === 'notice'
          ? ''
          : msg.content.reduce((acc, b) => (b.type === 'text' && b.phase !== 'interim' ? acc + b.text : acc), '');
      const turnRecord = fold.turns.find((t) => t.turnId === msg.turnId);
      const { row, elided } = agMessageToBoundedRow(
        msg,
        {
          threadId,
          userId,
          seq,
          at: provisionalAt,
          clientMessageId,
          ...(turnRecord ? { turnRecord } : {}),
          ...(input.untrustedOrigin === true ? { untrustedOrigin: true } : {}),
        },
        budget,
        i,
      );
      // Text-less agent messages (tool-call + tool-result only — the canonical
      // card-producing turn) must not blank the preview: '' takes the SET
      // branch, null leaves the prior preview standing.
      messageRows.push({ kind: 'message', row, preview: text ? text.slice(0, PREVIEW_MAX_LEN) : null, elided });
    }

    // Cards can arrive two ways: first-class artifact events (fold.artifacts)
    // or UI-carrying tool-result blocks inside messages (the Claude facet's
    // only channel — see uiCardArtifactsFromMessages). Persist both through
    // the same card-row lane so history rehydrates them (guuey#86). The
    // artifactId dedupe makes re-persisting a reassembled fold (whose
    // artifacts already CONTAIN prior projections, deterministic
    // `<msgId>#ui#<idx>` ids) a no-op instead of a double-write.
    const knownArtifactIds = new Set(fold.artifacts.map((a) => a.artifactId));
    const projected = uiCardArtifactsFromMessages(fold.messages).filter(
      (a) => !knownArtifactIds.has(a.artifactId),
    );
    const cardArtifacts = [...fold.artifacts, ...projected];
    // guuey#402: the fold has the tool-CALL blocks in hand — the only place
    // the producing tool's name rides — so resolve it here and persist it
    // beside the snapshot. Unresolvable (a first-class artifact event with
    // no tool-result part) persists no name; readers fall back.
    const toolNames = toolNamesByCallId(fold.messages);
    const resultIndices = toolResultMessageIndexByCallId(fold.messages);
    for (let i = 0; i < cardArtifacts.length; i++) {
      const art = cardArtifacts[i]!;
      const clientMessageId = sentinelClaimed ? `${clientMessageIdBase}#card#${i}` : sentinelKey;
      sentinelClaimed = true;
      const row = agArtifactToCardRow(
        art,
        {
          threadId,
          userId,
          seq,
          at: provisionalAt,
          clientMessageId,
          ...(input.untrustedOrigin === true ? { untrustedOrigin: true } : {}),
        },
        producingToolName(art, toolNames),
      );
      assertRowFits(row, budget, 'card', i);
      const card: PlannedRow = { kind: 'card', row, preview: art.name ?? null, elided: [] };
      const anchor = producingMessageIndex(art, resultIndices);
      if (anchor === undefined) {
        tailCards.push(card);
      } else {
        const after = cardsAfterMessage.get(anchor);
        if (after === undefined) cardsAfterMessage.set(anchor, [card]);
        else after.push(card);
      }
    }

    // guuey#2396: the stored order is the drawn order. A card is drawn when
    // its tool-result arrives, so its row follows the message carrying that
    // result, BEFORE any text the turn writes after it. Writing every message
    // first and every card after it put a turn's closing text above the card
    // it describes on every reload. A card with no producing result in the
    // fold keeps the turn's tail, as before.
    messageRows.forEach((message, index) => {
      planned.push(message, ...(cardsAfterMessage.get(index) ?? []));
    });
    planned.push(...tailCards);
  }
}

