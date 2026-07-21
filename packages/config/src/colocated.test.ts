import { describe, expect, it } from 'vitest';
import { colocatedResourceUrl } from './colocated.js';

/**
 * Copied-in predicate of `backend/amplify/functions/oidcMint/handler.ts`'s
 * `parseMcpResourceUrl` — pinned EXACTLY (3 checks, in order): a string,
 * ≤512 chars (`MAX_LEN.mcpResourceUrl`), and matching
 * `/^https:\/\/.+\/$/` (https prefix, trailing slash). Keep this predicate
 * byte-for-byte in sync with the handler if that rule ever changes.
 */
function satisfiesOidcMintRule(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length > 512) return false;
  return /^https:\/\/.+\/$/.test(value);
}

describe('colocatedResourceUrl', () => {
  it('composes the synthetic resource URL', () => {
    expect(colocatedResourceUrl('app1', 'notes')).toBe(
      'https://colocated.guuey.com/app1/notes/',
    );
  });

  it('satisfies the oidcMint parseMcpResourceUrl rule', () => {
    expect(satisfiesOidcMintRule(colocatedResourceUrl('app1', 'notes'))).toBe(true);
  });

  it('rejects an appId with a space', () => {
    expect(() => colocatedResourceUrl('a b', 'notes')).toThrow();
  });

  it('rejects a serverName containing a slash', () => {
    expect(() => colocatedResourceUrl('app1', 'a/b')).toThrow();
  });

  it('rejects an empty appId', () => {
    expect(() => colocatedResourceUrl('', 'notes')).toThrow();
  });

  it('rejects an empty serverName', () => {
    expect(() => colocatedResourceUrl('app1', '')).toThrow();
  });
});
