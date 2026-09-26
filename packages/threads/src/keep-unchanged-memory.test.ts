import { describe, expect, it } from 'vitest';
import { Reducer, type AgEvent, type AgMemoryRecord } from '@silverprotocol/core';
import { keepUnchangedThreadMemory } from './fold-rows.js';
import { seedEventsForReducer, ThreadStore, type ThreadRow } from './index.js';
import { InMemoryThreadPersistence } from './in-memory.js';

/**
 * guuey#1669: a thread-memory record a turn did not change is persisted as the
 * record it was stored with, members this runtime does not know included,
 * never as the fold's rebuild of it.
 */

/** A stored record carrying a member this runtime does not know (it rides the raw read). */
function withUnknownMember(rec: AgMemoryRecord, member: { [name: string]: string | number }): AgMemoryRecord {
  return Object.assign({ ...rec }, member);
}

describe('keepUnchangedThreadMemory', () => {
  const city: AgMemoryRecord = { scope: 'thread', key: 'city', value: 'Lisbon', turnId: 't1' };

  it('an unchanged record is the PRIOR record, its unknown member kept', () => {
    const prior = withUnknownMember(city, { provenance: 'import' });
    const out = keepUnchangedThreadMemory([prior], [{ ...city }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(prior);
  });

  it('a changed value, reason or durability is the fold\'s record', () => {
    const prior = withUnknownMember(city, { provenance: 'import' });
    for (const folded of [
      { ...city, value: 'Porto' },
      { ...city, reason: 'the builder said so' },
      { ...city, durable: true },
    ]) {
      expect(keepUnchangedThreadMemory([prior], [folded])[0]).toBe(folded);
    }
  });

  it('a turn that rewrites the SAME value stamps a new turnId: the record changed, the fold wins', () => {
    const prior = withUnknownMember(city, { provenance: 'import' });
    const rewritten: AgMemoryRecord = { ...city, turnId: 't2' };
    expect(keepUnchangedThreadMemory([prior], [rewritten])[0]).toBe(rewritten);
  });

  it('threadId is not compared: the seed cannot carry it and no turn can set it, so a stored one is kept', () => {
    const prior: AgMemoryRecord = withUnknownMember({ ...city, threadId: 'th-1' }, { provenance: 'import' });
    const seeded: AgMemoryRecord = { ...city };
    const out = keepUnchangedThreadMemory([prior], [seeded]);
    expect(out[0]).toBe(prior);
    expect(out[0]?.threadId).toBe('th-1');
  });

  it('values compare structurally: object key order does not change a record', () => {
    const prior: AgMemoryRecord = withUnknownMember({ scope: 'thread', key: 'prefs', value: { a: 1, b: [1, { c: 2 }] }, turnId: 't1' }, { provenance: 'import' });
    const folded: AgMemoryRecord = { scope: 'thread', key: 'prefs', value: { b: [1, { c: 2 }], a: 1 }, turnId: 't1' };
    expect(keepUnchangedThreadMemory([prior], [folded])[0]).toBe(prior);
    const nested: AgMemoryRecord = { ...folded, value: { a: 1, b: [1, { c: 3 }] } };
    expect(keepUnchangedThreadMemory([prior], [nested])[0]).toBe(nested);
  });

  it('identity is the reducer\'s: a key-less record meets the LAST stored key-less record of its scope', () => {
    const first = withUnknownMember({ scope: 'thread', value: 'old', turnId: 't1' }, { provenance: 'first' });
    const last = withUnknownMember({ scope: 'thread', value: 'kept', turnId: 't2' }, { provenance: 'last' });
    const folded: AgMemoryRecord = { scope: 'thread', value: 'kept', turnId: 't2' };
    expect(keepUnchangedThreadMemory([first, last], [folded])[0]).toBe(last);
  });

  it('a record the turn added is the fold\'s own; one it removed stays absent', () => {
    const prior = withUnknownMember(city, { provenance: 'import' });
    const added: AgMemoryRecord = { scope: 'thread', key: 'tone', value: 'brief', turnId: 't2' };
    expect(keepUnchangedThreadMemory([prior], [added])).toEqual([added]);
  });
});

describe('ThreadStore.appendFold keeps what a turn did not touch (the measured residual)', () => {
  const NOW = '2026-09-26T00:00:00.000Z';
  const thread: ThreadRow = {
    id: 't1', userId: 'u1', appId: 'a1', servingRegion: 'us-east-1', title: 'x', status: 'active',
    pinned: false, lastSeq: 0, lastMessageAt: NOW, lastMessagePreview: '', threadMode: 'single', createdAt: NOW, updatedAt: NOW,
  };

  /** The pod's cycle: read the snapshot, seed the reducer, run one turn, append the fold. */
  async function oneTurn(db: InMemoryThreadPersistence, turn: AgEvent[], passPrior: boolean): Promise<void> {
    const store = new ThreadStore(db);
    const prior = await db.getSnapshot('t1');
    const reducer = new Reducer();
    for (const seed of seedEventsForReducer(prior?.workingState, prior?.threadMemory ?? [])) reducer.push(seed);
    for (const ev of turn) reducer.push(ev);
    await store.appendFold({
      threadId: 't1',
      userId: 'u1',
      fold: reducer.result(),
      clientMessageIdBase: `c-${turn.length}-${passPrior}`,
      ...(passPrior && prior !== undefined ? { priorThreadMemory: prior.threadMemory } : {}),
    });
  }

  it('a record another key\'s write did not touch keeps its unknown member across the turn', async () => {
    const db = new InMemoryThreadPersistence();
    await db.createThread(thread);
    const stored = withUnknownMember({ scope: 'thread', key: 'city', value: 'Lisbon', turnId: 't1' }, { provenance: 'import' });
    await db.putSnapshot({ threadId: 't1', userId: 'u1', updatedAt: NOW, threadMemory: [stored] });

    await oneTurn(db, [{ seq: 0, type: 'memory.write', scope: 'thread', key: 'tone', value: 'brief', turnId: 't2' }], true);

    const after = await db.getSnapshot('t1');
    expect(after?.threadMemory).toEqual([stored, { scope: 'thread', key: 'tone', value: 'brief', turnId: 't2' }]);
    expect(after?.threadMemory[0]).toHaveProperty('provenance', 'import');
  });

  it('a caller that passes no prior view gets today\'s fold as it is (the member is rebuilt away)', async () => {
    const db = new InMemoryThreadPersistence();
    await db.createThread(thread);
    const stored = withUnknownMember({ scope: 'thread', key: 'city', value: 'Lisbon', turnId: 't1' }, { provenance: 'import' });
    await db.putSnapshot({ threadId: 't1', userId: 'u1', updatedAt: NOW, threadMemory: [stored] });

    await oneTurn(db, [{ seq: 0, type: 'memory.write', scope: 'thread', key: 'tone', value: 'brief', turnId: 't2' }], false);

    const after = await db.getSnapshot('t1');
    expect(after?.threadMemory[0]).not.toHaveProperty('provenance');
  });
});
