import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  printTriggerWarnings,
  awaitPageUrl,
  createLinkedApp,
  deploy,
  pollDeployStatus,
  portalLine,
  portalOriginForHost,
  printPageLine, printPodLifetime,
  ensureInstalled,
} from './deploy.js';
import { DEPLOY_WAIT_MS, NODE_PROVISION_BUDGET_MS, stillDeployingMessage } from './deploy-wait.js';
import { resolveConfig, loadProjectConfig } from '../config.js';

// guuey#1000 — the code-mode deploy runs `corepack pnpm install` / `corepack
// pnpm build` through execSync. Recorded (never run) so the auto-install
// case below can prove ORDER against the fetch spy: the install is the first
// thing the deploy does, before any leg leaves the machine.
const childProcessLog = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn((command: string) => {
      childProcessLog.calls.push(String(command));
      return Buffer.from('');
    }),
  };
});
import { resolveDeployTarget } from './deploy.js';
import { defaultModelFor, isOfferedModel, safeParseGuueyJson } from '@guuey/config';
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

      expect(result).toEqual({
        status: 'live',
        url: 'https://app-1.guuey.app',
        pageUrl: null,
        timedOut: false,
      });
      expect(calls).toEqual([{ method: 'GET', path: '/apps/app-1/deployments/4/status' }]);
    },
    10_000,
  );

  it(
    'carries the projection\'s pageUrl through (guuey#249) — read, never derived',
    async () => {
      const api: typeof apiRequest = vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: 'live',
            endpointUrl: 'https://app-1.guuey.app',
            errorMessage: null,
            pageUrl: 'https://weather-bot-k7q2.agents.guuey.test/',
          }),
          { status: 200 },
        ),
      );
      const result = await pollDeployStatus(
        { auth, config, appId: 'app-1', buildNumber: 4, timeoutMs: 60_000 },
        { api },
      );
      expect(result.pageUrl).toBe('https://weather-bot-k7q2.agents.guuey.test/');
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
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await pollDeployStatus(
        { auth, config, appId: 'app-1', buildNumber: 4, timeoutMs: 60_000 },
        { api },
      );

      expect(result.status).toBe('live');
      // Progress goes to STDERR (guuey#280 CI find): under `--json`,
      // stdout must stay a single machine-clean JSON document — progress
      // lines on stdout corrupted `agent apply --wait --json > file`.
      expect(errSpy.mock.calls.flat()).toContain('  Building image...');
      expect(logSpy.mock.calls.flat()).toEqual([]);
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

  it('when the wait runs out it RETURNS the last status with timedOut: true — never exits, never says "timed out" (guuey#759)', async () => {
    // The row keeps saying `deploying` past the wait: a lg/xl deploy that
    // needed a NEW node was Ready at 2 min 53 s and `live` ~18 min after
    // start on dev while the old 7-minute wait had already exited 1 (QA,
    // 2026-09-04). The caller says "still deploying" and exits 0.
    const api: typeof apiRequest = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            appId: 'app-1',
            buildNumber: 4,
            status: 'deploying',
            message: 'Provisioning pod...',
            endpointUrl: null,
            errorMessage: null,
          }),
          { status: 200 },
        ),
    );
    let clock = 0;
    const now = (): number => clock;
    const sleep = async (ms: number): Promise<void> => {
      clock += ms;
    };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__process_exit__');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await pollDeployStatus(
      { auth, config, appId: 'app-1', buildNumber: 4, timeoutMs: 10_000 },
      { api, sleep, now },
    );

    expect(result).toEqual({ status: 'deploying', url: '', pageUrl: null, timedOut: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join('\n')).not.toMatch(/timed out/i);
    // The wait is measured on the injected clock: 10 s budget, 3 s per tick → 4 polls.
    expect(vi.mocked(api)).toHaveBeenCalledTimes(4);
  });

  it('DEPLOY_WAIT_MS is never shorter than the controller node-provision budget (mirror; the controller sync test pins the value)', () => {
    expect(DEPLOY_WAIT_MS).toBeGreaterThanOrEqual(NODE_PROVISION_BUDGET_MS + 5 * 60 * 1000);
    expect(stillDeployingMessage(DEPLOY_WAIT_MS)).toContain('Still deploying after 22 minutes');
    expect(stillDeployingMessage(DEPLOY_WAIT_MS)).not.toMatch(/timed out|failed/i);
  });
});

