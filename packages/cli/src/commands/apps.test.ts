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
import { appsAccess, appsPublish, appsUnpublish } from './apps.js';
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
    path: new URL(String(url)).pathname,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

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

  it('a non-ok API response prints the error and exits 1', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'App not found' }), { status: 404 }),
    );

    await expect(appsAccess('app1', { guests: 'on' })).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
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

  it('a non-ok API response (e.g. workspace app 404) prints the error and exits 1', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'App not found' }), { status: 404 }),
    );
    const exitSpy = vi.spyOn(process, 'exit');

    await expect(appsPublish('app1', {})).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
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
