/**
 * `guuey apps create --for personal|customers` (guuey#1670): who the agent is
 * for rides `POST /v1/apps` as `builtFor`, and the stored value is echoed back
 * in the console's words.
 *
 * Mocking mirrors `apps.test.ts` (`requireAuth` + `resolveConfig` mocked,
 * `globalThis.fetch` spied), plus two mocks that file never needed:
 * `isLoggedIn` answers true so `login()` (a browser) is never reached, and
 * `saveConfig` is a spy, so a test run never writes the operator's real
 * `~/.guuey/config.json`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { appsCreate } from './apps.js';
import { saveConfig } from '../config.js';

vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return {
    ...actual,
    isLoggedIn: vi.fn(() => true),
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
    loadConfig: vi.fn(() => ({})),
    saveConfig: vi.fn(),
  };
});

vi.mock('./login.js', () => ({
  login: vi.fn(() => {
    throw new Error('login() must not run in this test');
  }),
}));

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let fetchSpy: MockInstance<typeof fetch>;
let logSpy: MockInstance<typeof console.log>;
let errSpy: MockInstance<typeof console.error>;

function created(app: { id: string; displayName: string; builtFor?: string }): Response {
  return new Response(JSON.stringify({ app }), { status: 201 });
}

function sentBody(): unknown {
  const [, init] = fetchSpy.mock.calls.at(-1)!;
  return JSON.parse(String(init?.body));
}

function printed(spy: MockInstance<typeof console.log>): string {
  return spy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitSignal(typeof code === 'number' ? code : undefined);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(saveConfig).mockClear();
});

describe('guuey apps create --for (guuey#1670)', () => {
  it('--for personal sends builtFor and prints the stored answer in the console words', async () => {
    fetchSpy.mockResolvedValue(created({ id: 'app-p', displayName: 'Mine', builtFor: 'personal' }));

    await appsCreate({ name: 'Mine', for: 'personal' });

    const [url, init] = fetchSpy.mock.calls.at(-1)!;
    expect(new URL(String(url)).pathname).toBe('/apps');
    expect(init?.method).toBe('POST');
    expect(sentBody()).toEqual({ displayName: 'Mine', builtFor: 'personal' });
    expect(printed(logSpy)).toContain('Built for: Just for me');
  });

  it('--for customers sends builtFor: customers', async () => {
    fetchSpy.mockResolvedValue(created({ id: 'app-c', displayName: 'Rep', builtFor: 'customers' }));

    await appsCreate({ name: 'Rep', for: 'customers' });

    expect(sentBody()).toEqual({ displayName: 'Rep', builtFor: 'customers' });
    expect(printed(logSpy)).toContain('Built for: For my customers');
  });

  it('without --for the create sends NO builtFor key (N-1: the server reads customers)', async () => {
    fetchSpy.mockResolvedValue(created({ id: 'app-n', displayName: 'Plain' }));

    await appsCreate({ name: 'Plain' });

    expect(sentBody()).toEqual({ displayName: 'Plain' });
    // A server from before the field echoes none: no line, never a guessed one.
    expect(printed(logSpy)).not.toContain('Built for');
  });

  it('an unknown --for exits 1 naming both values, before any request', async () => {
    await expect(appsCreate({ name: 'X', for: 'team' })).rejects.toBeInstanceOf(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    const err = printed(errSpy);
    expect(err).toContain('Unknown --for "team"');
    expect(err).toContain('--for personal');
    expect(err).toContain('--for customers');
  });

  it('a valueless --for exits 1, before any request', async () => {
    await expect(appsCreate({ name: 'X', for: true })).rejects.toBeInstanceOf(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(printed(errSpy)).toContain('--for needs a value');
  });
});
