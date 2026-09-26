/**
 * The split's invariant: every report the core reader returns sits at a
 * top-level index, and readable + omitted accounts for every stored element.
 * A reader that breaks it cannot be paired element by element, so the split
 * carries the whole stored array and seeds nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@silverprotocol/core';

type StoredRead = ReturnType<typeof import('@silverprotocol/core').readStoredAgMemoryRecords>;
const readStub = vi.hoisted(() => ({ result: undefined as undefined | StoredRead }));

vi.mock('@silverprotocol/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@silverprotocol/core')>();
  return {
    ...actual,
    readStoredAgMemoryRecords: (stored: readonly JsonValue[]) => readStub.result ?? actual.readStoredAgMemoryRecords(stored),
  };
});

const { splitStoredThreadMemory } = await import('./fold-rows.js');

const STORED: JsonValue[] = [
  { scope: 'thread', key: 'a', value: 1 },
  { scope: 'thread', key: 'b', value: 2 },
];

describe('splitStoredThreadMemory — the invariant fallback', () => {
  it('pairs normally when the reader accounts for every element', () => {
    readStub.result = undefined;
    const split = splitStoredThreadMemory(STORED);
    expect(split.threadMemory).toHaveLength(2);
    expect(split.carriedThreadMemory).toEqual([]);
  });

  it('carries everything and seeds nothing when a report is not at a top-level index', () => {
    readStub.result = { value: [{ scope: 'thread', key: 'a', value: 1 }], reports: [{ path: [1, 'value'], raw: STORED[1] ?? null }] };
    const split = splitStoredThreadMemory(STORED);
    expect(split.threadMemory).toEqual([]);
    expect(split.carriedThreadMemory).toEqual(STORED);
  });

  it('carries everything when readable + omitted does not account for the stored length', () => {
    // Two readable + one omitted for two stored: pairing would misattribute `a` to stored[1].
    readStub.result = {
      value: [{ scope: 'thread', key: 'a', value: 1 }, { scope: 'thread', key: 'b', value: 2 }],
      reports: [{ path: [0], raw: STORED[0] ?? null }],
    };
    const split = splitStoredThreadMemory(STORED);
    expect(split.threadMemory).toEqual([]);
    expect(split.carriedThreadMemory).toEqual(STORED);
  });

  it('carries everything when two reports name the same index', () => {
    // The lengths add up (1 readable + 1 distinct index), but two reports share one index.
    readStub.result = {
      value: [{ scope: 'thread', key: 'b', value: 2 }],
      reports: [{ path: [0], raw: STORED[0] ?? null }, { path: [0], raw: STORED[0] ?? null }],
    };
    const split = splitStoredThreadMemory(STORED);
    expect(split.threadMemory).toEqual([]);
    expect(split.carriedThreadMemory).toEqual(STORED);
  });
});
