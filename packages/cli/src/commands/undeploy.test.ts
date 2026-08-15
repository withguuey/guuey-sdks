/**
 * `guuey undeploy` — confirmation-gate + targeting coverage (guuey#183).
 *
 * The gate is the same posture as `mcp delete` / `widget keys revoke`: a
 * non-interactive session without `--force` REFUSES with exit 1 (the old
 * code read EOF as the default N and exited 0 — a scripted teardown that
 * did nothing reported success), and a declined prompt also exits non-zero.
 *
 * Same harness as `agent.test.ts`: mock `../auth` + `../config`, spy on
 * `globalThis.fetch`, throw through a `process.exit` mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { undeploy, resolveUndeployConfirmation } from './undeploy.js';

/** The answer the mocked readline prompt returns; tests set it per-case. */
let promptAnswer = 'n';

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb(promptAnswer),
    close: () => {},
  }),
}));

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
      appId: 'app-bound',
    })),
  };
});

/** Thrown by the process.exit mock so execution stops like the real thing. */
class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

describe('resolveUndeployConfirmation', () => {
  it('--force skips the prompt regardless of TTY state', () => {
    expect(
      resolveUndeployConfirmation({ force: true, stdinIsTTY: undefined, stdoutIsTTY: undefined }),
    ).toBe('skip');
    expect(
      resolveUndeployConfirmation({ force: true, stdinIsTTY: true, stdoutIsTTY: true }),
    ).toBe('skip');
  });

  it('an interactive session (stdin AND stdout TTYs) prompts', () => {
    expect(
      resolveUndeployConfirmation({ force: false, stdinIsTTY: true, stdoutIsTTY: true }),
    ).toBe('prompt');
  });

  it('a non-interactive session without --force refuses — never the silent default-N', () => {
    expect(
      resolveUndeployConfirmation({ force: false, stdinIsTTY: undefined, stdoutIsTTY: undefined }),
    ).toBe('refuse');
    expect(
      resolveUndeployConfirmation({ force: false, stdinIsTTY: true, stdoutIsTTY: undefined }),
    ).toBe('refuse');
    expect(
      resolveUndeployConfirmation({ force: false, stdinIsTTY: undefined, stdoutIsTTY: true }),
    ).toBe('refuse');
  });
});

describe('guuey undeploy', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let exitSpy: MockInstance<typeof process.exit>;
  let errSpy: MockInstance<typeof console.error>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

  // The vitest runner is itself non-interactive (stdin.isTTY is not true),
  // so calling without --force exercises the refuse path deterministically.
  it('refuses without --force in a non-interactive session — exit 1, no API call', async () => {
    await expect(undeploy({})).rejects.toThrow(ExitSignal);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr()).toContain('--force');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('--force skips confirmation and POSTs the teardown for the bound app', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ buildNumber: 7 }), { status: 200 }),
    );
    await undeploy({ force: true });
    const call = fetchSpy.mock.calls.at(-1);
    if (!call) throw new Error('fetch was not called');
    expect(String(call[0])).toBe(
      'https://api.guuey.test/apps/app-bound/deploy/undeploy',
    );
  });

  it('--app-id overrides the bound config.appId', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await undeploy({ force: true, 'app-id': 'app-override' });
    const call = fetchSpy.mock.calls.at(-1);
    if (!call) throw new Error('fetch was not called');
    expect(String(call[0])).toBe(
      'https://api.guuey.test/apps/app-override/deploy/undeploy',
    );
  });

  /** Run `fn` with both stdio ends pretending to be TTYs (the prompt path). */
  async function withTTY(fn: () => Promise<void>): Promise<void> {
    const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await fn();
    } finally {
      if (stdinDesc) Object.defineProperty(process.stdin, 'isTTY', stdinDesc);
      if (stdoutDesc) Object.defineProperty(process.stdout, 'isTTY', stdoutDesc);
    }
  }

  it('a declined prompt prints Cancelled and exits non-zero', async () => {
    promptAnswer = 'n';
    await withTTY(async () => {
      await expect(undeploy({})).rejects.toThrow(ExitSignal);
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')).toContain('Cancelled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an affirmed prompt proceeds to the teardown POST', async () => {
    promptAnswer = 'y';
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await withTTY(async () => {
      await undeploy({});
    });
    const call = fetchSpy.mock.calls.at(-1);
    if (!call) throw new Error('fetch was not called');
    expect(String(call[0])).toBe(
      'https://api.guuey.test/apps/app-bound/deploy/undeploy',
    );
  });
});
