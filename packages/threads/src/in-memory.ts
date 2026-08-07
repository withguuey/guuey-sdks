/**
 * InMemoryThreadPersistence — the dev/test binding of
 * {@link ThreadPersistencePort}. Same contract as any real binding (run
 * the suite in `@guuey/threads/testing` to prove yours), including the
 * two conditional-write guards and the null-preview no-touch semantics.
 */
import type {
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
    t.lastSeq += 1;
    t.lastMessageAt = atIso;
    t.updatedAt = atIso;
    // null = allocate the seq WITHOUT touching the preview (card rows,
    // text-less agent turns) — mirror of the hosted binding's branch.
    if (preview !== null) t.lastMessagePreview = preview;
    return t.lastSeq;
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
