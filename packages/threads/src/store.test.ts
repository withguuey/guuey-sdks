import { describe, expect, it } from 'vitest';
import type { AgReduceResult } from '@silverprotocol/core';
import { ThreadStore, type ThreadRow, type ThreadSnapshotRow } from './index.js';

// The package ships the binding this suite runs against.
import { InMemoryThreadPersistence as FakePersistence } from "./in-memory.js";

/** Minimal {@link ThreadRow} for tests — seeds a thread at lastSeq:0. */
function makeThreadRow(id: string, userId: string): ThreadRow {
  const now = '2026-06-24T00:00:00.000Z';
  return {
    id,
    userId,
    appId: 'app_1',
    servingRegion: 'us-east-1',
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
}

describe('ThreadStore.ensureThread', () => {
  it('creates a fresh thread when no threadId is given', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    const id = await store.ensureThread({
      userId: 'g_abc',
      appId: 'app_1',
      region: 'us-east-1',
    });
    expect(id).toBeTruthy();
    const row = db.threads.get(id);
    expect(row).toMatchObject({
      userId: 'g_abc',
      appId: 'app_1',
      servingRegion: 'us-east-1',
      lastSeq: 0,
      status: 'active',
    });
  });

  it('returns the existing thread when the owner matches', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    const id = await store.ensureThread({ userId: 'g_abc', appId: 'app_1', region: 'us-east-1' });
    const again = await store.ensureThread({
      threadId: id,
      userId: 'g_abc',
      appId: 'app_1',
      region: 'us-east-1',
    });
    expect(again).toBe(id);
    expect(db.threads.size).toBe(1);
  });

  it('mints a fresh thread when the passed threadId is owned by another identity', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    const id = await store.ensureThread({ userId: 'g_owner', appId: 'app_1', region: 'us-east-1' });
    const fresh = await store.ensureThread({
      threadId: id,
      userId: 'g_other',
      appId: 'app_1',
      region: 'us-east-1',
    });
    // A new id — never the other user's — and the original is untouched.
    expect(fresh).not.toBe(id);
    expect(db.threads.get(id)?.userId).toBe('g_owner');
    expect(db.threads.get(fresh)?.userId).toBe('g_other');
  });

  it('mints a fresh thread (new id) when the passed threadId is stale/unknown', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    const id = await store.ensureThread({
      threadId: 'does-not-exist',
      userId: 'g_abc',
      appId: 'app_1',
      region: 'us-east-1',
    });
    expect(id).not.toBe('does-not-exist');
    expect(db.threads.has(id)).toBe(true);
  });
});

describe('ThreadStore.appendMessage', () => {
  it('allocates gap-free, monotonic seqs', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    const threadId = await store.ensureThread({ userId: 'g_abc', appId: 'app_1', region: 'us-east-1' });

    const a = await store.appendMessage({
      threadId, userId: 'g_abc', role: 'user', content: 'hi', text: 'hi', clientMessageId: 'c1',
    });
    const b = await store.appendMessage({
      threadId, userId: 'g_abc', role: 'agent', content: 'hello', text: 'hello', clientMessageId: 'c2',
    });
    const c = await store.appendMessage({
      threadId, userId: 'g_abc', role: 'user', content: 'bye', text: 'bye', clientMessageId: 'c3',
    });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(a.deduped).toBe(false);
    expect(db.threads.get(threadId)?.lastSeq).toBe(3);
    expect(db.threads.get(threadId)?.lastMessagePreview).toBe('bye');
  });

  it('dedups on clientMessageId without bumping seq', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    const threadId = await store.ensureThread({ userId: 'g_abc', appId: 'app_1', region: 'us-east-1' });

    const first = await store.appendMessage({
      threadId, userId: 'g_abc', role: 'user', content: 'hi', text: 'hi', clientMessageId: 'dup',
    });
    const retry = await store.appendMessage({
      threadId, userId: 'g_abc', role: 'user', content: 'hi', text: 'hi', clientMessageId: 'dup',
    });
    expect(retry.seq).toBe(first.seq);
    expect(retry.deduped).toBe(true);
    expect(db.messages.length).toBe(1);
    expect(db.threads.get(threadId)?.lastSeq).toBe(1);
  });

  it('persists role, content, text, and idempotency key on the row', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    const threadId = await store.ensureThread({ userId: 'g_abc', appId: 'app_1', region: 'us-east-1' });
    await store.appendMessage({
      threadId, userId: 'g_abc', role: 'agent',
      content: { kind: 'text', text: 'answer' }, text: 'answer', clientMessageId: 'm1',
    });
    const row = db.messages[0]!;
    expect(row).toMatchObject({
      threadId, seq: 1, userId: 'g_abc', authorRole: 'agent', kind: 'text',
      text: 'answer', clientMessageId: 'm1',
    });
    expect(row.content).toEqual({ kind: 'text', text: 'answer' });
  });
});

