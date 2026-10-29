/**
 * `guuey env set` — the runtime-reserved names (`@guuey/config`
 * RUNTIME_RESERVED_ENV_NAMES, the one list `guuey deploy` and the host apply)
 * are refused before any request; every other name is sent as before. The
 * list itself is pinned to the platform's by `@guuey/config`'s own
 * `reserved-env.test.ts`.
 *
 * Same harness as `agent.test.ts`: mock `../auth` and `../config`, spy on
 * `globalThis.fetch`.
 */
import { RUNTIME_RESERVED_ENV_NAMES } from '@guuey/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { envList, envSet, envUnset } from './env.js';

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
      appId: 'app1',
    })),
  };
});

/** Thrown by the process.exit mock so execution stops like the real thing. */
class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let fetchSpy: MockInstance<typeof fetch>;
let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ message: 'ok' }), { status: 200 }));
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitSignal(typeof code === 'number' ? code : undefined);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('guuey env set', () => {
  it.each(RUNTIME_RESERVED_ENV_NAMES.map((name) => [name]))('refuses %s before any request, naming it', async (name) => {
    await expect(envSet([`${name}=x`, 'FEATURE_FLAG=on'])).rejects.toThrow(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(`✗ "${name}" is reserved by the platform and cannot be set`);
  });

  it('sends an ordinary set unchanged, including an LD_ name outside the list and a lower-case one', async () => {
    await envSet(['FEATURE_FLAG=on', 'LD_SDK_KEY=abc', 'ld_preload=y']);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(new URL(String(url)).pathname).toBe('/apps/app1/env');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({
      vars: { FEATURE_FLAG: 'on', LD_SDK_KEY: 'abc', ld_preload: 'y' },
    });
  });
});

describe('a refused env call prints the API message, never an object (the cliApi error envelope)', () => {
  const refusal = (status: number, code: string, message: string): Response =>
    new Response(JSON.stringify({ error: { code, message } }), { status });

  it.each([
    ['set', () => envSet(['FEATURE_FLAG=on'])],
    ['list', () => envList({})],
    ['unset', () => envUnset(['FEATURE_FLAG'])],
  ] as const)('env %s: a 403 prints the code and message', async (_verb, run) => {
    fetchSpy.mockResolvedValue(refusal(403, 'FORBIDDEN', 'needs a higher role'));

    await expect(run()).rejects.toThrow(ExitSignal);

    expect(errorSpy).toHaveBeenCalledWith('✗ FORBIDDEN: needs a higher role');
  });

  it('env list: the uniform 404 prints the not-found-or-not-allowed line', async () => {
    fetchSpy.mockResolvedValue(refusal(404, 'NOT_FOUND', 'App app1 not found'));

    await expect(envList({})).rejects.toThrow(ExitSignal);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('App app1 was not found, or this account is not allowed to read env vars from it.'),
    );
  });

  it('a body that is not JSON falls back to the HTTP status', async () => {
    fetchSpy.mockResolvedValue(new Response('upstream died', { status: 502 }));

    await expect(envList({})).rejects.toThrow(ExitSignal);

    expect(errorSpy).toHaveBeenCalledWith('✗ Failed: HTTP 502');
  });
});