// guuey#249 — the "Your agent's page" line. The default slug is claimed
// SERVER-SIDE on the row's first `→ live` edge (deployStream), so the poll
// that sees `live` on a first deploy can beat it by a second or two; the CLI
// re-reads the status route for a bounded window and prints ONLY what the
// server hands back.
describe('awaitPageUrl / printPageLine (guuey#249)', () => {
  const auth = { pat: 'pat-test' };
  const config = { apiUrl: 'https://api.guuey.test' };
  const noSleep = async () => {};

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the poll\'s pageUrl immediately without another request', async () => {
    const api = vi.fn<typeof apiRequest>();
    const url = await awaitPageUrl(
      { auth, config, appId: 'app-1', buildNumber: 4, pageUrl: 'https://x.agents.guuey.test/' },
      { api, sleep: noSleep },
    );
    expect(url).toBe('https://x.agents.guuey.test/');
    expect(api).not.toHaveBeenCalled();
  });

  it('re-reads the status route until the server-side claim lands, then returns that URL', async () => {
    const bodies = [
      { status: 'live', endpointUrl: 'https://e', errorMessage: null, pageUrl: null },
      { status: 'live', endpointUrl: 'https://e', errorMessage: null, pageUrl: null },
      { status: 'live', endpointUrl: 'https://e', errorMessage: null, pageUrl: 'https://weather-bot-k7q2.agents.guuey.test/' },
    ];
    let call = 0;
    const paths: string[] = [];
    const api: typeof apiRequest = vi.fn(async (_pat, _cfg, _method, path) => {
      paths.push(path);
      const body = bodies[Math.min(call, bodies.length - 1)];
      call += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const url = await awaitPageUrl(
      { auth, config, appId: 'app-1', buildNumber: 4, pageUrl: null, waitMs: 60_000 },
      { api, sleep: noSleep },
    );
    expect(url).toBe('https://weather-bot-k7q2.agents.guuey.test/');
    expect(paths).toEqual(Array(3).fill('/apps/app-1/deployments/4/status'));
  });

  it('gives up with null after the wait window — the deploy is still a success, no guessed URL', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({ status: 'live', endpointUrl: 'https://e', errorMessage: null, pageUrl: null }),
        { status: 200 },
      ),
    );
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const sleep = async (ms: number) => {
      now += ms;
    };
    const url = await awaitPageUrl(
      { auth, config, appId: 'app-1', buildNumber: 4, pageUrl: null, waitMs: 6_000 },
      { api, sleep },
    );
    expect(url).toBeNull();
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('printPageLine prints the one line for a URL and nothing for null', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printPageLine('https://weather-bot-k7q2.agents.guuey.test/');
    printPageLine(null);
    expect(logSpy.mock.calls.flat()).toEqual([
      "  Your agent's page: https://weather-bot-k7q2.agents.guuey.test/",
    ]);
  });

  // guuey#933: `deploy --max-pods N` with no scaling mode chosen lands a FIXED
  // count (the auto-scaler off) — the line after the deploy says so and names
  // the knob that keeps N a ceiling. Without a limit there is no regime claim.
  it('printPodLifetime: a set limit names the regime it runs under and the knob that keeps it a ceiling (guuey#933)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printPodLifetime(3);
    const withLimit = logSpy.mock.calls.flat().join('\n');
    expect(withLimit).toMatch(/fixed count/);
    expect(withLimit).toMatch(/auto-scaler is off/);
    expect(withLimit).toContain('guuey agent config --scaling auto');
    logSpy.mockClear();
    printPodLifetime(undefined);
    expect(logSpy.mock.calls.flat().join('\n')).not.toMatch(/auto-scaler/);
  });
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
// `{name}` (the API wants `displayName`) and parsed `{appId, apiKey}` (the
// handler returns `{app: {id, displayName}}` — no apiKey at all).
// `createLinkedApp` is the testable core split out of `ensureLinkedApp` so
// this doesn't require driving the readline prompt.
describe('createLinkedApp (S9)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends {displayName} and parses the real {app} response shape', async () => {
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
    });
  });

  // The create carries the manifest's own intent (his 2026-09-08 sweep — a
  // CLI-created app used to land with intendedFramework/intendedModel NULL,
  // so the console's create-time faces read "Not recorded on the app" for a
  // framework the manifest declared). The rules: the framework rides when
  // it is a mint framework (`vanilla` has no create-time intent); the model
  // rides ONLY when the registry offers it on that framework — a manifest
  // with an unlisted model must still create (the documented
  // "set agent.model in guuey.json and run guuey deploy" path).
  it("carries the manifest's framework AND its model when the registry offers the model", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ app: { id: 'app-1', displayName: 'My Agent' } }), { status: 201 }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const model = defaultModelFor('openai-agents-sdk');
    const parsed = safeParseGuueyJson({ schema: '1', agent: { framework: 'openai-agents-sdk', model } });
    if (!parsed.success) throw new Error('fixture manifest must parse');

    await createLinkedApp({
      auth: { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' },
      config: { host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test' },
      project: parsed.data,
      guueyJsonPath: join(mkdtempSync(join(tmpdir(), 'create-intent-')), 'guuey.json'),
      appName: 'My Agent',
    });
    const [, init] = fetchSpy.mock.calls.at(-1)!;
    expect(JSON.parse(String(init?.body))).toEqual({
      displayName: 'My Agent',
      intendedFramework: 'openai-agents-sdk',
      intendedModel: model,
    });
  });

  it('carries the framework but NOT an unlisted model — the create must not refuse what the deploy honors', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ app: { id: 'app-1', displayName: 'My Agent' } }), { status: 201 }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const parsed = safeParseGuueyJson({
      schema: '1',
      agent: { framework: 'google-adk', model: 'gemini-test-unlisted-0' },
    });
    if (!parsed.success) throw new Error('fixture manifest must parse');
    expect(isOfferedModel('google-adk', 'gemini-test-unlisted-0')).toBe(false);

    await createLinkedApp({
      auth: { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' },
      config: { host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test' },
      project: parsed.data,
      guueyJsonPath: join(mkdtempSync(join(tmpdir(), 'create-intent-')), 'guuey.json'),
      appName: 'My Agent',
    });
    const [, init] = fetchSpy.mock.calls.at(-1)!;
    expect(JSON.parse(String(init?.body))).toEqual({
      displayName: 'My Agent',
      intendedFramework: 'google-adk',
    });
  });

  it('a vanilla manifest carries no intent at all — vanilla is not a mint framework', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ app: { id: 'app-1', displayName: 'My Agent' } }), { status: 201 }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const parsed = safeParseGuueyJson({ schema: '1', agent: { framework: 'vanilla' } });
    if (!parsed.success) throw new Error('fixture manifest must parse');

    await createLinkedApp({
      auth: { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' },
      config: { host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test' },
      project: parsed.data,
      guueyJsonPath: join(mkdtempSync(join(tmpdir(), 'create-intent-')), 'guuey.json'),
      appName: 'My Agent',
    });
    const [, init] = fetchSpy.mock.calls.at(-1)!;
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: 'My Agent' });
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

  it("an off-registry model refusal prints the server's typed reason — code and all — and exits 1 (guuey#647)", async () => {
    // `POST /v1/apps` refuses an off-registry `intendedModel` with
    // MODEL_NOT_IN_REGISTRY (backend `shared/create-intent.ts`). The CLI
    // does not judge models itself — `guuey deploy`'s own `agent.model` is
    // the honor-explicitly path the reason points at, and `reconcile` never
    // validates it — so this door's job is to print the server's word
    // WHOLE: the code, the id, the offered ids and the guuey.json pointer.
    const reason =
      'intendedModel "claude-test-off-registry-9" is not in the model registry. ' +
      'Offered for claude-agent-sdk: claude-sonnet-5, claude-opus-5. ' +
      'To run an unlisted model, set agent.model in guuey.json and run guuey deploy.';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'MODEL_NOT_IN_REGISTRY', message: reason } }), {
        status: 400,
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });

    await expect(
      createLinkedApp({
        auth: { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' },
        config: { host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test' },
        project: null,
        guueyJsonPath: '/does/not/matter/guuey.json',
        appName: 'My Agent',
      }),
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('[MODEL_NOT_IN_REGISTRY]');
    expect(printed).toContain(reason);
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
    expect(printed).toContain('guuey pull --app-id');
    expect(printed).not.toContain('guuey create');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── guuey#355: the machine-global default must NOT reach a bound-less
  // project's deploy. The near-miss: ~/.guuey/config.json carried the LIVE
  // Helper's id from a provisioning ritual, and a bare deploy from the
  // trimly checkout (guuey.json with deliberately NO appId) resolved to
  // it — an explicit --app-id on the staged line was the only guard.
  it('a project WITHOUT appId REFUSES even when the global config carries a default', async () => {
    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      // The merged config carries a stale machine-global default — the id
      // that must never silently become this deploy's target.
      appId: '934f99ad-dead-beef-0000-000000000000',
    });
    // The overlay mirrors the on-disk guuey.json: present, deliberately
    // UNBOUND (no appId) — the trimly-checkout shape from the near-miss.
    const parsed = safeParseGuueyJson({
      schema: '1',
      agent: { model: 'claude-sonnet-5', systemPrompt: 'x' },
    });
    if (!parsed.success) throw new Error('test fixture is schema-invalid');
    vi.mocked(loadProjectConfig).mockReturnValue(parsed.data);

    await expect(deploy({})).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('carries no "appId"');
    expect(printed).toContain('deliberately NOT used');
    // And no deploy call ever left the machine.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Whole-branch follow-up fix (colocated MCP slice): a colocated server's
// NAME is schema-typed only `z.string().min(1)`, but at pod boot
// `lowerColocated` composes it into `colocatedResourceUrl(appId, name)`,
// which THROWS for anything outside `/^[A-Za-z0-9_-]+$/` — an unactionable
// POD_FATAL_BOOT_ERROR crash-loop. `validateColocatedServerNames`
// (`@guuey/config`) is the deploy-time pre-flight `deployDeclarative` runs
// right before the trigger POST; these tests drive the real `deploy()`
// declarative path end-to-end (appId linked, no Dockerfile/agent.mode ->
// 'declarative' per `deploy-plan.ts#resolveDeployMode`).
describe('deploy() — colocated MCP server-name validation (deploy-time gate)', () => {
  let dir: string;
  let originalCwd: string;
  let exitSpy: MockInstance<typeof process.exit>;
  let errSpy: MockInstance<typeof console.error>;
  let fetchSpy: MockInstance<typeof fetch>;

  function writeGuueyJson(colocatedName: string): void {
    writeFileSync(
      join(dir, 'guuey.json'),
      JSON.stringify({
        schema: '1',
        agent: {
          mcpServers: {
            [colocatedName]: { kind: 'colocated', source: './mcps/tool' },
          },
        },
      }),
    );
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-colocated-name-test-'));
    process.chdir(dir);

    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);

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

  it('rejects a colocated name with a space, printing the actionable message, before any network call', async () => {
    writeGuueyJson('my tool');
    fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(deploy({})).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain(
      'colocated MCP server name "my tool" is invalid — use only letters, digits, hyphen, underscore (it becomes part of a URL and a storage scope)',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it(
    'a valid colocated name passes the gate (deploy proceeds to the trigger call)',
    async () => {
      writeGuueyJson('notes_v1');
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/deploy/trigger')) {
          return new Response(JSON.stringify({ buildNumber: 1 }), { status: 202 });
        }
        if (url.includes('/deployments/1/status')) {
          return new Response(
            JSON.stringify({ status: 'live', endpointUrl: 'https://app-1.guuey.app', errorMessage: null, pageUrl: 'https://app-k7q2.agents.guuey.test/' }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      await deploy({});

      const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(printed).not.toContain('colocated MCP server name');
      expect(fetchSpy).toHaveBeenCalled();
      const triggerCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('/deploy/trigger'));
      expect(triggerCall).toBeDefined();
    },
    10_000,
  );
});

// `guuey deploy --max-pods N` (scaling S1-F4, guuey#162): the flag rides
// `DeployTriggerBody.maxPods` at every trigger POST. Driven through the
// declarative shape — it is the one that reaches the trigger with no
// tarball, no build, and no S3 round trip — plus a body-literal guard that
// the other two shapes carry the field too.
describe('deploy() — --max-pods rides the trigger body', () => {
  let dir: string;
  let originalCwd: string;
  let exitSpy: MockInstance<typeof process.exit>;
  let errSpy: MockInstance<typeof console.error>;
  let fetchSpy: MockInstance<typeof fetch>;

  /** The trigger POST's parsed JSON body, or `undefined` if it never fired. */
  function triggerBody(): Record<string, unknown> | undefined {
    const call = fetchSpy.mock.calls.find(([u]) => String(u).includes('/deploy/trigger'));
    if (!call) return undefined;
    return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-max-pods-test-'));
    writeFileSync(join(dir, 'guuey.json'), JSON.stringify({ schema: '1', agent: {} }));
    process.chdir(dir);

    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);

    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/deploy/trigger')) {
        return new Response(JSON.stringify({ buildNumber: 1 }), { status: 202 });
      }
      if (url.includes('/deployments/1/status')) {
        return new Response(
          JSON.stringify({ status: 'live', endpointUrl: 'https://app-1.guuey.app', errorMessage: null, pageUrl: 'https://app-k7q2.agents.guuey.test/' }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sends maxPods on the trigger body when the flag is given', async () => {
    await deploy({ 'max-pods': '3' });

    expect(triggerBody()?.maxPods).toBe(3);
  });

  it('OMITS maxPods when the flag is absent, so a redeploy never resets the knob', async () => {
    await deploy({});

    const body = triggerBody();
    expect(body).toBeDefined();
    expect(body).not.toHaveProperty('maxPods');
  });

  it.each(['0', '-2', '1.5', 'many', ''])(
    'rejects --max-pods %j client-side, before any network call',
    async (value) => {
      await expect(deploy({ 'max-pods': value })).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(printed).toContain('--max-pods must be a positive integer');
    },
  );

  it('rejects a valueless --max-pods (parsed as `true`) rather than sending NaN', async () => {
    await expect(deploy({ 'max-pods': true })).rejects.toBeInstanceOf(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces the server 409 with its code (the ceiling is the server\'s to name)', async () => {
    fetchSpy.mockImplementation(async (input) => {
      if (String(input).includes('/deploy/trigger')) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AGENT_MAX_PODS',
              message: "maxPods 9 exceeds this app's ceiling of 3 (the Free plan's limit).",
            },
          }),
          { status: 409 },
        );
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });

    await expect(deploy({ 'max-pods': '9' })).rejects.toBeInstanceOf(ExitSignal);

    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('[AGENT_MAX_PODS]');
    expect(printed).toContain("ceiling of 3");
  });
});

// The declarative test above proves ONE of the three trigger POST sites
// carries the field. The other two (code-orchestrated, legacy Dockerfile)
// each need a build + tarball + presigned-S3 round trip to reach their
// trigger, which this suite has no harness for — so they are pinned at the
// source level instead: every `/deploy/trigger` body literal in deploy.ts
// must spread maxPods. A new deploy shape that forgets the field fails here.
describe('deploy.ts — every trigger POST site carries maxPods', () => {
  it('all three body literals spread the knob', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./deploy.ts', import.meta.url)),
      'utf8',
    );
    const triggerPosts = source.split("'POST', `/apps/${appId}/deploy/trigger`").slice(1);
    expect(triggerPosts).toHaveLength(3);
    for (const site of triggerPosts) {
      const body = site.slice(0, site.indexOf('});'));
      expect(body).toContain('...(maxPods !== undefined ? { maxPods } : {})');
    }
  });
});

describe('deploy() — --app-id overrides the guuey.json binding (guuey#232)', () => {
  let dir: string;
  let originalCwd: string;
  let fetchSpy: MockInstance<typeof fetch>;

  function triggerUrl(): string | undefined {
    const call = fetchSpy.mock.calls.find(([u]) => String(u).includes('/deploy/trigger'));
    return call ? String(call[0]) : undefined;
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-app-id-test-'));
    writeFileSync(join(dir, 'guuey.json'), JSON.stringify({ schema: '1', appId: 'app-bound', agent: {} }));
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-bound',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/deploy/trigger')) {
        return new Response(JSON.stringify({ buildNumber: 1 }), { status: 202 });
      }
      if (url.includes('/deployments/1/status')) {
        return new Response(
          JSON.stringify({ status: 'live', endpointUrl: 'https://x.guuey.app', errorMessage: null, pageUrl: 'https://x-k7q2.agents.guuey.test/' }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('★ a bound scaffold + --app-id Y deploys to Y — never silently to the bound id', async () => {
    await deploy({ 'app-id': 'app-other' });
    expect(triggerUrl()).toContain('/apps/app-other/deploy/trigger');
    expect(triggerUrl()).not.toContain('app-bound');
    // The binding on disk is untouched: an override is per-deploy, not a rebind.
    expect(JSON.parse(readFileSync(join(dir, 'guuey.json'), 'utf8')).appId).toBe('app-bound');
  });

  it('without the flag the binding is used, exactly as before', async () => {
    await deploy({});
    expect(triggerUrl()).toContain('/apps/app-bound/deploy/trigger');
  });

  it('a valueless --app-id (parsed as `true`) is rejected before any network call', async () => {
    await expect(deploy({ 'app-id': true })).rejects.toBeInstanceOf(ExitSignal);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('printTriggerWarnings (guuey#580 belt adoption)', () => {
  it('prints each warnings[] string verbatim with the CLI warn prefix; tolerates junk and absence', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });
    printTriggerWarnings({
      warnings: [
        'MODES_DROPPED_ON_DEPLOY: this snapshot drops agent.modes the live build carries — run guuey pull to seed.',
        '',
        42,
      ],
    });
    printTriggerWarnings({});
    printTriggerWarnings({ warnings: 'not-an-array' });
    printTriggerWarnings(null);
    expect(lines).toEqual([
      '  ! MODES_DROPPED_ON_DEPLOY: this snapshot drops agent.modes the live build carries — run guuey pull to seed.',
    ]);
    spy.mockRestore();
  });
});

// ── guuey#975: the deploy target is resolved SOURCE-AWARE and printed ──────
// The 2026-09-07 prod incident: a fresh scaffold (guuey.json, no appId)
// inherited `GGUI_APP_ID` from the operator's shell, `deploy` skipped the
// create and pushed assets at another env's app. The env var may re-target a
// project that has its OWN binding (an explicit per-invocation choice, #355)
// — it may never stand in for a create on an unbound project.

describe('resolveDeployTarget (guuey#975)', () => {
  it('--app-id wins over everything and names what it overrides', () => {
    const d = resolveDeployTarget({
      explicitAppId: 'app-flag',
      envAppId: 'app-env',
      projectBoundAppId: 'app-proj',
      hasProject: true,
      globalAppId: 'app-global',
    });
    expect(d).toMatchObject({ kind: 'bound', appId: 'app-flag', source: '--app-id' });
    expect(d.notes.join('\n')).toContain('overrides the guuey.json binding (app-proj)');
  });

  it('GUUEY_APP_ID re-targets a project that has its OWN binding — and says so', () => {
    const d = resolveDeployTarget({
      envAppId: 'app-env',
      projectBoundAppId: 'app-proj',
      hasProject: true,
    });
    expect(d).toMatchObject({ kind: 'bound', appId: 'app-env', source: 'GUUEY_APP_ID' });
    expect(d.notes.join('\n')).toContain('GUUEY_APP_ID overrides the guuey.json binding (app-proj)');
  });

  it('GUUEY_APP_ID is IGNORED for a project with no binding of its own — the create runs, with a note (the #798 incident shape)', () => {
    const d = resolveDeployTarget({
      envAppId: '5c8baf45-1c8f-4114-a82b-0ab938d47bd2',
      hasProject: true,
    });
    expect(d.kind).toBe('unbound');
    expect(d.notes.join('\n')).toContain('GUUEY_APP_ID=5c8baf45-1c8f-4114-a82b-0ab938d47bd2 ignored');
    expect(d.notes.join('\n')).toContain('--app-id');
  });

  it('a project binding is used and named; the global default is never used when a guuey.json exists', () => {
    expect(resolveDeployTarget({ projectBoundAppId: 'app-proj', hasProject: true, globalAppId: 'app-global' })).toMatchObject({
      kind: 'bound',
      appId: 'app-proj',
      source: 'guuey.json',
    });
    expect(resolveDeployTarget({ hasProject: true, globalAppId: 'app-global' })).toMatchObject({ kind: 'unbound' });
  });

  it('with no guuey.json at all, the env var then the global default apply (the single-project flow), each named', () => {
    expect(resolveDeployTarget({ envAppId: 'app-env', hasProject: false, globalAppId: 'app-global' })).toMatchObject({
      kind: 'bound',
      appId: 'app-env',
      source: 'GUUEY_APP_ID',
    });
    expect(resolveDeployTarget({ hasProject: false, globalAppId: 'app-global' })).toMatchObject({
      kind: 'bound',
      appId: 'app-global',
      source: 'global-config',
    });
    expect(resolveDeployTarget({ hasProject: false })).toMatchObject({ kind: 'unbound' });
  });
});

// ── guuey#989: the node_modules preflight runs BEFORE any leg talks to the platform ──
// The founder's 0.19.0 prod walk showed the order as shipped by #979:
// "✓ ggui assets pushed" and only THEN "No node_modules in …" — the asset
// leg had already mutated the app (full-state replace) for a deploy that
// could not build. The local project must be buildable before any leg
// leaves the machine.
describe('deploy() --code — the node_modules preflight precedes every platform leg (guuey#989)', () => {
  let dir: string;
  let originalCwd: string;
  let fetchSpy: MockInstance<typeof fetch>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-preflight-order-test-'));
    writeFileSync(
      join(dir, 'guuey.json'),
      JSON.stringify({
        schema: '1',
        appId: 'app-bound',
        agent: { framework: 'openai-agents-sdk' },
        ggui: { configFile: 'ggui.json' },
      }),
    );
    // A packable ggui.json, so the asset leg is LIVE — the point is that it
    // must not run, not that it cannot.
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify({ gadgets: [] }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'tsup' } }));
    // Deliberately NO node_modules.
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-bound',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/ggui-assets/push')) {
        return new Response(JSON.stringify({ pushed: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('★ --no-install: a bound code project with NO node_modules refuses with the install line BEFORE any ggui asset push', async () => {
    await expect(deploy({ code: true, 'no-install': true })).rejects.toBeInstanceOf(ExitSignal);
    expect(errorSpy.mock.calls.flat().join('\n')).toMatch(/No node_modules in /);
    // Nothing left the machine: no asset push (and no other leg) before the refusal.
    expect(fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/ggui-assets/push'))).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(childProcessLog.calls).toEqual([]);
  });

  // guuey#1000 — founder ruling, verbatim: "i prefer auto install". The
  // default is no longer a refusal: a missing node_modules is installed,
  // FIRST, before any leg talks to the platform.
  it('★ by default a missing node_modules is INSTALLED first — before the ggui asset push or any other fetch', async () => {
    // The tail of the deploy (pack, upload, trigger) is not under test here;
    // whatever it does after the install, the order below is the claim.
    await deploy({ code: true }).catch(() => undefined);
    expect(childProcessLog.calls[0]).toBe('corepack pnpm install');
    const firstFetchAt = fetchSpy.mock.invocationCallOrder[0];
    const installAt = vi.mocked((await import('node:child_process')).execSync).mock.invocationCallOrder[0];
    expect(installAt).toBeDefined();
    if (firstFetchAt !== undefined) expect(installAt).toBeLessThan(firstFetchAt);
    expect(errorSpy.mock.calls.flat().join('\n')).not.toMatch(/No node_modules in /);
  });
});

// ── guuey#979: code-mode deploy preflights node_modules ─────────────────────
// The founder's first prod deploy (2026-09-07) ran `corepack pnpm build` in a
// fresh scaffold with no node_modules and died inside the build ("sh: tsup:
// command not found"); the only install instruction on screen was pnpm's own
// WARN. The preflight says it in our voice BEFORE any build. Since guuey#1000
// (his word: "i prefer auto install") the default INSTALLS; `--no-install`
// is the refusal — these pins cover the function's two arms as such.
describe('ensureInstalled (guuey#979 / #1000)', () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const io = (present: Set<string>) => ({
    exists: (p: string) => present.has(p),
    run: (cmd: string) => {
      calls.push(cmd);
    },
    log: (line: string) => {
      logs.push(line);
    },
  });
  beforeEach(() => {
    calls.length = 0;
    logs.length = 0;
  });

  it('--no-install: a project with package.json and NO node_modules refuses BEFORE any build, naming the opt-out and the install line', () => {
    const r = ensureInstalled({ root: '/p', install: false, ...io(new Set(['/p/package.json'])) });
    expect(r).toMatchObject({ kind: 'missing' });
    expect(r.kind === 'missing' ? r.message : '').toMatch(/No node_modules in \/p/);
    // guuey#1000: the refusal is the --no-install face now — it names the
    // opt-out the caller chose, never a flag to add.
    expect(r.kind === 'missing' ? r.message : '').toMatch(/--no-install/);
    expect(r.kind === 'missing' ? r.message : '').not.toMatch(/pass --install/);
    expect(r.kind === 'missing' ? r.message : '').toMatch(/corepack pnpm install/);
    expect(calls).toEqual([]);
  });

  it('by default it runs the project package manager install in the project root, says so, then proceeds', () => {
    const r = ensureInstalled({ root: '/p', install: true, ...io(new Set(['/p/package.json'])) });
    expect(r).toEqual({ kind: 'installed' });
    expect(calls).toEqual(['corepack pnpm install']);
    expect(logs.join('\n')).toMatch(/No node_modules yet — installing dependencies \(corepack pnpm install\)/);
  });

  it('a project with node_modules present is untouched (no install, no message)', () => {
    const r = ensureInstalled({
      root: '/p',
      install: true,
      ...io(new Set(['/p/package.json', '/p/node_modules'])),
    });
    expect(r).toEqual({ kind: 'present' });
    expect(calls).toEqual([]);
  });

  it('a project with no package.json has nothing to install (legacy Dockerfile code mode)', () => {
    const r = ensureInstalled({ root: '/p', install: false, ...io(new Set()) });
    expect(r).toEqual({ kind: 'not-applicable' });
    expect(calls).toEqual([]);
  });
});
