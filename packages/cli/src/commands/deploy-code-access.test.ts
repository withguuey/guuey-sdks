/**
 * guuey#2358 — a CODE-mode `guuey deploy` converges guuey.json's `app.access`
 * before the build is triggered, so a BYO app never goes live verifying
 * against an issuer its guuey.json does not name.
 *
 * Drives the real `deploy()` through the orchestrated code path. The local
 * build and the source pack are stubbed (no pnpm, no tar); every platform
 * call goes through the fetch spy, so the ORDER of the access write and the
 * trigger is read off the calls the deploy really made.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { deploy } from './deploy.js';
import { resolveConfig, loadProjectConfig } from '../config.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(() => Buffer.from('')),
    spawnSync: vi.fn((file: string) => ({ status: file === 'pnpm' ? 0 : 1 })),
  };
});

const packed = vi.hoisted(() => ({ path: '' }));
vi.mock('../deploy-shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deploy-shared.js')>();
  return {
    ...actual,
    packSource: vi.fn(() => ({ tarballPath: packed.path, tarballSize: 4, sourceHash: 'sha256:test' })),
    cleanup: vi.fn(),
  };
});

vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return { ...actual, requireAuth: vi.fn(() => ({ pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' })) };
});

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    resolveConfig: vi.fn(),
    loadProjectConfig: vi.fn(() => null),
    loadConfig: vi.fn(() => ({})),
    saveConfig: vi.fn(),
  };
});

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool';
const ACCESS = {
  userAuthMode: 'byo',
  userAuthConfig: { issuerUrl: ISSUER, audience: 'client-123' },
  allowedDomains: ['https://app.example.com'],
  guestAccess: false,
};

/** The app as `GET /apps/:id` projects it — the `{ app }` envelope the server answers. */
interface StoredApp {
  userAuthMode: string | null;
  userAuthConfig: { issuerUrl: string | null; audience: string | null } | null;
  allowedDomains: string[];
  guestAccess: boolean | null;
}
const STORED_DEFAULT: StoredApp = { userAuthMode: null, userAuthConfig: null, allowedDomains: [], guestAccess: null };

describe('deploy() --code — app.access converges before the trigger (guuey#2358)', () => {
  let dir: string;
  let originalCwd: string;
  let fetchSpy: MockInstance<typeof fetch>;
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  function mockPlatform(opts: { stored: StoredApp; putStatus?: number; putBody?: unknown }): void {
    fetchSpy.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/apps/app-1/deploy/upload')) {
        return new Response(JSON.stringify({ uploadUrl: 'https://s3.test/upload', uploadId: 'up-1', buildNumber: 1 }), { status: 200 });
      }
      if (url === 'https://s3.test/upload') return new Response('', { status: 200 });
      if (url.endsWith('/apps/app-1/deploy/trigger')) return new Response(JSON.stringify({ buildNumber: 1 }), { status: 202 });
      if (url.includes('/deployments/1/status')) {
        return new Response(JSON.stringify({ status: 'live', endpointUrl: 'https://app-1.guuey.app', errorMessage: null, pageUrl: 'https://app-1.agents.guuey.test/' }), { status: 200 });
      }
      if (url.endsWith('/apps/app-1') && method === 'PUT') {
        return new Response(JSON.stringify(opts.putBody ?? { app: { id: 'app-1' } }), { status: opts.putStatus ?? 200 });
      }
      if (url.endsWith('/apps/app-1')) {
        return new Response(JSON.stringify({ app: { id: 'app-1', chatTheme: null, ...opts.stored } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
  }

  function callIndex(match: (url: string, method: string) => boolean): number {
    return fetchSpy.mock.calls.findIndex(([u, init]) => match(String(u), init?.method ?? 'GET'));
  }
  const isAccessPut = (url: string, method: string): boolean => url.endsWith('/apps/app-1') && method === 'PUT';
  const isTrigger = (url: string): boolean => url.endsWith('/deploy/trigger');

  function writeProject(app: unknown): void {
    writeFileSync(
      join(dir, 'guuey.json'),
      JSON.stringify({ schema: '1', appId: 'app-1', agent: { mode: 'code' }, ...(app === undefined ? {} : { app }) }),
    );
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-code-access-test-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'tsup' } }));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'guuey.worker.js'), '// built worker');
    packed.path = join(dir, 'source.tar.gz');
    writeFileSync(packed.path, 'tar!');
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({ host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test', appId: 'app-1' });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('a byo app.access is PUT on the app BEFORE the trigger, and the Access: line names mode, issuer host and guest access', async () => {
    writeProject({ access: ACCESS });
    mockPlatform({ stored: STORED_DEFAULT });
    await deploy({ code: true });
    const put = callIndex(isAccessPut);
    const trigger = callIndex(isTrigger);
    expect(put).toBeGreaterThanOrEqual(0);
    expect(trigger).toBeGreaterThan(put);
    expect(JSON.parse(String(fetchSpy.mock.calls[put]![1]?.body))).toEqual(ACCESS);
    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain(
      'Access: app.access applied (userAuthMode, userAuthConfig, allowedDomains, guestAccess) — mode byo · issuer cognito-idp.us-east-1.amazonaws.com · guest access off.',
    );
  });

  it('only the fields that do not already hold are sent', async () => {
    writeProject({ access: ACCESS });
    mockPlatform({ stored: { ...STORED_DEFAULT, userAuthMode: 'byo', guestAccess: false, allowedDomains: ['https://app.example.com'] } });
    await deploy({ code: true });
    const put = callIndex(isAccessPut);
    expect(JSON.parse(String(fetchSpy.mock.calls[put]![1]?.body))).toEqual({ userAuthConfig: ACCESS.userAuthConfig });
  });

  it('access already in place → no write, the line says so, the deploy goes on', async () => {
    writeProject({ access: ACCESS });
    mockPlatform({ stored: { userAuthMode: 'byo', userAuthConfig: { issuerUrl: ISSUER, audience: 'client-123' }, allowedDomains: ['https://app.example.com'], guestAccess: false } });
    await deploy({ code: true });
    expect(callIndex(isAccessPut)).toBe(-1);
    expect(callIndex(isTrigger)).toBeGreaterThanOrEqual(0);
    expect(logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')).toContain(
      'Access: app.access already in place — mode byo · issuer cognito-idp.us-east-1.amazonaws.com · guest access off.',
    );
  });

  it('a refused write STOPS the deploy before the trigger and prints the server message', async () => {
    writeProject({ access: ACCESS });
    mockPlatform({
      stored: STORED_DEFAULT,
      putStatus: 400,
      putBody: { error: { code: 'VALIDATION_ERROR', message: 'userAuthConfig.issuerUrl is not a trusted issuer' } },
    });
    await expect(deploy({ code: true })).rejects.toMatchObject({ code: 1 });
    expect(callIndex(isTrigger)).toBe(-1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('app.access was NOT applied — [VALIDATION_ERROR] userAuthConfig.issuerUrl is not a trusted issuer');
    expect(printed).toContain('The deploy stopped before going live');
  });

  it('no app.access → the app access is never written, and nothing new is printed', async () => {
    writeProject(undefined);
    mockPlatform({ stored: STORED_DEFAULT });
    await deploy({ code: true });
    expect(callIndex(isAccessPut)).toBe(-1);
    expect(callIndex(isTrigger)).toBeGreaterThanOrEqual(0);
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).not.toContain('Access:');
  });
});
