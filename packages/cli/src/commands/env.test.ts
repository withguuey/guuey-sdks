/**
 * `guuey env set` — the runtime-reserved names (`@guuey/config`
 * RUNTIME_RESERVED_ENV_NAMES, the one list `guuey deploy` and the host apply)
 * are refused before any request; every other name is sent as before. The
 * list itself is pinned to the platform's by `@guuey/config`'s own
 * `reserved-env.test.ts`.
 *
 * The four provider key names (`@guuey/config` BYOK_PROVIDER_SLOT_ENV, guuey#2412)
 * are refused the same way, before any request, with the door-neutral line the
 * server answers and the CLI's own pointer at `guuey byok set`. Every server
 * error prints through `out.apiErrorMessage`.
 *
 * Same harness as `agent.test.ts`: mock `../auth` and `../config`, spy on
 * `globalThis.fetch`.
 */
import { BYOK_PROVIDER_IDS, BYOK_PROVIDER_SLOT_ENV, RUNTIME_RESERVED_ENV_NAMES } from '@guuey/config';
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

/** A cliApi error answer in its `{ error: { code, message } }` envelope. */
function apiError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status });
}

/** Every line written to stderr, in order. */
function stderrLines(): string[] {
  return errorSpy.mock.calls.map((call) => String(call[0]));
}

describe('guuey env set — provider key names (guuey#2412)', () => {
  it.each(BYOK_PROVIDER_IDS.map((provider) => [BYOK_PROVIDER_SLOT_ENV[provider], provider]))(
    'refuses %s before any request and points at guuey byok set --provider %s',
    async (name, provider) => {
      await expect(envSet([`${name}=sk-test`, 'FEATURE_FLAG=on'])).rejects.toThrow(ExitSignal);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(stderrLines()).toEqual([
        `✗ "${name}" is a provider key name. A plain variable doesn't switch the app to your key. ` +
          `Set it as the app's ${provider} provider key instead.`,
        `Use: guuey byok set --provider ${provider} --app-id app1`,
      ]);
    },
  );

  it('the refusal lists every provider key name in one run, each with its own pointer', async () => {
    await expect(envSet(['OPENAI_API_KEY=a', 'GEMINI_API_KEY=b'])).rejects.toThrow(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrLines().filter((line) => line.startsWith('Use: '))).toEqual([
      'Use: guuey byok set --provider openai --app-id app1',
      'Use: guuey byok set --provider google --app-id app1',
    ]);
  });

  it('the refusal names the --app-id target the command was given', async () => {
    await expect(envSet(['ANTHROPIC_API_KEY=x'], { 'app-id': 'other-app' })).rejects.toThrow(ExitSignal);

    expect(stderrLines()).toContain('Use: guuey byok set --provider anthropic --app-id other-app');
  });

  it("a server's 400 PROVIDER_KEY_ENV_NAME prints the server's line and the guuey byok set pointer", async () => {
    // A name the server knows as a provider key slot and this CLI does not (a newer server), so the
    // request is made; the CLI renders the server's code and message and adds the door's pointer.
    const message =
      '"MISTRAL_API_KEY" is a provider key name. A plain variable doesn\'t switch the app to your key. ' +
      "Set it as the app's mistral provider key instead.";
    fetchSpy.mockResolvedValueOnce(apiError(400, 'PROVIDER_KEY_ENV_NAME', message));

    await expect(envSet(['MISTRAL_API_KEY=x'])).rejects.toThrow(ExitSignal);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(stderrLines()).toEqual([
      `✗ PROVIDER_KEY_ENV_NAME: ${message}`,
      'Use: guuey byok set --provider <provider> --app-id app1',
    ]);
  });
});
