import { describe, expect, it } from 'vitest';
import { COLOCATED_ORIGIN, colocatedResourceUrl, isValidColocatedServerName } from './colocated.js';

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

  it('lives on COLOCATED_ORIGIN — the exported constant origin-filter consumers (stateApi admin-ownership) rely on', () => {
    expect(new URL(colocatedResourceUrl('app1', 'notes')).origin).toBe(COLOCATED_ORIGIN);
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

describe('isValidColocatedServerName', () => {
  it('accepts letters, digits, hyphen, underscore', () => {
    expect(isValidColocatedServerName('notes')).toBe(true);
    expect(isValidColocatedServerName('Notes-2')).toBe(true);
    expect(isValidColocatedServerName('my_tool_v1')).toBe(true);
  });

  it('rejects a name with a space', () => {
    expect(isValidColocatedServerName('my tool')).toBe(false);
  });

  it('rejects a name with a slash', () => {
    expect(isValidColocatedServerName('a/b')).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(isValidColocatedServerName('')).toBe(false);
  });

  it('is the exact predicate colocatedResourceUrl enforces (single source of truth)', () => {
    // Any name isValidColocatedServerName rejects must also make
    // colocatedResourceUrl throw, and vice versa — same regex, no drift.
    for (const name of ['ok-name', 'bad name', 'a/b', '']) {
      const valid = isValidColocatedServerName(name);
      if (valid) {
        expect(() => colocatedResourceUrl('app1', name)).not.toThrow();
      } else {
        expect(() => colocatedResourceUrl('app1', name)).toThrow();
      }
    }
  });
});
