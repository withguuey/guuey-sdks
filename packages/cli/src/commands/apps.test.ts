/**
 * `guuey apps access|publish|unpublish` — flag parsing → request-shape
 * coverage (M2-B Task 4).
 *
 * `apps.ts` builds its own `apiRequest(method, path, body)` from
 * `requireAuth()` + `resolveConfig()` + `fetch` (unlike `mcp.ts`/`deploy.ts`,
 * which take an injected `api` dependency) — so these tests mock `../auth`
 * and `../config` for the auth/base-URL inputs and spy on `globalThis.fetch`
 * for the wire-level assertions, reading `(url, init)` back into the same
 * `{ method, path, body }` shape the request builder produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  appsAccess,
  appsByoUserErase,
  appsList,
  appsListRow,
  appsPublish,
  appsUnpublish,
} from './apps.js';
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

/**
 * Reads the most recent `fetch(url, init)` call back into wire-request shape.
 * `path` includes the query string (`pathname + search`) — empty for every
 * existing query-less caller here, load-bearing for `appsByoUserErase`'s
 * `--status` GET (`?sub=…`).
 */
function lastRequest(fetchSpy: MockInstance<typeof fetch>): CapturedRequest {
  const call = fetchSpy.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  const [url, init] = call;
  const parsed = new URL(String(url));
  return {
    method: String(init?.method),
    path: parsed.pathname + parsed.search,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

// Regression coverage for S5: the cliApi wire field is `displayName`
// (`backend/amplify/functions/cliApi/handlers/apps.ts#AppWire`), not
// `name` — reading `.name` rendered an empty Name column in `guuey apps
// list` even though the API call succeeded.
describe('appsListRow', () => {
  it('maps the Name column from displayName (not the nonexistent `name` field)', () => {
    expect(
      appsListRow({
        id: 'app-1',
        displayName: 'Todo',
        hasBYOK: false,
        createdAt: '2026-07-01T00:00:00.000Z',
      }),
    ).toEqual({
      ID: 'app-1',
      Name: 'Todo',
      BYOK: 'no',
      Created: '2026-07-01',
    });
  });
});

describe('appsList', () => {
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

  it('prints displayName under the Name column end-to-end', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          apps: [
            {
              id: 'app-1',
              displayName: 'Todo',
              hasBYOK: false,
              createdAt: '2026-07-01T00:00:00.000Z',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await appsList({});

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Todo');
  });
});

describe('appsAccess', () => {
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

  it('maps --guests off --guest-limit 20 onto PUT /apps/:id', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ app: { guestAccess: false, guestDailyMessageLimit: 20 } }),
        { status: 200 },
      ),
    );

    await appsAccess('app1', { guests: 'off', guestLimit: '20' });

    expect(lastRequest(fetchSpy)).toEqual({
      method: 'PUT',
      path: '/apps/app1',
      body: { guestAccess: false, guestDailyMessageLimit: 20 },
    });
  });

  it('maps --guest-limit off to guestDailyMessageLimit: null', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ app: { guestAccess: null, guestDailyMessageLimit: null } }),
        { status: 200 },
      ),
    );

    await appsAccess('app1', { guestLimit: 'off' });

    expect(lastRequest(fetchSpy)).toEqual({
      method: 'PUT',
      path: '/apps/app1',
      body: { guestDailyMessageLimit: null },
    });
  });

  it('maps --guests on alone (guest-limit omitted from the body)', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ app: { guestAccess: true, guestDailyMessageLimit: null } }), {
        status: 200,
      }),
    );

    await appsAccess('app1', { guests: 'on' });

    expect(lastRequest(fetchSpy)).toEqual({
      method: 'PUT',
      path: '/apps/app1',
      body: { guestAccess: true },
    });
  });

  it('no flags errors without calling the API', async () => {
    await expect(appsAccess('app1', {})).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('No flags provided');
  });

  it('rejects an invalid --guests value before any API call', async () => {
    await expect(appsAccess('app1', { guests: 'maybe' })).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('Invalid --guests value');
  });

  it('rejects a value-less (boolean true) --guests flag before any API call', async () => {
    await expect(appsAccess('app1', { guests: true })).rejects.toBeInstanceOf(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['0', '-5', '1.5', 'abc', '1e2', '0x10'])(
    'rejects an invalid --guest-limit value %s before any API call',
    async (bad) => {
      await expect(appsAccess('app1', { guestLimit: bad })).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0]?.[0])).toContain('Invalid --guest-limit value');
    },
  );

  it('rejects a value-less (boolean true) --guest-limit flag before any API call', async () => {
    await expect(appsAccess('app1', { guestLimit: true })).rejects.toBeInstanceOf(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to resolveConfig().appId when no positional id is given', async () => {
    vi.mocked(resolveConfig).mockReturnValueOnce({
      host: 'https://guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-from-config',
    });
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ app: { guestAccess: true, guestDailyMessageLimit: null } }), {
        status: 200,
      }),
    );

    await appsAccess(undefined, { guests: 'on' });

    expect(lastRequest(fetchSpy).path).toBe('/apps/app-from-config');
  });

  it('no positional id and no configured appId errors without calling the API', async () => {
    await expect(appsAccess(undefined, { guests: 'on' })).rejects.toBeInstanceOf(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prints the resulting access state on success', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ app: { guestAccess: false, guestDailyMessageLimit: null } }),
        { status: 200 },
      ),
    );

    await appsAccess('app1', { guests: 'off' });

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('off');
    expect(output).toContain('unlimited');
  });

  it('a non-ok API response prints the wire envelope message and exits 1', async () => {
    // Real cliApi envelope: `{ error: { code, message } }` (see
    // backend/amplify/functions/shared/response.ts#httpError).
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'App app1 not found' } }),
        { status: 404 },
      ),
    );

    await expect(appsAccess('app1', { guests: 'on' })).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('App app1 not found');
    expect(printed).not.toContain('[object Object]');
  });

  it('--json emits the resulting access state as JSON', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ app: { guestAccess: false, guestDailyMessageLimit: 20 } }),
        { status: 200 },
      ),
    );

    await appsAccess('app1', { guests: 'off', guestLimit: '20', json: true });

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual({ guestAccess: false, guestDailyMessageLimit: 20 });
  });
});

