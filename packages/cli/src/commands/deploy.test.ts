import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { createLinkedApp, deploy, pollDeployStatus, portalLine, portalOriginForHost } from './deploy.js';
import { resolveConfig, loadProjectConfig } from '../config.js';
import type { apiRequest } from '../deploy-shared.js';

/** Thrown by the process.exit mock so execution stops like the real thing. */
class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

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
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
    })),
    loadProjectConfig: vi.fn(() => null),
    loadConfig: vi.fn(() => ({})),
    saveConfig: vi.fn(),
  };
});

// Regression coverage for the "polls a nonexistent route with the wrong
// field names" bug: the real backend route is
// `GET /apps/:id/deployments/:n/status` (NOT `/deploy/status/:n`), and its
// projection (`handlers/deploy.ts#handleGetDeploymentStatus`) returns
// `endpointUrl`/`errorMessage` (NOT `url`/`error`). Every stub here uses that
// REAL shape.
describe('pollDeployStatus', () => {
  const auth = { pat: 'pat-test' };
  const config = { apiUrl: 'https://api.guuey.test' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'polls GET /apps/:id/deployments/:n/status and maps endpointUrl -> url once status is live',
    async () => {
      const calls: { method: string; path: string }[] = [];
      const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path) => {
        calls.push({ method, path });
        return new Response(
          JSON.stringify({
            appId: 'app-1',
            buildNumber: 4,
            status: 'live',
            endpointUrl: 'https://app-1.guuey.app',
            errorMessage: null,
            updatedAt: '2026-07-03T00:00:00.000Z',
            deployedAt: '2026-07-03T00:00:00.000Z',
          }),
          { status: 200 },
        );
      });

      const result = await pollDeployStatus(
        { auth, config, appId: 'app-1', buildNumber: 4, timeoutMs: 60_000 },
        { api },
      );

      expect(result).toEqual({ status: 'live', url: 'https://app-1.guuey.app' });
      expect(calls).toEqual([{ method: 'GET', path: '/apps/app-1/deployments/4/status' }]);
    },
    10_000,
  );

  it(
    'progresses through queued -> live, printing each distinct `message`',
    async () => {
      const responses = [
        { status: 'queued', endpointUrl: null, errorMessage: null, message: undefined },
        { status: 'building', endpointUrl: null, errorMessage: null, message: 'Building image...' },
        { status: 'live', endpointUrl: 'https://app-1.guuey.app', errorMessage: null, message: undefined },
      ];
      let call = 0;
      const api: typeof apiRequest = vi.fn(async () => {
        const body = responses[Math.min(call, responses.length - 1)];
        call += 1;
        return new Response(JSON.stringify(body), { status: 200 });
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await pollDeployStatus(
        { auth, config, appId: 'app-1', buildNumber: 4, timeoutMs: 60_000 },
        { api },
      );

      expect(result.status).toBe('live');
      expect(logSpy.mock.calls.flat()).toContain('  Building image...');
    },
    15_000,
  );

  it(
    'reads errorMessage (not error) from the real projection shape, prints it, and exits 1',
    async () => {
      const api: typeof apiRequest = vi.fn(async () =>
        new Response(
          JSON.stringify({
            appId: 'app-1',
            buildNumber: 4,
            status: 'failed',
            endpointUrl: null,
            errorMessage: 'Kaniko build failed: exit 1',
            updatedAt: '2026-07-03T00:00:00.000Z',
            deployedAt: null,
          }),
          { status: 200 },
        ),
      );
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => {
          throw new Error('__process_exit__');
        });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        pollDeployStatus(
          { auth, config, appId: 'app-1', buildNumber: 4, timeoutMs: 60_000 },
          { api },
        ),
      ).rejects.toThrow('__process_exit__');

      expect(errorSpy.mock.calls.flat()).toContain('✗ Kaniko build failed: exit 1');
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
    10_000,
  );
});

