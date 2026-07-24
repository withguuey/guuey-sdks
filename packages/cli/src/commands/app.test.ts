/**
 * `guuey app byo-user erase` (+ `--status`) — erasecomp Task 6, the CLI
 * wrapper over Task 3's cliApi routes
 * (`backend/amplify/functions/cliApi/handlers/byo-users.ts`):
 *
 *   POST /v1/apps/{appId}/byo-users/erase           (default)
 *   GET  /v1/apps/{appId}/byo-users/erase-status?sub=…   (--status)
 *
 * Mirrors `apps.ts`'s local `apiRequest`/`handleError` idiom exactly, so
 * these tests mirror `apps.test.ts`'s mocking idiom: mock `../auth` and
 * `../config` for the auth/base-URL inputs, spy on `globalThis.fetch` for
 * the wire-level assertions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { appByoUserErase } from './app.js';
import { resolveConfig } from '../config.js';

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

/** Thrown by the process.exit mock so execution stops like the real thing. */
class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

/** Reads the most recent `fetch(url, init)` call back into wire-request shape. */
function lastRequest(fetchSpy: MockInstance<typeof fetch>): CapturedRequest {
  const call = fetchSpy.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  const [url, init] = call;
  return {
    method: String(init?.method),
    path: new URL(String(url)).pathname + new URL(String(url)).search,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

describe('appByoUserErase', () => {
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

  it('POSTs /apps/:id/byo-users/erase with { sub }', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ wipeId: 'app-user-app1-byo_abc', status: 'queued' }), {
        status: 202,
      }),
    );

    await appByoUserErase({ app: 'app1', sub: 'raw-sub-123' });

    expect(lastRequest(fetchSpy)).toEqual({
      method: 'POST',
      path: '/apps/app1/byo-users/erase',
      body: { sub: 'raw-sub-123' },
    });
  });

  it('prints the wipeId and the honest async contract on erase success', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ wipeId: 'app-user-app1-byo_abc', status: 'queued' }), {
        status: 202,
      }),
    );

    await appByoUserErase({ app: 'app1', sub: 'raw-sub-123' });

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('app-user-app1-byo_abc');
    expect(output).toContain('queued');
    expect(output).toContain('~15 minutes');
    expect(output).toContain('--status');
    expect(output).toContain('thread/session deletion already completed with this command');
  });

  it('--json emits the raw erase response as JSON', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ wipeId: 'app-user-app1-byo_abc', status: 'queued' }), {
        status: 202,
      }),
    );

    await appByoUserErase({ app: 'app1', sub: 'raw-sub-123', json: true });

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual({ wipeId: 'app-user-app1-byo_abc', status: 'queued' });
  });

  it('--status GETs erase-status with the url-encoded sub', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ wipeId: 'app-user-app1-byo_abc', status: 'done' }), {
        status: 200,
      }),
    );

    await appByoUserErase({ app: 'app1', sub: 'raw sub/123', status: true });

    expect(lastRequest(fetchSpy)).toEqual({
      method: 'GET',
      path: '/apps/app1/byo-users/erase-status?sub=raw%20sub%2F123',
      body: undefined,
    });
  });

  it('--status renders queued|done|none', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ wipeId: 'w1', status: 'none' }), { status: 200 }),
    );

    await appByoUserErase({ app: 'app1', sub: 'sub1', status: true });

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('none');
  });

  it('--status with stuck: true prints a visible warning', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          wipeId: 'w1',
          status: 'queued',
          requestedAt: '2026-07-01T00:00:00.000Z',
          attempts: 3,
          stuck: true,
        }),
        { status: 200 },
      ),
    );

    await appByoUserErase({ app: 'app1', sub: 'sub1', status: true });

    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('wipe appears stuck');
    expect(printed).toContain('contact support');
  });

  it('--status --json emits the raw status response as JSON', async () => {
    const body = { wipeId: 'w1', status: 'queued', requestedAt: '2026-07-01T00:00:00.000Z', attempts: 1 };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

    await appByoUserErase({ app: 'app1', sub: 'sub1', status: true, json: true });

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual(body);
  });

  it('a non-2xx erase response prints the server message and exits 1 (no retry)', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'FORBIDDEN', message: "caller has 'member'" } }),
        { status: 403 },
      ),
    );

    await expect(appByoUserErase({ app: 'app1', sub: 'sub1' })).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain("caller has 'member'");
    expect(printed).not.toContain('[object Object]');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a non-2xx status response prints the server message and exits 1', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'App app1 not found' } }), {
        status: 404,
      }),
    );

    await expect(
      appByoUserErase({ app: 'app1', sub: 'sub1', status: true }),
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('App app1 not found');
  });

  it('missing --sub errors without calling the API', async () => {
    await expect(appByoUserErase({ app: 'app1' })).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('--sub');
  });

  it('missing --app falls back to resolveConfig().appId', async () => {
    vi.mocked(resolveConfig).mockReturnValueOnce({
      host: 'https://guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-from-config',
    });
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ wipeId: 'w1', status: 'queued' }), { status: 202 }),
    );

    await appByoUserErase({ sub: 'sub1' });

    expect(lastRequest(fetchSpy).path).toBe('/apps/app-from-config/byo-users/erase');
  });

  it('missing --app and no configured appId errors without calling the API', async () => {
    await expect(appByoUserErase({ sub: 'sub1' })).rejects.toBeInstanceOf(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('--app');
  });
});
