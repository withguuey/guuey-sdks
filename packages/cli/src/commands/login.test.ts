import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  pasteAuthorizeUrl,
  tokensFromCallback,
  waitForCallback,
  waitForPastedToken,
} from './login.js';
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

// guuey#180 — device-code-style paste fallback: on remote sessions (SSH,
// devcontainer, CI box) the browser's localhost redirect lands on the wrong
// machine, so a token pasted on stdin must be a first-class channel.
describe('waitForPastedToken — paste fallback (guuey#180)', () => {
  it('resolves on a valid guuey_user_ paste with the nominal +90d expiry', async () => {
    const input = new PassThrough();
    const promise = waitForPastedToken(undefined, input);
    const before = Date.now();
    input.write('guuey_user_pasted123\n');
    const tokens = await promise;
    expect(tokens.pat).toBe('guuey_user_pasted123');
    const deltaMs = new Date(tokens.expiresAt).getTime() - before;
    expect(deltaMs).toBeGreaterThan(89 * DAY_MS);
    expect(deltaMs).toBeLessThan(91 * DAY_MS);
  });

  it('trims surrounding whitespace from the paste', async () => {
    const input = new PassThrough();
    const promise = waitForPastedToken(undefined, input);
    input.write('   guuey_user_padded  \n');
    const tokens = await promise;
    expect(tokens.pat).toBe('guuey_user_padded');
  });

  it('re-prompts on an invalid paste instead of resolving or rejecting', async () => {
    const input = new PassThrough();
    const promise = waitForPastedToken(undefined, input);
    input.write('ggui_pat_retired.token\n');
    input.write('\n');
    // Still pending after the bad + empty lines...
    const pending = await Promise.race([
      promise.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    expect(pending).toBe('pending');
    // ...and a subsequent valid paste wins.
    input.write('guuey_user_second_try\n');
    const tokens = await promise;
    expect(tokens.pat).toBe('guuey_user_second_try');
  });

  it('an aborted signal releases the input stream (race loser teardown)', async () => {
    const input = new PassThrough();
    const abort = new AbortController();
    void waitForPastedToken(abort.signal, input);
    abort.abort();
    // The reader is gone: a post-abort paste is not consumed as a token
    // (nothing to observe on the promise — it stays forever pending by
    // design) and the stream is paused so the event loop can drain.
    expect(input.isPaused()).toBe(true);
  });
});

describe('pasteAuthorizeUrl — the --no-browser authorize URL', () => {
  it('carries mode=paste and neither state nor callback', () => {
    const url = new URL(pasteAuthorizeUrl('https://dev.guuey.com'));
    expect(url.origin).toBe('https://dev.guuey.com');
    expect(url.pathname).toBe('/cli/authorize');
    expect(url.searchParams.get('mode')).toBe('paste');
    expect(url.searchParams.has('state')).toBe(false);
    expect(url.searchParams.has('callback')).toBe(false);
  });
});