// Regression coverage for S12: the printed Portal line was a hardcoded prod
// origin + no route, even for a dev-env deploy. `portalLine`/`portalOriginForHost`
// mirror the live-verified prefix map in `apps/platform/src/lib/env.ts#getPortalUrl`.
describe('portalOriginForHost / portalLine', () => {
  it('maps a dev sandbox platform host to the dev sandbox portal origin', () => {
    expect(portalOriginForHost('https://dev.platform.sandbox.guuey.com')).toBe(
      'https://dev.app.sandbox.guuey.com',
    );
  });

  it('maps a staging sandbox platform host to the staging sandbox portal origin', () => {
    expect(portalOriginForHost('https://staging.platform.sandbox.guuey.com')).toBe(
      'https://staging.app.sandbox.guuey.com',
    );
  });

  it('maps the production platform host to the production portal origin', () => {
    expect(portalOriginForHost('https://platform.guuey.com')).toBe('https://app.guuey.com');
  });

  it('returns null (never a guessed origin) for an unrecognized host', () => {
    expect(portalOriginForHost('http://localhost:3000')).toBeNull();
    expect(portalOriginForHost(undefined)).toBeNull();
    expect(portalOriginForHost('not a url')).toBeNull();
  });

  it('portalLine prints the env-mapped origin + /agent/<id> route', () => {
    expect(portalLine('https://dev.platform.sandbox.guuey.com', 'app-1')).toBe(
      'https://dev.app.sandbox.guuey.com/agent/app-1',
    );
  });

  it('portalLine returns null (omit the line) for an unrecognized host', () => {
    expect(portalLine('http://localhost:3000', 'app-1')).toBeNull();
  });
});

// Regression coverage for S9: deploy's interactive app-create offer sent
// `{name, userAuthMode}` (the API wants `displayName`) and parsed
// `{appId, apiKey}` (the handler returns `{app: {id, displayName}}` — no
// apiKey at all). `createLinkedApp` is the testable core split out of
// `ensureLinkedApp` so this doesn't require driving the readline prompt.
describe('createLinkedApp (S9)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends {displayName, userAuthMode} and parses the real {app} response shape', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ app: { id: 'app-1', displayName: 'My Agent' } }), {
        status: 201,
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const appId = await createLinkedApp({
      auth: { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' },
      config: { host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test' },
      project: null,
      guueyJsonPath: '/does/not/matter/guuey.json',
      appName: 'My Agent',
    });

    expect(appId).toBe('app-1');
    const [url, init] = fetchSpy.mock.calls.at(-1)!;
    expect(new URL(String(url)).pathname).toBe('/apps');
    expect(JSON.parse(String(init?.body))).toEqual({
      displayName: 'My Agent',
      userAuthMode: 'anonymous',
    });
  });

  it('prints the created app\'s displayName and id (not undefined)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ app: { id: 'app-42', displayName: 'Weather Bot' } }), {
        status: 201,
      }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createLinkedApp({
      auth: { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' },
      config: { host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test' },
      project: null,
      guueyJsonPath: '/does/not/matter/guuey.json',
      appName: 'Weather Bot',
    });

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Weather Bot');
    expect(output).toContain('app-42');
  });

  it('a non-ok create response prints the wire envelope message and exits 1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'VALIDATION', message: 'displayName is required' } }),
        { status: 400 },
      ),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });

    await expect(
      createLinkedApp({
        auth: { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' },
        config: { host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test' },
        project: null,
        guueyJsonPath: '/does/not/matter/guuey.json',
        appName: '',
      }),
    ).rejects.toBeInstanceOf(ExitSignal);

    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('displayName is required');
    expect(printed).not.toContain('[object Object]');
  });
});

// Regression coverage for S4: the non-TTY "no app linked" error pointed at
// "guuey create" — which never mints an appId — a dead end. The fix names
// only the actions that actually resolve an appId.
describe('deploy() — no app linked, no interactive offer (S4)', () => {
  let dir: string;
  let originalCwd: string;
  let exitSpy: MockInstance<typeof process.exit>;
  let errSpy: MockInstance<typeof console.error>;
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-notty-test-'));
    // A guuey.json with no `agent.mode` + no Dockerfile resolves to
    // 'declarative' (deploy-plan.ts#resolveDeployMode) — NOT
    // 'code-orchestrated', so the interactive create-offer never applies
    // regardless of TTY state, and the plain fail-fast error fires.
    writeFileSync(join(dir, 'guuey.json'), JSON.stringify({ agent: {} }));
    process.chdir(dir);

    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);

    fetchSpy = vi.spyOn(globalThis, 'fetch');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prints the actionable message (never "guuey create", which mints no appId) and exits 1', async () => {
    await expect(deploy({})).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('guuey link');
    expect(printed).not.toContain('guuey create');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
