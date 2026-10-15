/**
 * A closed conversation: `ThreadStore.closeThread` records why it ended, and
 * from then on the conversation takes no new message. A client that sends on
 * it again gets a fresh conversation (`ensureThread`), exactly as it would for
 * a thread it does not own.
 */
import { describe, expect, it } from 'vitest';
import { ThreadStore, ThreadClosedError, threadClosure, type ThreadPersistencePort, type ThreadRow } from './index.js';
import { InMemoryThreadPersistence } from './in-memory.js';

const CLOSE = { code: 'app:CHAT_FULL', message: 'This chat is full. Start a new one.', at: '2026-10-15T00:00:00.000Z' };

async function seeded(): Promise<{ db: InMemoryThreadPersistence; store: ThreadStore; threadId: string }> {
  const db = new InMemoryThreadPersistence();
  const store = new ThreadStore(db);
  const threadId = await store.ensureThread({ userId: 'g_owner', appId: 'app_1', region: 'us-east-1' });
  await store.appendMessage({ threadId, userId: 'g_owner', role: 'user', content: 'hi', text: 'hi', clientMessageId: 'c1' });
  return { db, store, threadId };
}

describe('threadClosure', () => {
  const base: ThreadRow = {
    id: 't1',
    userId: 'u',
    appId: 'a',
    servingRegion: 'r',
    title: 'New thread',
    status: 'active',
    pinned: false,
    lastSeq: 0,
    lastMessageAt: CLOSE.at,
    lastMessagePreview: '',
    threadMode: 'single',
    createdAt: CLOSE.at,
    updatedAt: CLOSE.at,
  };

  it('reads a row without the fields (every row written before closing existed) as open', () => {
    expect(threadClosure(base)).toBeUndefined();
  });

  it('reads the three fields as the closure', () => {
    expect(threadClosure({ ...base, closedCode: CLOSE.code, closedMessage: CLOSE.message, closedAt: CLOSE.at })).toEqual(CLOSE);
  });

  it('reads closedAt alone as closed: the row is closed even when the reason is unreadable', () => {
    expect(threadClosure({ ...base, closedAt: CLOSE.at })).toEqual({ code: '', message: '', at: CLOSE.at });
  });
});

describe('ThreadStore.closeThread', () => {
  it('canCloseThreads answers true over a binding that implements closeThread', async () => {
    const { store } = await seeded();
    expect(store.canCloseThreads()).toBe(true);
  });

  it('records the closure on the thread and answers closed', async () => {
    const { db, store, threadId } = await seeded();
    expect(await store.closeThread(threadId, CLOSE)).toBe('closed');
    const row = db.threads.get(threadId);
    expect(row && threadClosure(row)).toEqual(CLOSE);
    // The thread keeps its status and its messages: closing is not archiving.
    expect(row?.status).toBe('active');
    expect(db.messages.filter((m) => m.threadId === threadId)).toHaveLength(1);
  });

  it('a second close answers already_closed and keeps the first reason', async () => {
    const { db, store, threadId } = await seeded();
    await store.closeThread(threadId, CLOSE);
    expect(await store.closeThread(threadId, { ...CLOSE, code: 'app:OTHER', at: '2026-10-16T00:00:00.000Z' })).toBe('already_closed');
    const row = db.threads.get(threadId);
    expect(row && threadClosure(row)).toEqual(CLOSE);
  });

  it('rejects for a missing thread', async () => {
    const { store } = await seeded();
    await expect(store.closeThread('t-missing', CLOSE)).rejects.toThrow();
  });

  it("answers unsupported over a binding that cannot close, and changes nothing", async () => {
    const inner = new InMemoryThreadPersistence();
    const port: ThreadPersistencePort = {
      getThread: (id) => inner.getThread(id),
      createThread: (row) => inner.createThread(row),
      incrementSeq: (id, preview, at) => inner.incrementSeq(id, preview, at),
      putMessage: (row) => inner.putMessage(row),
      listRecentMessages: (id, limit) => inner.listRecentMessages(id, limit),
      findByClientMessageId: (id, cmid) => inner.findByClientMessageId(id, cmid),
      getSnapshot: (id) => inner.getSnapshot(id),
      putSnapshot: (row) => inner.putSnapshot(row),
    };
    const store = new ThreadStore(port);
    const threadId = await store.ensureThread({ userId: 'g_owner', appId: 'app_1', region: 'us-east-1' });
    // Known up front, so a caller can decide before it writes anything.
    expect(store.canCloseThreads()).toBe(false);
    expect(await store.closeThread(threadId, CLOSE)).toBe('unsupported');
    const row = inner.threads.get(threadId);
    expect(row && threadClosure(row)).toBeUndefined();
  });
});

describe('a closed thread takes no new message', () => {
  it('appendMessage rejects with ThreadClosedError and writes no row', async () => {
    const { db, store, threadId } = await seeded();
    await store.closeThread(threadId, CLOSE);
    const err = await store
      .appendMessage({ threadId, userId: 'g_owner', role: 'user', content: 'again', text: 'again', clientMessageId: 'c2' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThreadClosedError);
    expect(err instanceof ThreadClosedError && err.code).toBe('THREAD_CLOSED');
    expect(db.messages.filter((m) => m.threadId === threadId)).toHaveLength(1);
    expect(db.threads.get(threadId)?.lastSeq).toBe(1);
  });

  it('a retried append of a row already written before the close still dedups', async () => {
    const { store, threadId } = await seeded();
    await store.closeThread(threadId, CLOSE);
    expect(
      await store.appendMessage({ threadId, userId: 'g_owner', role: 'user', content: 'hi', text: 'hi', clientMessageId: 'c1' }),
    ).toEqual({ seq: 1, deduped: true });
  });
});

describe('ensureThread / ownsThread on a closed thread', () => {
  it("ensureThread mints a fresh thread for the owner, as for a thread it does not own", async () => {
    const { db, store, threadId } = await seeded();
    await store.closeThread(threadId, CLOSE);
    const fresh = await store.ensureThread({ threadId, userId: 'g_owner', appId: 'app_1', region: 'us-east-1' });
    expect(fresh).not.toBe(threadId);
    expect(db.threads.get(fresh)?.userId).toBe('g_owner');
    const freshRow = db.threads.get(fresh);
    expect(freshRow && threadClosure(freshRow)).toBeUndefined();
    // The closed thread is untouched.
    const closedRow = db.threads.get(threadId);
    expect(closedRow && threadClosure(closedRow)).toEqual(CLOSE);
  });

  it('ownsThread answers false for a closed thread, so nothing binds to it', async () => {
    const { store, threadId } = await seeded();
    expect(await store.ownsThread(threadId, 'g_owner')).toBe(true);
    await store.closeThread(threadId, CLOSE);
    expect(await store.ownsThread(threadId, 'g_owner')).toBe(false);
  });
});
