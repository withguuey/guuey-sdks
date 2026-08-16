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
import type { AgReduceResult } from "@silverprotocol/core";
import { agMessageToRow, agArtifactToCardRow, uiCardArtifactsFromMessages } from "./fold-rows.js";
import type {
  StoredHistoryMessage,
  ThreadMessageKind,
  ThreadMessageRole,
  ThreadMessageRow,
  ThreadPersistencePort,
  ThreadRow,
  ThreadSnapshotRow,
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
}

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
   */
  async ensureThread(input: EnsureThreadInput): Promise<string> {
    if (input.threadId) {
      const existing = await this.db.getThread(input.threadId);
      if (existing && existing.userId === input.userId) {
        return existing.id;
      }
      // Not found OR owned by a different identity → fall through, mint fresh.
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
   * missing thread and another user's thread are the same `false`.
   */
  async ownsThread(threadId: string, userId: string): Promise<boolean> {
    const existing = await this.db.getThread(threadId);
    return existing !== undefined && existing.userId === userId;
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
    return rows.filter((r) => r.kind !== 'card').map((r) => ({
      seq: r.seq,
      authorRole: r.authorRole,
      kind: r.kind,
      text: r.text ?? null,
      content: r.content ?? null,
      at: r.at,
    }));
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
    const preview = input.text ? input.text.slice(0, PREVIEW_MAX_LEN) : '';
    const seq = await this.db.incrementSeq(input.threadId, preview, now);

    const row: ThreadMessageRow = {
      threadId: input.threadId,
      seq,
      userId: input.userId,
      clientMessageId: input.clientMessageId,
      at: now,
      kind: input.kind ?? 'text',
      authorRole: input.role,
      ...(input.text !== undefined ? { text: input.text } : {}),
      content: input.content,
    };
    await this.db.putMessage(row);
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
   */
  async appendFold(input: AppendFoldInput): Promise<AppendFoldResult> {
    const { threadId, userId, fold, clientMessageIdBase, skipSnapshot } = input;

    // Turn-level idempotency gate: a committed agent turn is never re-merged.
    const sentinelKey = `${clientMessageIdBase}#agentTurn`;
    const existing = await this.db.findByClientMessageId(threadId, sentinelKey);
    if (existing) {
      return { messageSeqs: [existing.seq], artifactSeqs: [], droppedDurableMemory: 0, deduped: true };
    }

    const messageSeqs: number[] = [];
    const artifactSeqs: number[] = [];
    // Whichever row is written first claims the sentinel key.
    let sentinelClaimed = false;

    for (let i = 0; i < fold.messages.length; i++) {
      const msg = fold.messages[i]!;
      const clientMessageId = sentinelClaimed ? `${clientMessageIdBase}#agent#${i}` : sentinelKey;
      sentinelClaimed = true;
      const text = msg.content.reduce((acc, b) => (b.type === 'text' ? acc + b.text : acc), '');
      const now = new Date().toISOString();
      // Text-less agent messages (tool-call + tool-result only — the canonical
      // card-producing turn) must not blank the preview: '' takes the SET
      // branch, null leaves the prior preview standing.
      const seq = await this.db.incrementSeq(threadId, text ? text.slice(0, PREVIEW_MAX_LEN) : null, now);
      const turnRecord = fold.turns.find((t) => t.turnId === msg.turnId);
      await this.db.putMessage(
        agMessageToRow(msg, {
          threadId,
          userId,
          seq,
          at: now,
          clientMessageId,
          ...(turnRecord ? { turnRecord } : {}),
        }),
      );
      messageSeqs.push(seq);
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
    for (let i = 0; i < cardArtifacts.length; i++) {
      const art = cardArtifacts[i]!;
      const clientMessageId = sentinelClaimed ? `${clientMessageIdBase}#card#${i}` : sentinelKey;
      sentinelClaimed = true;
      const now = new Date().toISOString();
      const seq = await this.db.incrementSeq(threadId, art.name ?? null, now);
      await this.db.putMessage(agArtifactToCardRow(art, { threadId, userId, seq, at: now, clientMessageId }));
      artifactSeqs.push(seq);
    }

    const threadMemory = fold.memory.filter((m) => m.scope === 'thread');
    const droppedDurableMemory = fold.memory.length - threadMemory.length;

    if (skipSnapshot !== true) {
      const lastTurnId = fold.turns.length ? fold.turns[fold.turns.length - 1]!.turnId : undefined;
      await this.db.putSnapshot({
        threadId,
        userId,
        threadMemory,
        updatedAt: new Date().toISOString(),
        ...(fold.state !== undefined ? { workingState: fold.state } : {}),
        ...(lastTurnId ? { lastTurnId } : {}),
      });
    }

    return { messageSeqs, artifactSeqs, droppedDurableMemory, deduped: false };
  }
}

