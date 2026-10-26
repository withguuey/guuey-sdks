import { readFileSync } from 'node:fs';
/**
 * `guuey apps check --origin` + the byo embed-origin warning (guuey#186
 * Gap 2).
 *
 * The probe's whole value is fidelity to what a BROWSER does, so the wire
 * assertions pin the two properties a refactor would silently lose:
 *
 *   - the OPTIONS request carries `Origin` + `Access-Control-Request-*`
 *     and — unlike every other request this module makes — **no
 *     Authorization header** (browsers never send credentials on a
 *     preflight; an authed probe could pass where the browser fails);
 *   - the verdict is read from the response headers exactly as the
 *     browser's CORS check would read them, including the honesty case:
 *     a 405/501 with no CORS headers means "this probe cannot verify the
 *     allowlist", never a fake allowed/blocked.
 *
 * Mocking mirrors `apps.recover.test.ts`: `requireAuth`/`resolveConfig`
 * mocked, `globalThis.fetch` spied for wire-level assertions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  appsCheck,
  appsUpdate,
  byoEmbedOriginGap,
  invokePreflightUrl,
  normalizeProbeOrigin,
  originPreflightVerdict,
} from './apps.js';

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

const ORIGIN = 'https://console.example.com';

function liveDeploymentsResponse(): Response {
  return new Response(
    JSON.stringify({
      deployments: [{ status: 'live', endpointUrl: 'https://pod.guuey.test/a1' }],
    }),
    { status: 200 },
  );
}

function preflightResponse(
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(null, { status, headers });
}

describe('normalizeProbeOrigin', () => {
  it('passes an exact origin through untouched', () => {
    expect(normalizeProbeOrigin(ORIGIN)).toEqual({ origin: ORIGIN });
  });

  it('reduces a URL with a path to its origin, with a note', () => {
    const result = normalizeProbeOrigin(`${ORIGIN}/chat/page`);
    expect(result).toMatchObject({ origin: ORIGIN });
    expect('note' in result && result.note).toContain(ORIGIN);
  });

  it('refuses a bare hostname (no scheme)', () => {
    expect(normalizeProbeOrigin('console.example.com')).toHaveProperty('error');
  });

  it('refuses a non-http(s) scheme', () => {
    expect(normalizeProbeOrigin('ftp://example.com')).toHaveProperty('error');
  });
});

describe('invokePreflightUrl', () => {
  it('appends /agent/invoke to a pod base', () => {
    expect(invokePreflightUrl('https://pod.guuey.test/a1')).toBe(
      'https://pod.guuey.test/a1/agent/invoke',
    );
  });

  it('strips trailing slashes first', () => {
    expect(invokePreflightUrl('https://pod.guuey.test/a1//')).toBe(
      'https://pod.guuey.test/a1/agent/invoke',
    );
  });

  it('leaves a full invoke URL alone', () => {
    expect(invokePreflightUrl('https://pod.guuey.test/a1/agent/invoke')).toBe(
      'https://pod.guuey.test/a1/agent/invoke',
    );
  });
});

describe('originPreflightVerdict', () => {
  const obs = (
    status: number | null,
    allowOrigin: string | null = null,
    allowMethods: string | null = null,
    failure?: string,
  ) => ({ status, allowOrigin, allowMethods, failure });

  it('allows an exact origin echo', () => {
    expect(originPreflightVerdict(ORIGIN, obs(204, ORIGIN, 'POST, OPTIONS')).kind).toBe('allowed');
  });

  it('allows a wildcard', () => {
    expect(originPreflightVerdict(ORIGIN, obs(204, '*')).kind).toBe('allowed');
  });

  it('blocks when the origin is allowed but POST is not', () => {
    const verdict = originPreflightVerdict(ORIGIN, obs(204, ORIGIN, 'GET, OPTIONS'));
    expect(verdict.kind).toBe('blocked');
    expect(verdict.detail).toContain('POST');
  });

  it('blocks when the endpoint answered for a different origin', () => {
    const verdict = originPreflightVerdict(ORIGIN, obs(204, 'https://other.example.com'));
    expect(verdict.kind).toBe('blocked');
    expect(verdict.detail).toContain('https://other.example.com');
  });

  it('blocks when no Access-Control-Allow-Origin came back at all', () => {
    const verdict = originPreflightVerdict(ORIGIN, obs(204));
    expect(verdict.kind).toBe('blocked');
    expect(verdict.detail).toContain('allowlist');
  });

  it('refuses to fake a verdict when the endpoint did not answer the preflight', () => {
    const verdict = originPreflightVerdict(ORIGIN, obs(405));
    expect(verdict.kind).toBe('no-preflight');
    expect(verdict.detail).toContain('cannot verify');
  });

  it('reads a network failure as unreachable', () => {
    expect(originPreflightVerdict(ORIGIN, obs(null, null, null, 'fetch failed')).kind).toBe(
      'unreachable',
    );
  });
});

describe('byoEmbedOriginGap', () => {
  it('fires for byo with an empty allowlist', () => {
    expect(byoEmbedOriginGap({ userAuthMode: 'byo', allowedDomains: [] })).toBe(true);
    expect(byoEmbedOriginGap({ userAuthMode: 'byo' })).toBe(true);
    expect(byoEmbedOriginGap({ userAuthMode: 'byo', allowedDomains: null })).toBe(true);
  });

  it('stays quiet when domains are configured or the app is not byo', () => {
    expect(byoEmbedOriginGap({ userAuthMode: 'byo', allowedDomains: ['a.com'] })).toBe(false);
    expect(byoEmbedOriginGap({ userAuthMode: 'guest', allowedDomains: [] })).toBe(false);
    expect(byoEmbedOriginGap({})).toBe(false);
  });
});

describe('appsCheck', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // appsCheck signals a non-allowed verdict via exitCode without killing
    // the run — clear it so the test process itself exits clean.
    process.exitCode = 0;
  });

  it('sends the browser-identical preflight (no Authorization) and reports allowed', async () => {
    fetchSpy
      .mockResolvedValueOnce(liveDeploymentsResponse())
      .mockResolvedValueOnce(
        preflightResponse(204, {
          'access-control-allow-origin': ORIGIN,
          'access-control-allow-methods': 'POST, OPTIONS',
        }),
      );

    await appsCheck('app-1', { origin: ORIGIN });

    // Call 1: authed deployments read.
    const [deployUrl, deployInit] = fetchSpy.mock.calls[0];
    expect(String(deployUrl)).toBe('https://api.guuey.test/apps/app-1/deployments');
    expect(new Headers(deployInit?.headers).get('authorization')).toBe('Bearer pat-test');

    // Call 2: the preflight — browser-identical, credential-free.
    const [optionsUrl, optionsInit] = fetchSpy.mock.calls[1];
    expect(String(optionsUrl)).toBe('https://pod.guuey.test/a1/agent/invoke');
    expect(optionsInit?.method).toBe('OPTIONS');
    const headers = new Headers(optionsInit?.headers);
    expect(headers.get('origin')).toBe(ORIGIN);
    expect(headers.get('access-control-request-method')).toBe('POST');
    expect(headers.get('access-control-request-headers')).toBe('content-type');
    expect(headers.get('authorization')).toBeNull();

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Origin is allowed');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('reports a blocked origin with the fix command and a non-zero exit code', async () => {
    fetchSpy
      .mockResolvedValueOnce(liveDeploymentsResponse())
      .mockResolvedValueOnce(preflightResponse(204, {}));

    await appsCheck('app-1', { origin: ORIGIN });

    const output = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
    expect(output).toContain('NOT allowed');
    expect(output).toContain(`guuey apps update app-1 --domains "${ORIGIN}"`);
    expect(process.exitCode).toBe(1);
  });

  it('refuses to run without --origin', async () => {
    await expect(appsCheck('app-1', {})).rejects.toThrow(ExitSignal);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('errors when the app has no live deployment', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [] }), { status: 200 }),
    );
    await expect(appsCheck('app-1', { origin: ORIGIN })).rejects.toThrow(ExitSignal);
    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).toContain('no live deployment');
  });
});

describe('appsUpdate --auth-mode byo origin warning', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const appResponse = (allowedDomains: string[]): Response =>
    new Response(
      JSON.stringify({
        app: {
          id: 'app-1',
          displayName: 'App',
          createdAt: '2026-08-15T00:00:00.000Z',
          userAuthMode: 'byo',
          userAuthConfig: { issuerUrl: 'https://issuer.example.com', audience: 'my-app' },
          allowedDomains,
        },
      }),
      { status: 200 },
    );

  it('warns when byo is armed with an empty allowlist', async () => {
    fetchSpy
      .mockResolvedValueOnce(appResponse([])) // stored read
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })); // PUT

    await appsUpdate('app-1', { authMode: 'byo' });

    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).toContain('allowlist is EMPTY');
    expect(output).toContain('guuey apps check --origin');
  });

  it('stays quiet when the allowlist is populated', async () => {
    fetchSpy
      .mockResolvedValueOnce(appResponse(['https://console.example.com'])) // stored read
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })); // PUT

    await appsUpdate('app-1', { authMode: 'byo' });

    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('allowlist is EMPTY');
  });
});

describe('appsUpdate --auth-mode byo issuer binding', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  type StoredConfig = { issuerUrl: string | null; audience: string | null } | null;
  const storedApp = (userAuthConfig: StoredConfig, userAuthMode: string | null = null): Response =>
    new Response(
      JSON.stringify({
        app: {
          id: 'app-1',
          displayName: 'App',
          createdAt: '2026-08-15T00:00:00.000Z',
          userAuthMode,
          userAuthConfig,
          allowedDomains: ['https://console.example.com'],
        },
      }),
      { status: 200 },
    );
  const methods = (): string[] => fetchSpy.mock.calls.map(([, init]) => String(init?.method ?? 'GET'));
  const printed = (): string => errorSpy.mock.calls.flat().join('\n');

  it.each<[string, StoredConfig]>([
    ['no binding', null],
    ['an issuer without an audience', { issuerUrl: 'https://issuer.example.com', audience: null }],
    ['an audience without an issuer', { issuerUrl: null, audience: 'my-app' }],
  ])('refuses byo alone on an app with %s, and sends no PUT', async (_label, stored) => {
    fetchSpy.mockResolvedValueOnce(storedApp(stored));

    await expect(appsUpdate('app-1', { authMode: 'byo' })).rejects.toThrow(ExitSignal);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(methods()).toEqual(['GET']);
    expect(printed()).toContain('--auth-mode byo needs an issuer binding, and app app-1 has none stored.');
    expect(printed()).toContain('refuses sign-ins from your own');
    expect(printed()).toContain(
      'guuey apps update app-1 --auth-mode byo --issuer-url <https://issuer> --audience <audience>',
    );
  });

  it('accepts byo alone when the app already stores issuer and audience', async () => {
    fetchSpy
      .mockResolvedValueOnce(storedApp({ issuerUrl: 'https://issuer.example.com', audience: 'my-app' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })); // PUT

    await appsUpdate('app-1', { authMode: 'byo' });

    expect(methods()).toEqual(['GET', 'PUT']);
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({ userAuthMode: 'byo' });
    expect(printed()).not.toContain('needs an issuer binding');
  });

  it('sends byo with the binding on the same call without reading the stored one', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })); // PUT

    await appsUpdate('app-1', {
      authMode: 'byo',
      issuerUrl: 'https://issuer.example.com',
      audience: 'my-app',
      domains: 'https://console.example.com',
    });

    expect(methods()).toEqual(['PUT']);
    expect(printed()).not.toContain('needs an issuer binding');
  });

  it('refuses byo with --clear-auth-config before any request', async () => {
    await expect(appsUpdate('app-1', { authMode: 'byo', clearAuthConfig: true })).rejects.toThrow(
      ExitSignal,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(printed()).toContain('--auth-mode byo cannot be combined with --clear-auth-config.');
  });

  it('exits non-zero with no PUT when the stored binding cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'App not found' } }), {
        status: 404,
      }),
    );

    await expect(appsUpdate('app-1', { authMode: 'byo' })).rejects.toThrow(ExitSignal);

    expect(methods()).toEqual(['GET']);
  });

  const BOUND = { issuerUrl: 'https://issuer.example.com', audience: 'my-app' };

  it('refuses --clear-auth-config on an app stored in byo, and sends no PUT', async () => {
    fetchSpy.mockResolvedValueOnce(storedApp(BOUND, 'byo'));

    await expect(appsUpdate('app-1', { clearAuthConfig: true })).rejects.toThrow(ExitSignal);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(methods()).toEqual(['GET']);
    expect(printed()).toContain('--clear-auth-config would leave app app-1 in byo with no issuer binding.');
    expect(printed()).toContain(
      'guuey apps update app-1 --auth-mode <anonymous|native_pool> --clear-auth-config',
    );
    expect(printed()).toContain(
      'guuey apps update app-1 --issuer-url <https://issuer> --audience <audience>',
    );
  });

  it('clears the binding when the same call switches the mode away from byo', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })); // PUT

    await appsUpdate('app-1', { authMode: 'native_pool', clearAuthConfig: true });

    expect(methods()).toEqual(['PUT']);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      userAuthMode: 'native_pool',
      userAuthConfig: null,
    });
  });

  it.each<[string, string | null]>([
    ['native_pool', 'native_pool'],
    ['anonymous', 'anonymous'],
    ['no mode', null],
  ])('clears the binding on an app stored in %s', async (_label, mode) => {
    fetchSpy
      .mockResolvedValueOnce(storedApp(BOUND, mode))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })); // PUT

    await appsUpdate('app-1', { clearAuthConfig: true });

    expect(methods()).toEqual(['GET', 'PUT']);
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({ userAuthConfig: null });
  });

  it('exits non-zero with no PUT when the stored mode cannot be read for a clear', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'App not found' } }), {
        status: 404,
      }),
    );

    await expect(appsUpdate('app-1', { clearAuthConfig: true })).rejects.toThrow(ExitSignal);

    expect(methods()).toEqual(['GET']);
  });

  it('leaves other modes alone', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })); // PUT

    await appsUpdate('app-1', { authMode: 'native_pool' });

    expect(methods()).toEqual(['PUT']);
  });
});

/**
 * guuey#1301 — implemented, tested and suggested by the CLI's own error hints,
 * `apps check` was dispatched nowhere: the `apps` switch in `cli.ts` had no
 * `check` case. Pinned against the dispatcher's source so it cannot fall out
 * again silently.
 */
describe('guuey apps check — wired in the dispatcher (guuey#1301)', () => {
  it("cli.ts dispatches `apps check` to appsCheck and lists it among the apps commands", () => {
    const cli = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/case 'check':\s*[\s\S]{0,240}await appsCheck\(rest\[0\], flags\);/);
    expect(cli).toContain('subscribe, access, check, publish, unpublish, byo-user');
  });
});
