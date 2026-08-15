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
          allowedDomains,
        },
      }),
      { status: 200 },
    );

  it('warns when byo is armed with an empty allowlist', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })) // PUT
      .mockResolvedValueOnce(appResponse([])); // re-read

    await appsUpdate('app-1', { authMode: 'byo' });

    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).toContain('allowlist is EMPTY');
    expect(output).toContain('guuey apps check --origin');
  });

  it('stays quiet when the allowlist is populated', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })) // PUT
      .mockResolvedValueOnce(appResponse(['https://console.example.com'])); // re-read

    await appsUpdate('app-1', { authMode: 'byo' });

    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('allowlist is EMPTY');
  });
});
