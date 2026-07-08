import { describe, expect, it } from 'vitest';
import { tokensFromCallback } from './login.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Build a decodable `ggui_pat_` token: `ggui_pat_<base64url(payload)>.<sig>`. */
function makePat(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `ggui_pat_${encoded}.signature`;
}

describe('tokensFromCallback', () => {
  it('accepts a guuey_user_ API key and honors the callback expiresAt', () => {
    const expiresAt = '2026-10-01T00:00:00.000Z';
    const tokens = tokensFromCallback('guuey_user_abc123', expiresAt);
    // Opaque key: stored verbatim with the given expiry, no invented identity.
    expect(tokens).toEqual({ pat: 'guuey_user_abc123', expiresAt });
  });

  it('does not attach identity fields for an opaque API key', () => {
    const tokens = tokensFromCallback('guuey_user_abc123', '2026-10-01T00:00:00.000Z');
    expect(tokens?.email).toBeUndefined();
    expect(tokens?.userId).toBeUndefined();
  });

  it('falls back to a +90d expiry when the callback omits expiresAt', () => {
    const before = Date.now();
    const tokens = tokensFromCallback('guuey_user_abc123');
    expect(tokens?.pat).toBe('guuey_user_abc123');
    const deltaMs = new Date(tokens?.expiresAt ?? 0).getTime() - before;
    expect(deltaMs).toBeGreaterThan(89 * DAY_MS);
    expect(deltaMs).toBeLessThan(91 * DAY_MS);
  });

  it('falls back to a +90d expiry when the callback expiresAt is unparseable', () => {
    const before = Date.now();
    const tokens = tokensFromCallback('guuey_user_abc123', 'not-a-real-date');
    const deltaMs = new Date(tokens?.expiresAt ?? 0).getTime() - before;
    expect(deltaMs).toBeGreaterThan(89 * DAY_MS);
    expect(deltaMs).toBeLessThan(91 * DAY_MS);
  });

  it('decodes a ggui_pat_ token for identity and honors the callback expiresAt', () => {
    const exp = Math.floor(Date.parse('2026-10-01T00:00:00.000Z') / 1000);
    const pat = makePat({ sub: 'user-123', email: 'dev@example.com', exp });
    const bodyExpiry = '2026-09-01T00:00:00.000Z';
    const tokens = tokensFromCallback(pat, bodyExpiry);
    expect(tokens).toEqual({
      pat,
      expiresAt: bodyExpiry,
      email: 'dev@example.com',
      userId: 'user-123',
    });
  });

  it('derives ggui_pat_ expiry from the decoded payload when the callback omits expiresAt', () => {
    const exp = Math.floor(Date.parse('2026-10-01T00:00:00.000Z') / 1000);
    const pat = makePat({ sub: 'user-123', email: 'dev@example.com', exp });
    const tokens = tokensFromCallback(pat);
    expect(tokens?.expiresAt).toBe('2026-10-01T00:00:00.000Z');
    expect(tokens?.userId).toBe('user-123');
  });

  it('returns null for a token with an unrecognized prefix', () => {
    expect(tokensFromCallback('nope_xyz', '2026-10-01T00:00:00.000Z')).toBeNull();
  });

  it('returns null for an empty token', () => {
    expect(tokensFromCallback('', '2026-10-01T00:00:00.000Z')).toBeNull();
  });
});
