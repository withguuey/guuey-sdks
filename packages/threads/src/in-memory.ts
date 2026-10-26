/**
 * InMemoryThreadPersistence — the dev/test binding of
 * {@link ThreadPersistencePort}. Same contract as any real binding (run
 * the suite in `@guuey/threads/testing` to prove yours), including the
 * two conditional-write guards and the null-preview no-touch semantics.
 */
import { previewDigest } from "./seal.js";
import { ThreadClosedError, threadClosure } from "./closed.js";
import {
  DEFAULT_THREAD_TITLE,
  TITLE_MAX_ATTEMPTS,
  TITLE_MAX_GENERATIONS,
  type TitleWrite,
  type TitleWriteResult,
} from "./title.js";
import type {
  ThreadClosure,
  ThreadMessageRow,
  ThreadPersistencePort,
  ThreadRow,
  ThreadSnapshotRow,
} from "./rows.js";

export class InMemoryThreadPersistence implements ThreadPersistencePort {
  readonly threads = new Map<string, ThreadRow>();
  readonly messages: ThreadMessageRow[] = [];
  readonly snapshots = new Map<string, ThreadSnapshotRow>();

  async getThread(threadId: string): Promise<ThreadRow | undefined> {
    return this.threads.get(threadId);
  }

  async createThread(row: ThreadRow): Promise<void> {
    if (this.threads.has(row.id)) {
      throw new Error(`createThread: thread ${row.id} already exists`);
    }
    this.threads.set(row.id, { ...row });
  }

  async incrementSeq(threadId: string, preview: string | null, atIso: string): Promise<number> {
    const t = this.threads.get(threadId);
    if (!t) throw new Error(`incrementSeq: thread ${threadId} does not exist`);
    if (threadClosure(t) !== undefined) throw new ThreadClosedError(threadId);
    t.lastSeq += 1;
    t.lastMessageAt = atIso;
    t.updatedAt = atIso;
    // null = allocate the seq WITHOUT touching the preview (card rows,
    // text-less agent turns) — mirror of the hosted binding's branch.
    if (preview !== null) {
      t.lastMessagePreview = preview;
      // The preview's source seq and digest ride the same update, so a reader
      // can tell whether the message the preview came from is sealed (`seal.ts`).
      t.lastMessagePreviewSeq = t.lastSeq;
      t.lastMessagePreviewDigest = previewDigest(preview);
    }
    return t.lastSeq;
  }

  async closeThread(threadId: string, closure: ThreadClosure): Promise<"closed" | "already_closed"> {
    const t = this.threads.get(threadId);
    if (!t) throw new Error(`closeThread: thread ${threadId} does not exist`);
    if (threadClosure(t) !== undefined) return "already_closed";
    t.closedCode = closure.code;
    t.closedMessage = closure.message;
    t.closedAt = closure.at;
    return "closed";
  }

  async writeTitle(threadId: string, write: TitleWrite): Promise<TitleWriteResult> {
    const t = this.threads.get(threadId);
    if (!t) return "refused";
    switch (write.kind) {
      case "claim": {
        if (!titleWritable(t) || (t.titleAttempts ?? 0) >= TITLE_MAX_ATTEMPTS) return "refused";
        if (t.titleCheckedSeq !== undefined && t.titleCheckedSeq >= write.checkpoint) return "refused";
        // The claim IS the checkpoint taken, so a second claimant at
        // the same checkpoint refuses before any call.
        t.titleCheckedSeq = write.checkpoint;
        t.titleAttempts = (t.titleAttempts ?? 0) + 1;
        t.updatedAt = write.at;
        return "written";
      }
      case "record": {
        // A record consumes its claim: one claim, at most one generation.
        if (!titleWritable(t) || t.titleCheckedSeq !== write.checkpoint || t.titleRecordedSeq === write.checkpoint) {
          return "refused";
        }
        t.title = write.title;
        t.generatedTitle = write.title;
        t.titleSource = "generated";
        t.titleUpdatedAt = write.at;
        t.updatedAt = write.at;
        t.titleSourceSeq = write.sourceSeq;
        t.titleRecordedSeq = write.checkpoint;
        if (write.language !== undefined) t.titleLanguage = write.language;
        t.titleGenerations = (t.titleGenerations ?? 0) + 1;
        return "written";
      }
      case "set": {
        // Owner-only, and never on a thread being erased (no title write is).
        if (t.userId !== write.userId || t.erasingAt !== undefined) return "refused";
        if (write.title !== null) {
          t.title = write.title;
          t.titleSource = "set";
        } else if (t.generatedTitle !== undefined) {
          t.title = t.generatedTitle;
          t.titleSource = "generated";
        } else {
          t.title = DEFAULT_THREAD_TITLE;
          t.titleSource = "default";
          delete t.titleCheckedSeq;
        }
        t.titleUpdatedAt = write.at;
        t.updatedAt = write.at;
        return "written";
      }
    }
  }

  async putMessage(row: ThreadMessageRow): Promise<void> {
    if (this.messages.some((m) => m.threadId === row.threadId && m.seq === row.seq)) {
      throw new Error(`putMessage: seq ${row.seq} already exists on ${row.threadId}`);
    }
    this.messages.push({ ...row });
  }

  async listRecentMessages(threadId: string, limit: number): Promise<ThreadMessageRow[]> {
    return this.messages
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit)
      .reverse();
  }

  async findByClientMessageId(
    threadId: string,
    clientMessageId: string,
  ): Promise<ThreadMessageRow | undefined> {
    return this.messages.find(
      (m) => m.threadId === threadId && m.clientMessageId === clientMessageId,
    );
  }

  async getSnapshot(threadId: string): Promise<ThreadSnapshotRow | undefined> {
    return this.snapshots.get(threadId);
  }

  async putSnapshot(row: ThreadSnapshotRow): Promise<void> {
    this.snapshots.set(row.threadId, { ...row });
  }
}

/**
 * The conditions a claim and a record share (the hosted binding's condition
 * expressions, mirrored): not being erased, a source the titler may replace,
 * room under the generation cap, and no seal (no record, or an empty list).
 */
function titleWritable(t: ThreadRow): boolean {
  if (t.erasingAt !== undefined) return false;
  if (t.titleSource !== undefined && t.titleSource !== "default" && t.titleSource !== "generated") return false;
  if ((t.titleGenerations ?? 0) >= TITLE_MAX_GENERATIONS) return false;
  return t.sealIntervals === undefined || (Array.isArray(t.sealIntervals) && t.sealIntervals.length === 0);
}