describe('ThreadStore.loadHistory', () => {
  it('returns prior messages in seq-ascending order, projected', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    const threadId = await store.ensureThread({ userId: 'g_abc', appId: 'app_1', region: 'us-east-1' });
    await store.appendMessage({ threadId, userId: 'g_abc', role: 'user', content: 'q1', text: 'q1', clientMessageId: 'c1' });
    await store.appendMessage({ threadId, userId: 'g_abc', role: 'agent', content: 'a1', text: 'a1', clientMessageId: 'c2' });

    const history = await store.loadHistory(threadId);
    expect(history.map((m) => [m.seq, m.authorRole, m.text])).toEqual([
      [1, 'user', 'q1'],
      [2, 'agent', 'a1'],
    ]);
  });

  it('caps to the most-recent N (still seq-ASC) and isolates by thread', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    const threadId = await store.ensureThread({ userId: 'g_abc', appId: 'app_1', region: 'us-east-1' });
    for (let i = 1; i <= 5; i += 1) {
      await store.appendMessage({
        threadId, userId: 'g_abc', role: 'user', content: `m${i}`, text: `m${i}`, clientMessageId: `c${i}`,
      });
    }
    // A second thread's messages must not leak in.
    const other = await store.ensureThread({ userId: 'g_xyz', appId: 'app_1', region: 'us-east-1' });
    await store.appendMessage({ threadId: other, userId: 'g_xyz', role: 'user', content: 'x', text: 'x', clientMessageId: 'x1' });

    const recent = await store.loadHistory(threadId, 3);
    expect(recent.map((m) => m.text)).toEqual(['m3', 'm4', 'm5']);
  });

  it('returns empty history for a brand-new thread', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    const threadId = await store.ensureThread({ userId: 'g_abc', appId: 'app_1', region: 'us-east-1' });
    expect(await store.loadHistory(threadId)).toEqual([]);
  });
});

