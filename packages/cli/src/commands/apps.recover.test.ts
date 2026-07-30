/**
 * `guuey apps recover` (guuey#41) — the undo for `guuey apps archive`.
 *
 * This command used to be a `notYetAvailable` stub and lived in
 * `unshipped.test.ts`; it moved here when `POST /v1/apps/:id/recover`
 * shipped. What is worth pinning is the part a network round trip would
 * hide: the command has to tell the builder two things it would be easy to
 * leave out, because both are states they will otherwise discover as a
 * failure later.
 *
 *   - **Billing did not come back.** Archive cancelled the subscription and
 *     recover does not resubscribe — that is a charge, and consent to be
 *     charged comes from checkout. Unsaid, the builder finds out when their
 *     next paid-size deploy is refused by the tier gate.
 *   - **Which way the signing key went.** "Restored" and "still revoked,
 *     because you revoked it yourself" need different next steps, and only
 *     the response knows which applies.
 *
 * Mocking mirrors `apps.test.ts`: `apps.ts` builds its own `apiRequest` from
 * `requireAuth()` + `resolveConfig()` + `fetch`, so those two are mocked and
 * `globalThis.fetch` is spied for the wire assertions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { appsRecover } from './apps.js';

vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return {
    ...actual,
    requireAuth: vi.fn(() => ({
      pat: 'pat-test',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })),
  };
});

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    resolveConfig: vi.fn(() => ({
      host: 'https://guuey.test',
      apiUrl: 'https://api.guuey.test',
    })),
  };
});

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function recoverResponse(
  signingKey: 'restored' | 'already-live' | 'left-revoked' | 'no-enrolment' | 'unprovisioned',
): Response {
  return new Response(
    JSON.stringify({
      recovered: true,
      appId: 'app-1',
      requestedAt: '2026-07-20T00:00:00.000Z',
      signingKey,
    }),
    { status: 200 },
  );
}

describe('appsRecover', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Everything the command wrote to stdout, as one string. */
  function output(): string {
    return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  }

  it('POSTs to the recover route — no longer the roadmap stub', async () => {
    fetchSpy.mockResolvedValue(recoverResponse('restored'));

    await appsRecover('app-1', {});

    const call = fetchSpy.mock.calls.at(-1);
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(new URL(String(url)).pathname).toBe('/apps/app-1/recover');
    expect(init?.method).toBe('POST');
  });

  it('says billing was not resumed, on every outcome', async () => {
    fetchSpy.mockResolvedValue(recoverResponse('restored'));

    await appsRecover('app-1', {});

    expect(output()).toMatch(/billing was not resumed/i);
    expect(output()).toMatch(/free-tier/i);
  });

  it('tells the builder their embeds need no changes when the key came back', async () => {
    fetchSpy.mockResolvedValue(recoverResponse('restored'));

    await appsRecover('app-1', {});

    expect(output()).toMatch(/signing key is live again/i);
  });

  it('points at re-enrolment when the builder revoked the key themselves', async () => {
    // Restore deliberately does not reverse a builder-owned revoke, so the
    // only way back is `widget keys create` — and that mints a NEW app
    // secret, which the message has to warn about or the builder will
    // re-enrol and wonder why their token endpoint stopped working.
    fetchSpy.mockResolvedValue(recoverResponse('left-revoked'));

    await appsRecover('app-1', {});

    expect(output()).toMatch(/stays revoked/i);
    expect(output()).toMatch(/guuey widget keys create/);
    expect(output()).toMatch(/new app secret/i);
  });

  it('--json emits the raw response and no prose', async () => {
    fetchSpy.mockResolvedValue(recoverResponse('restored'));

    await appsRecover('app-1', { json: true });

    expect(output()).not.toMatch(/billing was not resumed/i);
    const printed = JSON.parse(output()) as { signingKey: string; appId: string };
    expect(printed).toMatchObject({ appId: 'app-1', signingKey: 'restored' });
  });

  it('requires an app id', async () => {
    await expect(appsRecover(undefined, {})).rejects.toBeInstanceOf(ExitSignal);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
