import { describe, expect, it } from 'vitest';
import { tokensFromCallback, waitForCallback } from './login.js';
import { CLI_CALLBACK_PORT } from '../auth.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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

  it('rejects a retired ggui_pat_ token — returns null with or without a callback expiresAt', () => {
    // `ggui_pat_` was the old HMAC dashboard PAT; the contract is retired and
    // such a bearer 401s at the cliApi, so the callback must never store it.
    const pat = 'ggui_pat_eyJzdWIiOiJ1c2VyLTEyMyJ9.signature';
    expect(tokensFromCallback(pat, '2026-09-01T00:00:00.000Z')).toBeNull();
    expect(tokensFromCallback(pat)).toBeNull();
  });

  it('returns null for a token with an unrecognized prefix', () => {
    expect(tokensFromCallback('nope_xyz', '2026-10-01T00:00:00.000Z')).toBeNull();
  });

  it('returns null for an empty token', () => {
    expect(tokensFromCallback('', '2026-10-01T00:00:00.000Z')).toBeNull();
  });
});

// PNA regression coverage: Chrome's Local-Network-Access preflight gates the
// callback POST (the auth page runs on a public origin; this server is
// localhost) behind an OPTIONS request that must carry
// `Access-Control-Allow-Private-Network: true`, or Chrome silently blocks
// the follow-up POST and `guuey login` hangs waiting for a callback that
// never arrives.
describe('waitForCallback — OPTIONS preflight (Chrome PNA, spec §3.3)', () => {
  it('the OPTIONS response carries Access-Control-Allow-Private-Network: true', async () => {
    const state = 'pna-test-state';
    const tokenPromise = waitForCallback(state);

    try {
      const res = await fetch(`http://localhost:${CLI_CALLBACK_PORT}/callback`, {
        method: 'OPTIONS',
      });
      expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    } finally {
      // Complete the flow so the server closes and the 5-minute timeout
      // timer is cleared — otherwise it would keep the process alive.
      await fetch(`http://localhost:${CLI_CALLBACK_PORT}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, pat: 'guuey_user_test123' }),
      });
      await tokenPromise;
    }
  });
});