describe('appsPublish', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let errSpy: MockInstance<typeof console.error>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges status/visibility over metadata flags on POST /apps/:id/listing', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ listing: { name: 'Bot', status: 'published' } }), {
        status: 200,
      }),
    );

    await appsPublish('app1', { name: 'Bot', category: 'tools' });

    expect(lastRequest(fetchSpy)).toEqual({
      method: 'POST',
      path: '/apps/app1/listing',
      body: {
        name: 'Bot',
        category: 'tools',
        status: 'published',
        visibility: 'public',
      },
    });
  });

  it('forces status/visibility even with no metadata flags at all', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ listing: { name: 'App1' } }), { status: 200 }),
    );

    await appsPublish('app1', {});

    expect(lastRequest(fetchSpy)).toEqual({
      method: 'POST',
      path: '/apps/app1/listing',
      body: { status: 'published', visibility: 'public' },
    });
  });

  it('prints the production share link and "listed in the store"', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ listing: { name: 'Weather Bot' } }), { status: 200 }),
    );

    await appsPublish('app1', {});

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('https://app.guuey.com/agent/app1');
    expect(output.toLowerCase()).toContain('listed in the store');
  });

  it('a workspace-app 404 prints the wire envelope message (not [object Object]) and exits 1', async () => {
    // The documented primary failure: listing routes are personal-apps-only,
    // so a workspace app 404s with the real cliApi envelope
    // `{ error: { code, message } }` (shared/response.ts#httpError).
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'App app1 not found' } }),
        { status: 404 },
      ),
    );
    const exitSpy = vi.spyOn(process, 'exit');

    await expect(appsPublish('app1', {})).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('Failed to publish app');
    expect(printed).toContain('App app1 not found');
    expect(printed).not.toContain('[object Object]');
  });

  it('--json emits the share link and the listing as JSON', async () => {
    const listing = { name: 'Weather Bot', status: 'published', visibility: 'public' };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ listing }), { status: 200 }));

    await appsPublish('app1', { json: true });

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual({
      shareLink: 'https://app.guuey.com/agent/app1',
      listing,
    });
  });
});

describe('appsUnpublish', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls DELETE /apps/:id/listing', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ listing: { name: 'Bot', status: 'archived' } }), {
        status: 200,
      }),
    );

    await appsUnpublish('app1', {});

    expect(lastRequest(fetchSpy)).toEqual({
      method: 'DELETE',
      path: '/apps/app1/listing',
      body: undefined,
    });
  });

  it('prints the idempotent unpublish message, even when no listing existed', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ listing: null }), { status: 200 }));

    await appsUnpublish('app1', {});

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('unpublished — the share link still works');
  });

  it('--json with the { listing: null } idempotent response emits { unpublished: true, listing: null }', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ listing: null }), { status: 200 }));

    await appsUnpublish('app1', { json: true });

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual({ unpublished: true, listing: null });
  });

  it('--json with an archived listing emits { unpublished: true, listing }', async () => {
    const listing = { name: 'Bot', status: 'archived' };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ listing }), { status: 200 }));

    await appsUnpublish('app1', { json: true });

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual({ unpublished: true, listing });
  });
});

