/**
 * auth seam tests — focused on the guuey#182 fix: the `GUUEY_API_KEY`
 * per-invocation override must win over the stored login for the cliApi
 * command family (`requireAuth`) and satisfy the pre-checks (`isLoggedIn`).
 * The stored-login file paths are NOT exercised here (they'd touch the real
 * `~/.guuey/auth.json`); the override branch never reads the file, which is
 * exactly the property under test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isLoggedIn, requireAuth } from './auth';

const KEY = 'GUUEY_API_KEY';

describe('GUUEY_API_KEY override (guuey#182)', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('requireAuth returns the override as the pat, without touching stored login', () => {
    process.env[KEY] = 'eyJ-not-a-guuey-user-pat';
    const auth = requireAuth();
    expect(auth.pat).toBe('eyJ-not-a-guuey-user-pat');
  });

  it('override carries a future synthetic expiresAt (callers only read .pat)', () => {
    process.env[KEY] = 'guuey_user_override';
    const auth = requireAuth();
    expect(new Date(auth.expiresAt) > new Date()).toBe(true);
  });

  it('isLoggedIn is true under the override — pre-checks must not force an interactive login', () => {
    process.env[KEY] = 'guuey_user_override';
    expect(isLoggedIn()).toBe(true);
  });

  it('an empty override does NOT count (falls through to stored login)', () => {
    process.env[KEY] = '';
    // With no override, requireAuth consults the stored login; we only
    // assert the override branch did not swallow the empty string as a key.
    try {
      const auth = requireAuth();
      expect(auth.pat).not.toBe('');
    } catch (err) {
      expect((err as Error).message).toMatch(/log(ged)? in|expired/i);
    }
  });
});