describe('ThreadStore.appendFold', () => {
  it('appends one row per message + one card row per artifact, in seq order', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    await db.createThread(makeThreadRow('t1', 'g_abc'));
    const fold: AgReduceResult = {
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          turnId: 'turn1',
          threadId: 't1',
        },
      ],
      artifacts: [
        {
          artifactId: 'a1',
          turnId: 'turn1',
          threadId: 't1',
          parts: [{ type: 'text', text: '{}' }],
        },
      ],
      memory: [{ scope: 'thread', key: 'k', value: 'v' }],
      turns: [{ turnId: 'turn1', threadId: 't1', finishReason: 'stop' }],
      state: { step: 1 },
    };
    const res = await store.appendFold({
      threadId: 't1',
      userId: 'g_abc',
      fold,
      clientMessageIdBase: 'cmid',
    });
    expect(res.messageSeqs).toHaveLength(1);
    expect(res.artifactSeqs).toHaveLength(1);
    expect(res.deduped).toBe(false);
    // message row before card row (creation order)
    expect(res.messageSeqs[0]).toBeLessThan(res.artifactSeqs[0]!);

    // The FIRST row written (the message) claims the turn-level sentinel key.
    const msgRow = db.messages.find((m) => m.kind !== 'card');
    expect(msgRow?.clientMessageId).toBe('cmid#agentTurn');
    // The card row, written after, uses its per-index key.
    const cardRow = db.messages.find((m) => m.kind === 'card');
    expect(cardRow?.clientMessageId).toBe('cmid#card#0');
  });

  it('upserts the snapshot with thread-scoped memory + working state', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    await db.createThread(makeThreadRow('t1', 'g_abc'));
    const fold: AgReduceResult = {
      messages: [],
      artifacts: [],
      memory: [
        { scope: 'thread', key: 'k', value: 'v' },
        { scope: 'user', key: 'durable', value: 'x' }, // must be dropped from snapshot
      ],
      turns: [],
      state: { step: 2 },
    };
    const res = await store.appendFold({
      threadId: 't1',
      userId: 'g_abc',
      fold,
      clientMessageIdBase: 'cmid',
    });
    expect(res.droppedDurableMemory).toBe(1);
    const snap = await store.getSnapshot('t1');
    expect(snap?.workingState).toEqual({ step: 2 });
    expect(snap?.threadMemory).toEqual([{ scope: 'thread', key: 'k', value: 'v' }]);
  });

  it('is idempotent on a retried IDENTICAL fold (same clientMessageIdBase → no dup rows)', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    await db.createThread(makeThreadRow('t1', 'g_abc'));
    const fold: AgReduceResult = {
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          turnId: 'turn1',
          threadId: 't1',
        },
      ],
      artifacts: [],
      memory: [],
      turns: [],
    };
    const first = await store.appendFold({ threadId: 't1', userId: 'g_abc', fold, clientMessageIdBase: 'cmid' });
    const second = await store.appendFold({ threadId: 't1', userId: 'g_abc', fold, clientMessageIdBase: 'cmid' });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    const rows = await db.listRecentMessages('t1', 100);
    expect(rows.filter((r) => r.kind !== 'card')).toHaveLength(1);
  });

  it('is idempotent on a RERUN with a DIFFERENT fold (turn-level gate — no Frankenstein/orphans)', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    await db.createThread(makeThreadRow('t1', 'g_abc'));
    // First run: a 2-message fold.
    const foldA: AgReduceResult = {
      messages: [
        { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'one' }], turnId: 'turn1', threadId: 't1' },
        { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'two' }], turnId: 'turn1', threadId: 't1' },
      ],
      artifacts: [],
      memory: [],
      turns: [{ turnId: 'turn1', threadId: 't1', finishReason: 'stop' }],
    };
    const first = await store.appendFold({ threadId: 't1', userId: 'g_abc', fold: foldA, clientMessageIdBase: 'cmid' });
    expect(first.deduped).toBe(false);
    const agentRowsAfterFirst = (await db.listRecentMessages('t1', 100)).filter((r) => r.kind !== 'card');
    expect(agentRowsAfterFirst).toHaveLength(2);

    // RERUN: the LLM re-ran → a DIFFERENT fold (1 message, different content),
    // SAME clientMessageIdBase. Per-index dedup would keep row 0 and append a
    // NEW row → Frankenstein. Turn-level idempotency must short-circuit entirely.
    const foldB: AgReduceResult = {
      messages: [
        { id: 'm9', role: 'assistant', content: [{ type: 'text', text: 'totally different' }], turnId: 'turn2', threadId: 't1' },
      ],
      artifacts: [],
      memory: [],
      turns: [{ turnId: 'turn2', threadId: 't1', finishReason: 'stop' }],
    };
    const second = await store.appendFold({ threadId: 't1', userId: 'g_abc', fold: foldB, clientMessageIdBase: 'cmid' });
    expect(second.deduped).toBe(true);
    // The whole second fold was short-circuited — NO new rows of any kind.
    const allRows = await db.listRecentMessages('t1', 100);
    expect(allRows.filter((r) => r.kind !== 'card')).toHaveLength(2); // unchanged — no orphan row 1
    expect(allRows.some((r) => r.text === 'totally different')).toBe(false);
    // The dedup result echoes the sentinel row's seq.
    expect(second.messageSeqs).toEqual([first.messageSeqs[0]]);
    expect(second.artifactSeqs).toEqual([]);
  });

  it('skipSnapshot:true writes rows but does NOT overwrite the snapshot', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    await db.createThread(makeThreadRow('t1', 'g_abc'));
    // Seed a known-good prior snapshot.
    const priorSnap: ThreadSnapshotRow = {
      threadId: 't1',
      userId: 'g_abc',
      threadMemory: [{ scope: 'thread', key: 'good', value: 'prior' }],
      workingState: { step: 99 },
      updatedAt: '2026-06-24T00:00:00.000Z',
    };
    await db.putSnapshot(priorSnap);

    const fold: AgReduceResult = {
      messages: [
        { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'degraded' }], turnId: 'turn1', threadId: 't1' },
      ],
      artifacts: [],
      memory: [{ scope: 'thread', key: 'new', value: 'should-not-land' }],
      turns: [{ turnId: 'turn1', threadId: 't1', finishReason: 'stop' }],
      state: { step: 1 },
    };
    const res = await store.appendFold({
      threadId: 't1',
      userId: 'g_abc',
      fold,
      clientMessageIdBase: 'cmid',
      skipSnapshot: true,
    });
    // Rows WERE written.
    expect(res.messageSeqs).toHaveLength(1);
    const rows = await db.listRecentMessages('t1', 100);
    expect(rows.filter((r) => r.kind !== 'card')).toHaveLength(1);
    // Snapshot is UNCHANGED — putSnapshot was not called.
    const snap = await store.getSnapshot('t1');
    expect(snap).toEqual(priorSnap);
  });
});