/**
 * `guuey apps byo-user erase [appId] --sub <sub>` (+ `--status`) — erasecomp
 * Task 6, the CLI wrapper over Task 3's cliApi routes
 * (`backend/amplify/functions/cliApi/handlers/byo-users.ts`):
 *
 *   POST /v1/apps/{appId}/byo-users/erase           (default)
 *   GET  /v1/apps/{appId}/byo-users/erase-status?sub=…   (--status)
 *
 * Folded (erasecomp polish, founder decision) from a short-lived singular
 * `guuey app byo-user erase --app <appId> --sub <sub>` group into this
 * plural `apps` group, appId as a positional argument like its siblings
 * above — every behavioral assertion below carries over from the old
 * `app.test.ts`, adapted to the new `(appId, opts)` invocation.
 */
describe('appsByoUserErase', () => {
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

    await appsByoUserErase('app1', { sub: 'raw-sub-123' });

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

    await appsByoUserErase('app1', { sub: 'raw-sub-123' });

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

    await appsByoUserErase('app1', { sub: 'raw-sub-123', json: true });

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual({ wipeId: 'app-user-app1-byo_abc', status: 'queued' });
  });

  it('--status GETs erase-status with the url-encoded sub', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ wipeId: 'app-user-app1-byo_abc', status: 'done' }), {
        status: 200,
      }),
    );

    await appsByoUserErase('app1', { sub: 'raw sub/123', status: true });

    expect(lastRequest(fetchSpy)).toEqual({
      method: 'GET',
      path: '/apps/app1/byo-users/erase-status?sub=raw%20sub%2F123',
      body: undefined,
    });
  });

  it('--status renders "status: none"', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ wipeId: 'w1', status: 'none' }), { status: 200 }),
    );

    await appsByoUserErase('app1', { sub: 'sub1', status: true });

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('status: none');
  });

  it('--status renders "status: done"', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ wipeId: 'w1', status: 'done' }), { status: 200 }),
    );

    await appsByoUserErase('app1', { sub: 'sub1', status: true });

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('status: done');
  });

  it('--status renders "status: queued" plus the requestedAt/attempts passthrough lines', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          wipeId: 'w1',
          status: 'queued',
          requestedAt: '2026-07-01T00:00:00.000Z',
          attempts: 3,
        }),
        { status: 200 },
      ),
    );

    await appsByoUserErase('app1', { sub: 'sub1', status: true });

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('status: queued');
    expect(output).toContain('requested at: 2026-07-01T00:00:00.000Z');
    expect(output).toContain('attempts: 3');
  });

  it('--status with stuck: true prints a visible warning (plus the requestedAt/attempts passthrough)', async () => {
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

    await appsByoUserErase('app1', { sub: 'sub1', status: true });

    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('wipe appears stuck');
    expect(printed).toContain('contact support');
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('requested at: 2026-07-01T00:00:00.000Z');
    expect(output).toContain('attempts: 3');
  });

  it('--status --json emits the raw status response as JSON', async () => {
    const body = { wipeId: 'w1', status: 'queued', requestedAt: '2026-07-01T00:00:00.000Z', attempts: 1 };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

    await appsByoUserErase('app1', { sub: 'sub1', status: true, json: true });

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

    await expect(appsByoUserErase('app1', { sub: 'sub1' })).rejects.toBeInstanceOf(ExitSignal);

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
      appsByoUserErase('app1', { sub: 'sub1', status: true }),
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('App app1 not found');
  });

  it('missing --sub errors without calling the API', async () => {
    await expect(appsByoUserErase('app1', {})).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('--sub');
  });

  it('missing positional appId falls back to resolveConfig().appId', async () => {
    vi.mocked(resolveConfig).mockReturnValueOnce({
      host: 'https://guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-from-config',
    });
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ wipeId: 'w1', status: 'queued' }), { status: 202 }),
    );

    await appsByoUserErase(undefined, { sub: 'sub1' });

    expect(lastRequest(fetchSpy).path).toBe('/apps/app-from-config/byo-users/erase');
  });

  it('missing positional appId and no configured appId errors without calling the API', async () => {
    await expect(appsByoUserErase(undefined, { sub: 'sub1' })).rejects.toBeInstanceOf(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('No app ID provided');
  });
});