describe('ThreadStore guuey#86 — UI-card projection, prompt-lane filter, preview preservation', () => {
  const uiResource = { uri: 'ui://checklist/1', mimeType: 'text/html', text: '<html>card</html>' };
  const uiToolResultMsg = {
    id: 'm1',
    role: 'assistant' as const,
    content: [
      { type: 'tool-call' as const, toolCallId: 'c1', name: 'render', input: {} },
      { type: 'tool-result' as const, toolCallId: 'c1', content: [], uiData: uiResource },
    ],
    turnId: 'turn1',
    threadId: 't1',
  };

  const foldWith = (overrides: Partial<AgReduceResult>): AgReduceResult => ({
    messages: [uiToolResultMsg],
    artifacts: [],
    memory: [],
    turns: [{ turnId: 'turn1', threadId: 't1', finishReason: 'stop' }],
    ...overrides,
  });

  it('appendFold persists a card row projected from a UI tool-result (no artifact events)', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    await db.createThread(makeThreadRow('t1', 'g_abc'));
    const res = await store.appendFold({
      threadId: 't1',
      userId: 'g_abc',
      fold: foldWith({}),
      clientMessageIdBase: 'cmid',
    });
    expect(res.artifactSeqs).toHaveLength(1);
    const cardRow = db.messages.find((r) => r.kind === 'card');
    expect(cardRow?.cardSnapshot).toMatchObject({ artifactId: 'm1#ui#1' });
  });

  it('appendFold dedupes a projected card whose artifactId is already in fold.artifacts (reassemble→re-persist)', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    await db.createThread(makeThreadRow('t1', 'g_abc'));
    const projected = {
      artifactId: 'm1#ui#1',
      turnId: 'turn1',
      threadId: 't1',
      parts: [uiToolResultMsg.content[1]!],
    };
    const res = await store.appendFold({
      threadId: 't1',
      userId: 'g_abc',
      fold: foldWith({ artifacts: [projected] }),
      clientMessageIdBase: 'cmid',
    });
    expect(res.artifactSeqs).toHaveLength(1);
    expect(db.messages.filter((r) => r.kind === 'card')).toHaveLength(1);
  });

  it('loadHistory drops card rows (prompt lane) while text rows survive', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    await db.createThread(makeThreadRow('t1', 'g_abc'));
    await store.appendMessage({
      threadId: 't1',
      userId: 'g_abc',
      role: 'user',
      content: 'show my checklist',
      text: 'show my checklist',
      clientMessageId: 'u1',
    });
    await store.appendFold({
      threadId: 't1',
      userId: 'g_abc',
      fold: foldWith({}),
      clientMessageIdBase: 'cmid',
    });
    const history = await store.loadHistory('t1');
    expect(history.some((h) => h.kind === 'card')).toBe(false);
    expect(history.some((h) => h.text === 'show my checklist')).toBe(true);
  });

  it('a card-producing turn leaves the user-text preview standing (no clobber to "card" or "")', async () => {
    const db = new FakePersistence();
    const store = new ThreadStore(db);
    await db.createThread(makeThreadRow('t1', 'g_abc'));
    await store.appendMessage({
      threadId: 't1',
      userId: 'g_abc',
      role: 'user',
      content: 'show my checklist',
      text: 'show my checklist',
      clientMessageId: 'u1',
    });
    // The canonical card turn: agent message has tool blocks only, no text.
    await store.appendFold({
      threadId: 't1',
      userId: 'g_abc',
      fold: foldWith({}),
      clientMessageIdBase: 'cmid',
    });
    const thread = await db.getThread('t1');
    expect(thread?.lastMessagePreview).toBe('show my checklist');
  });
});
