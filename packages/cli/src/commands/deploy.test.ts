import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  printTriggerWarnings,
  printRedeploySource,
  readRedeploySource,
  awaitPageUrl,
  createIntentFromProject,
  createLinkedApp,
  deploy,
  pollDeployStatus,
  portalLine,
  portalOriginForHost,
  printPageLine, printPodLifetime,
  ensureInstalled,
  INSTALL_FINISHED_MARKERS,
} from './deploy.js';
import { DEPLOY_WAIT_MS, NODE_PROVISION_BUDGET_MS, stillDeployingMessage } from './deploy-wait.js';
import { resolveConfig, loadProjectConfig } from '../config.js';

// guuey#1000 — the code-mode deploy runs `pnpm install` / `corepack
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
    // guuey#1441: the install/build command is chosen by probing this machine
    // (`pnpm --version`, else `npx --version`). Pin the probe so these cases
    // assert DEPLOY's use of the ladder, not the runner's PATH — the ladder
    // itself is tested for real, through a stubbed PATH, in
    // create-agentic-app's run-install.test.ts.
    spawnSync: vi.fn((file: string) => ({ status: file === 'pnpm' ? 0 : 1 })),
  };
});
// Every case starts with an empty child-process record: the code-path suites
// run the (recorded, never real) build, and a case that pins "nothing ran"
// or "install ran first" reads only its own calls.
beforeEach(async () => {
  childProcessLog.calls.length = 0;
  vi.mocked((await import('node:child_process')).execSync).mockClear();
});

// The code deploy packs its source with tar; stubbed (as in
// deploy-code-access.test.ts) so a suite can drive the real deploy() through
// build, upload and trigger with every platform call on the fetch spy.
const packed = vi.hoisted(() => ({ path: '' }));
vi.mock('../deploy-shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deploy-shared.js')>();
  return {
    ...actual,
    packSource: vi.fn(() => ({ tarballPath: packed.path, tarballSize: 4, sourceHash: 'sha256:test' })),
    cleanup: vi.fn(),
  };
});
import { resolveDeployTarget, retiredModelWarning } from './deploy.js';
import {
  bindRegistry,
  defaultModelFor,
  isOfferedModel,
  modelEntry,
  retirementNotice,
  safeParseGuueyJson,
  type GuueyAgent,
} from '@guuey/config';
import { createInterface } from 'node:readline';
import type { apiRequest } from '../deploy-shared.js';

/** Thrown by the process.exit mock so execution stops like the real thing. */
class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/**
 * A code project the stubbed build and pack carry to the trigger:
 * guuey.json, package.json, node_modules, the built worker, and the tarball
 * `packSource` hands back. Deploy it with `{ code: true }` (the config mock
 * reads no guuey.json, so `agent.mode` never reaches the mode decision).
 */
function writeCodeProject(dir: string, doc: object): void {
  writeFileSync(join(dir, 'guuey.json'), JSON.stringify(doc));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'tsup' } }));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', '.modules.yaml'), ''); // a finished install (guuey#3280)
  writeFileSync(join(dir, 'guuey.worker.js'), '// built worker');
  packed.path = join(dir, 'source.tar.gz');
  writeFileSync(packed.path, 'tar!');
}

const LIVE_STATUS = {
  status: 'live',
  endpointUrl: 'https://app-1.guuey.app',
  errorMessage: null,
  pageUrl: 'https://app-k7q2.agents.guuey.test/',
};

/**
 * The platform as a code deploy meets it, through to Live: nothing live yet
 * (so the no-code check passes), the upload, the S3 put, the trigger and the
 * status poll. `null` for any other call, which the caller answers.
 */
function codeDeployResponse(url: string): Response | null {
  if (/\/apps\/[^/]+\/deployments$/.test(url)) return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
  if (/\/apps\/[^/]+\/deploy\/upload$/.test(url)) {
    return new Response(JSON.stringify({ uploadUrl: 'https://s3.test/upload', uploadId: 'up-1', buildNumber: 1 }), { status: 200 });
  }
  if (url === 'https://s3.test/upload') return new Response('', { status: 200 });
  if (/\/apps\/[^/]+\/deploy\/trigger$/.test(url)) return new Response(JSON.stringify({ buildNumber: 1 }), { status: 202 });
  if (url.includes('/deployments/1/status')) return new Response(JSON.stringify(LIVE_STATUS), { status: 200 });
  return null;
}

/** `codeDeployResponse`, else a 404 for the best-effort reads (theme, origin gap, runtime pin). */
async function codePlatform(input: string | URL | Request): Promise<Response> {
  return codeDeployResponse(String(input)) ?? new Response('{}', { status: 404 });
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

// guuey#2310 — the registry's two retirement readers, passed through to the
// real registry. One case swaps in a deprecated row with no notice, a row the
// live registry does not carry (every live deprecated row names a replacement).
vi.mock('@guuey/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guuey/config')>();
  return {
    ...actual,
    retirementNotice: vi.fn(actual.retirementNotice),
    modelEntry: vi.fn(actual.modelEntry),
  };
});

// The first-run create offer asks its questions through readline. Every
// question is answered with an empty line (the default), so a case that
// reaches the prompt runs on instead of waiting on the runner's stdin.
vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>();
  return {
    ...actual,
    createInterface: vi.fn(() => ({
      question: (_query: string, answer: (line: string) => void) => answer(''),
      close: () => {},
    })),
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

// guuey#1670 — who the agent is for rides deploy's first-run create. The
// manifest's `app.builtFor` (stamped by `guuey create --for`) rides whatever
// the framework. The prompt's answer, asked only when the manifest carries
// none, is sent AND written back beside `appId`.
describe('createLinkedApp — builtFor (guuey#1670)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const auth = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config = { host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test' };

  function manifestFile(doc: object): { path: string; project: NonNullable<Parameters<typeof createIntentFromProject>[0]> } {
    const parsed = safeParseGuueyJson(doc);
    if (!parsed.success) throw new Error('fixture manifest must parse');
    const path = join(mkdtempSync(join(tmpdir(), 'built-for-')), 'guuey.json');
    writeFileSync(path, JSON.stringify(doc));
    return { path, project: parsed.data };
  }

  it("createIntentFromProject carries the manifest's app.builtFor on every framework, vanilla included", () => {
    const vanilla = safeParseGuueyJson({ schema: '1', agent: { framework: 'vanilla' }, app: { builtFor: 'personal' } });
    if (!vanilla.success) throw new Error('fixture manifest must parse');
    expect(createIntentFromProject(vanilla.data)).toEqual({ builtFor: 'personal' });

    const mint = safeParseGuueyJson({ schema: '1', agent: { framework: 'google-adk' }, app: { builtFor: 'customers' } });
    if (!mint.success) throw new Error('fixture manifest must parse');
    expect(createIntentFromProject(mint.data)).toEqual({ builtFor: 'customers', intendedFramework: 'google-adk' });

    const none = safeParseGuueyJson({ schema: '1', agent: { framework: 'vanilla' } });
    if (!none.success) throw new Error('fixture manifest must parse');
    expect(createIntentFromProject(none.data)).toEqual({});
  });

  it('a manifest-declared builtFor rides the create with no answer asked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ app: { id: 'app-m', displayName: 'Mine' } }), { status: 201 }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { path, project } = manifestFile({ schema: '1', agent: { framework: 'vanilla' }, app: { builtFor: 'personal' } });

    await createLinkedApp({ auth, config, project, guueyJsonPath: path, appName: 'Mine' });

    const [, init] = fetchSpy.mock.calls.at(-1)!;
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: 'Mine', builtFor: 'personal' });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.appId).toBe('app-m');
    expect(written.app.builtFor).toBe('personal');
  });

  it("the prompt's answer is sent and written back beside appId, keeping the manifest's other app keys", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ app: { id: 'app-a', displayName: 'Rep' } }), { status: 201 }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { path, project } = manifestFile({
      schema: '1',
      agent: { framework: 'vanilla' },
      app: { suggestions: ['What can you do?'] },
    });

    await createLinkedApp({ auth, config, project, guueyJsonPath: path, appName: 'Rep', builtFor: 'customers' });

    const [, init] = fetchSpy.mock.calls.at(-1)!;
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: 'Rep', builtFor: 'customers' });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.appId).toBe('app-a');
    expect(written.app).toEqual({ suggestions: ['What can you do?'], builtFor: 'customers' });
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Wrote appId and app.builtFor back to guuey.json');
  });

  it('no manifest answer and no prompt answer: no builtFor key on the wire or in the file (N-1)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ app: { id: 'app-n', displayName: 'Plain' } }), { status: 201 }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { path, project } = manifestFile({ schema: '1', agent: { framework: 'vanilla' } });

    await createLinkedApp({ auth, config, project, guueyJsonPath: path, appName: 'Plain' });

    const [, init] = fetchSpy.mock.calls.at(-1)!;
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: 'Plain' });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.appId).toBe('app-n');
    expect('app' in written).toBe(false);
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Wrote appId back to guuey.json');
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
    // A bound-less code project. The interactive create-offer needs a
    // terminal, which vitest's stdin is not, so the plain fail-fast error fires.
    writeFileSync(join(dir, 'guuey.json'), JSON.stringify({ agent: { mode: 'code' } }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }));
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
    await expect(deploy({ code: true })).rejects.toBeInstanceOf(ExitSignal);

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
      agent: { mode: 'code', model: 'claude-sonnet-5', systemPrompt: 'x' },
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
// (`@guuey/config`) is the deploy-time pre-flight the code deploy runs before
// any leg leaves the machine; these tests drive the real `deploy()` code path.
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
        appId: 'app-1',
        agent: {
          mcpServers: {
            [colocatedName]: { kind: 'colocated', source: './mcps/tool' },
          },
        },
      }),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'tsup' } }));
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

    await expect(deploy({ code: true, 'no-install': true })).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain(
      'colocated MCP server name "my tool" is invalid — use only letters, digits, hyphen, underscore (it becomes part of a URL and a storage scope)',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a valid colocated name passes the gate', async () => {
    writeGuueyJson('notes_v1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`stop after the gate: ${String(input)}`);
    });
    await deploy({ code: true, 'no-install': true }).catch(() => undefined);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).not.toContain('colocated MCP server name');
  });
});

// guuey#2258: an empty `agent.tools.allowlist` reads as "every tool", so the
// deploy refuses it before upload; a non-empty list passes.
describe('deploy() — empty tool allowlist refusal (deploy-time gate)', () => {
  let dir: string;
  let originalCwd: string;
  let exitSpy: MockInstance<typeof process.exit>;
  let errSpy: MockInstance<typeof console.error>;
  let fetchSpy: MockInstance<typeof fetch>;

  function writeGuueyJson(allowlist: string[]): void {
    writeFileSync(
      join(dir, 'guuey.json'),
      JSON.stringify({ schema: '1', appId: 'app-1', agent: { tools: { allowlist } } }),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'tsup' } }));
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-empty-allowlist-test-'));
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

  it('refuses allowlist: [] with the message, before any network call', async () => {
    writeGuueyJson([]);
    fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(deploy({ code: true, 'no-install': true })).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('agent.tools.allowlist is empty, which allows every tool');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a non-empty allowlist passes the gate', async () => {
    writeGuueyJson(['ggui.*']);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`stop after the gate: ${String(input)}`);
    });
    await deploy({ code: true, 'no-install': true }).catch(() => undefined);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).not.toContain('allowlist is empty');
  });
});

// guuey#2262: "@none" declares no tools only ALONE in an allowlist. A list
// that mixes it with other entries, or a denylist that names it, is refused
// before upload; a plain ["@none"] passes the gate.
describe('deploy() — the "@none" (no tools) entry gate', () => {
  let dir: string;
  let originalCwd: string;
  let errSpy: MockInstance<typeof console.error>;

  function writeGuueyJson(agent: GuueyAgent): void {
    writeFileSync(
      join(dir, 'guuey.json'),
      JSON.stringify({ schema: '1', appId: 'app-1', agent }),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'tsup' } }));
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-no-tools-entry-test-'));
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
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

  const run = (): Promise<void> => deploy({ code: true, 'no-install': true });

  it(`refuses "@none" mixed with other allowlist entries, before any network call`, async () => {
    writeGuueyJson({ framework: 'claude-agent-sdk', tools: { allowlist: ['@none', 'ggui.*'] } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(run()).rejects.toBeInstanceOf(ExitSignal);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('agent.tools.allowlist mixes "@none" with other entries');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(childProcessLog.calls).toEqual([]);
  });

  it(`refuses "@none" in a mode denylist, naming the mode, before any network call`, async () => {
    writeGuueyJson(
      { framework: 'claude-agent-sdk', modes: { guest: { tools: { denylist: ['@none'] } } } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(run()).rejects.toBeInstanceOf(ExitSignal);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('agent.modes.guest.tools.denylist lists "@none" in mode "guest"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it(`a plain ["@none"] passes the gate`, async () => {
    writeGuueyJson({ framework: 'claude-agent-sdk', tools: { allowlist: ['@none'] } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`stop after the gate: ${String(input)}`);
    });
    // Whatever the deploy does after the gate, the gate passed.
    await run().catch(() => undefined);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).not.toContain('"@none"');
  });
});

// guuey#2585: a "*" is valid only as the whole entry or as "<server>.*", and a
// mode's tool lists follow the same grammar as the base. The builder's file is
// a document submitted now, so both are refused before upload.
describe('deploy() — the misplaced "*" and mode tool-entry gate', () => {
  let dir: string;
  let originalCwd: string;
  let errSpy: MockInstance<typeof console.error>;

  function writeGuueyJson(agent: GuueyAgent): void {
    writeFileSync(
      join(dir, 'guuey.json'),
      JSON.stringify({ schema: '1', appId: 'app-1', agent }),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'tsup' } }));
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-tool-wildcard-test-'));
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
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

  const run = (): Promise<void> => deploy({ code: true, 'no-install': true });

  it(`refuses a bare "delete_*" on the base, before any network call`, async () => {
    writeGuueyJson({ framework: 'claude-agent-sdk', tools: { denylist: ['delete_*'] } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(run()).rejects.toBeInstanceOf(ExitSignal);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('agent.tools.denylist: "delete_*": "*" is only valid as the whole entry ("*")');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(childProcessLog.calls).toEqual([]);
  });

  it(`refuses a mode entry naming a server the agent does not connect, before any network call`, async () => {
    writeGuueyJson(
      { framework: 'claude-agent-sdk', modes: { guest: { tools: { allowlist: ['linear.create_issue'] } } } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(run()).rejects.toBeInstanceOf(ExitSignal);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('agent.modes.guest.tools.allowlist: "linear.create_issue" names MCP server "linear"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it(`"*" and "<server>.*", on the base and in a mode, pass the gate`, async () => {
    writeGuueyJson(
      {
        framework: 'claude-agent-sdk',
        tools: { allowlist: ['*'], denylist: ['ggui.*'] },
        modes: { guest: { tools: { allowlist: ['ggui.*'] } } },
      });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`stop after the gate: ${String(input)}`);
    });
    await run().catch(() => undefined);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).not.toContain('is only valid as the whole entry');
    expect(printed).not.toContain('which this agent does not connect');
  });
});

// A `credential: "caller"` entry carries the user's own bearer, so its url must
// be https://. Refused before upload, checked on the document
// after `${env.NAME}` resolution.
describe('deploy() — credential: "caller" requires an https:// url', () => {
  let dir: string;
  let originalCwd: string;
  let errSpy: MockInstance<typeof console.error>;
  const HTTPS_REFUSAL =
    'mcpServers.crm: credential: "caller" requires an https:// url — the user\'s bearer would travel in cleartext';

  function writeGuueyJson(url: string): void {
    writeFileSync(
      join(dir, 'guuey.json'),
      JSON.stringify({
        schema: '1',
        appId: 'app-1',
        agent: {
          framework: 'claude-agent-sdk',
          mcpServers: { crm: { kind: 'external', url, credential: 'caller' } },
        },
      }),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'tsup' } }));
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-caller-https-test-'));
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const run = (): Promise<void> => deploy({ code: true, 'no-install': true });

  it(`refuses an http:// caller url, naming the server, before any network call`, async () => {
    writeGuueyJson('http://crm.example.com/mcp');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(run()).rejects.toBeInstanceOf(ExitSignal);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain(HTTPS_REFUSAL);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(childProcessLog.calls).toEqual([]);
  });

  it(`refuses a caller url whose \${env.NAME} resolves to http://`, async () => {
    vi.stubEnv('CRM_URL', 'http://crm.example.com/mcp');
    writeGuueyJson('${env.CRM_URL}');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(run()).rejects.toBeInstanceOf(ExitSignal);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain(HTTPS_REFUSAL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it(`an https:// caller url (direct or via \${env.NAME}) passes the gate`, async () => {
    vi.stubEnv('CRM_URL', 'https://crm.example.com/mcp');
    writeGuueyJson('${env.CRM_URL}');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`stop after the gate: ${String(input)}`);
    });
    await run().catch(() => undefined);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).not.toContain('requires an https:// url');
  });
});

// A `federate: true` entry's token is minted for its exact resource, which must
// be an https:// url ending in "/". Any other shape fails the mint every turn,
// so it is refused before upload, after `${env.NAME}` resolution.
describe('deploy() — federate: true requires an https:// url ending in "/"', () => {
  let dir: string;
  let originalCwd: string;
  let errSpy: MockInstance<typeof console.error>;
  const SLASH_REFUSAL = 'mcpServers.crm: "federate": true needs an https:// url ending in "/"';

  function writeGuueyJson(url: string): void {
    writeFileSync(
      join(dir, 'guuey.json'),
      JSON.stringify({
        schema: '1',
        appId: 'app-1',
        agent: {
          framework: 'claude-agent-sdk',
          mcpServers: { crm: { kind: 'external', url, federate: true } },
        },
      }),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'tsup' } }));
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-federate-slash-test-'));
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const run = (): Promise<void> => deploy({ code: true, 'no-install': true });

  it(`refuses a federated url without a trailing "/", naming the server, before any network call`, async () => {
    writeGuueyJson('https://crm.example.com/mcp');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(run()).rejects.toBeInstanceOf(ExitSignal);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain(SLASH_REFUSAL);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(childProcessLog.calls).toEqual([]);
  });

  it(`a federated url ending in "/" (via \${env.NAME}) passes the gate`, async () => {
    vi.stubEnv('CRM_URL', 'https://crm.example.com/mcp/');
    writeGuueyJson('${env.CRM_URL}');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`stop after the gate: ${String(input)}`);
    });
    await run().catch(() => undefined);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).not.toContain('needs an https:// url ending in');
  });
});

// An agent.env name the platform runtime owns is refused before upload,
// naming the name and never its value. Other names, including an LD_
// name outside the list, pass.
describe('deploy() — agent.env may not set a runtime-reserved name', () => {
  let dir: string;
  let originalCwd: string;
  let errSpy: MockInstance<typeof console.error>;

  function writeGuueyJson(env: Record<string, string>): void {
    writeFileSync(
      join(dir, 'guuey.json'),
      JSON.stringify({
        schema: '1',
        appId: 'app-1',
        agent: { framework: 'claude-agent-sdk', env },
      }),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'tsup' } }));
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-reserved-env-test-'));
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
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

  const run = (): Promise<void> => deploy({ code: true, 'no-install': true });

  it(`refuses LD_PRELOAD and GLIBC_TUNABLES, naming each and no value, before any network call`, async () => {
    writeGuueyJson({ KEEP: '1', LD_PRELOAD: '/preload.so', GLIBC_TUNABLES: 'glibc.x=1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(run()).rejects.toBeInstanceOf(ExitSignal);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('agent.env.LD_PRELOAD');
    expect(printed).toContain('agent.env.GLIBC_TUNABLES');
    expect(printed).not.toContain('/preload.so');
    expect(printed).not.toContain('glibc.x=1');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(childProcessLog.calls).toEqual([]);
  });

  it(`an LD_ name outside the list (LD_SDK_KEY) passes the gate`, async () => {
    writeGuueyJson({ LD_SDK_KEY: 'k' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`stop after the gate: ${String(input)}`);
    });
    await run().catch(() => undefined);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).not.toContain('reserved by the platform runtime');
  });
});

// `guuey deploy --max-pods N` (scaling S1-F4, guuey#162): the flag rides
// `DeployTriggerBody.maxPods` at every trigger POST. Driven through the code
// trigger (build and pack stubbed), plus a body-literal guard that the
// legacy Dockerfile shape carries the field too.
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
    writeCodeProject(dir, { schema: '1', appId: 'app-1', agent: { mode: 'code' } });
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
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(codePlatform);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sends maxPods on the trigger body when the flag is given', async () => {
    await deploy({ code: true, 'max-pods': '3' });

    expect(triggerBody()?.maxPods).toBe(3);
  });

  it('OMITS maxPods when the flag is absent, so a redeploy never resets the knob', async () => {
    await deploy({ code: true });

    const body = triggerBody();
    expect(body).toBeDefined();
    expect(body).not.toHaveProperty('maxPods');
  });

  it.each(['0', '-2', '1.5', 'many', ''])(
    'rejects --max-pods %j client-side, before any network call',
    async (value) => {
      await expect(deploy({ code: true, 'max-pods': value })).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(printed).toContain('--max-pods must be a positive integer');
    },
  );

  it('rejects a valueless --max-pods (parsed as `true`) rather than sending NaN', async () => {
    await expect(deploy({ code: true, 'max-pods': true })).rejects.toBeInstanceOf(ExitSignal);

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
      return codePlatform(input);
    });

    await expect(deploy({ code: true, 'max-pods': '9' })).rejects.toBeInstanceOf(ExitSignal);

    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('[AGENT_MAX_PODS]');
    expect(printed).toContain("ceiling of 3");
  });
});

// The ggui asset push is a FULL-STATE replace on the server (cliApi
// ggui-assets.ts), so a project with no `ggui` block must never push: that is
// how guuey eject's first code deploy keeps the assets a console-built app
// already has (eject leaves the template's block out).
describe('deploy() — a project with no ggui block never pushes ggui assets', () => {
  let dir: string;
  let originalCwd: string;
  let fetchSpy: MockInstance<typeof fetch>;

  const pushCalls = (): string[] =>
    fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/ggui-assets/push'));

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-ggui-skip-test-'));
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/ggui-assets/push')) return new Response(JSON.stringify({}), { status: 200 });
      return codePlatform(input);
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('★ no ggui block: the deploy reaches the trigger and sends no asset push', async () => {
    writeCodeProject(dir, { schema: '1', appId: 'app-1', agent: { mode: 'code' } });

    await deploy({ code: true });

    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('/deploy/trigger'))).toBe(true);
    expect(pushCalls()).toEqual([]);
  });

  it('positive control: the same project WITH a ggui block pushes once', async () => {
    writeCodeProject(dir, { schema: '1', appId: 'app-1', agent: { mode: 'code' }, ggui: { configFile: 'ggui.json' } });
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify({ gadgets: [] }));

    await deploy({ code: true });

    expect(pushCalls()).toEqual(['https://api.guuey.test/apps/app-1/ggui-assets/push']);
  });
});

// One guuey.json for every environment: the external MCP url and the BYO
// issuer read deploy-time ${env.NAME} placeholders, which the CLI fills in
// before the snapshot leaves the machine — the trigger body never carries one.
describe('deploy() — deploy-time ${env.NAME} placeholders resolve before the trigger', () => {
  let dir: string;
  let originalCwd: string;
  let errSpy: MockInstance<typeof console.error>;
  let logs: string[];
  let fetchSpy: MockInstance<typeof fetch>;
  const ENV = {
    PRODUCT_MCP_URL: 'https://mcp.staging.example.com/mcp',
    PRODUCT_ISSUER_URL: 'https://id.staging.example.com',
    PRODUCT_AUDIENCE: 'staging-client',
  };
  const saved = new Map<string, string | undefined>();

  function writeManifest(): void {
    writeCodeProject(dir, {
      schema: '1',
      appId: 'app-1',
      agent: {
        mode: 'code',
        mcpServers: { product: { kind: 'external', url: '${env.PRODUCT_MCP_URL}' } },
      },
      app: {
        access: {
          userAuthMode: 'byo',
          userAuthConfig: { issuerUrl: '${env.PRODUCT_ISSUER_URL}', audience: '${env.PRODUCT_AUDIENCE}' },
        },
      },
    });
  }

  /** The snapshot the code trigger sends (a JSON string inside the body). */
  function triggerSnapshot(): { agent: { mcpServers: { product: { url: string } } }; app: { access: { userAuthConfig: unknown } } } {
    return JSON.parse(String(JSON.parse(triggerWire()!).snapshotConfig));
  }

  /** The trigger POST's raw body text (what goes on the wire), or `undefined` if it never fired. */
  function triggerWire(): string | undefined {
    const call = fetchSpy.mock.calls.find(([u]) => String(u).includes('/deploy/trigger'));
    return call ? String(call[1]?.body) : undefined;
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-env-placeholders-test-'));
    process.chdir(dir);
    for (const name of Object.keys(ENV)) saved.set(name, process.env[name]);
    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const deployed = codeDeployResponse(url);
      if (deployed) return deployed;
      // guuey#2358: `app.access` converges through the app's own read + write.
      if (url.endsWith('/apps/app-1') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ app: { id: 'app-1' } }), { status: 200 });
      }
      if (url.endsWith('/apps/app-1')) {
        return new Response(
          JSON.stringify({ app: { id: 'app-1', chatTheme: null, userAuthMode: null, userAuthConfig: null, allowedDomains: [], guestAccess: null } }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('the snapshot carries the resolved url, issuer and audience — no `${` reaches the server', async () => {
    writeManifest();
    Object.assign(process.env, ENV);
    await deploy({ code: true });
    const wire = triggerWire();
    expect(wire).toBeDefined();
    expect(wire).not.toContain('${');
    const snapshot = triggerSnapshot();
    expect(snapshot.agent.mcpServers.product.url).toBe(ENV.PRODUCT_MCP_URL);
    expect(snapshot.app.access.userAuthConfig).toEqual({ issuerUrl: ENV.PRODUCT_ISSUER_URL, audience: ENV.PRODUCT_AUDIENCE });
    // The access converge writes the same resolved values the snapshot carries.
    const put = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith('/apps/app-1') && init?.method === 'PUT');
    expect(put).toBeDefined();
    expect(String(put![1]?.body)).not.toContain('${');
    expect(JSON.parse(String(put![1]?.body)).userAuthConfig).toEqual({ issuerUrl: ENV.PRODUCT_ISSUER_URL, audience: ENV.PRODUCT_AUDIENCE });
    const printed = logs.join('\n');
    expect(printed).toContain('resolved from the environment: PRODUCT_AUDIENCE, PRODUCT_ISSUER_URL, PRODUCT_MCP_URL');
    expect(printed).not.toContain(ENV.PRODUCT_AUDIENCE);
  });

  it('--env-file supplies the values', async () => {
    writeManifest();
    for (const name of Object.keys(ENV)) delete process.env[name];
    writeFileSync(join(dir, '.env.staging'), Object.entries(ENV).map(([k, v]) => `${k}="${v}"`).join('\n'));
    await deploy({ code: true, 'env-file': '.env.staging' });
    expect(triggerSnapshot().agent.mcpServers.product.url).toBe(ENV.PRODUCT_MCP_URL);
  });

  it('an unset variable stops the deploy before any network call or build', async () => {
    writeManifest();
    for (const name of Object.keys(ENV)) delete process.env[name];
    await expect(deploy({ code: true, 'no-install': true })).rejects.toBeInstanceOf(ExitSignal);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('PRODUCT_MCP_URL is not set');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(childProcessLog.calls).toEqual([]);
  });
});

// `guuey deploy` has no `--force`: every deploy rebuilds, and the upload route
// never answers "unchanged". The one-release no-op window (which printed a
// "no longer needed" notice) is over, so deploy reads `force` no differently
// from any flag it does not define: no notice, and the same deploy.
describe('deploy() — --force is not a deploy option', () => {
  let dir: string;
  let originalCwd: string;
  let logSpy: MockInstance<typeof console.log>;
  let fetchSpy: MockInstance<typeof fetch>;

  function printed(): string {
    return logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-force-noop-test-'));
    writeCodeProject(dir, { schema: '1', appId: 'app-1', agent: { mode: 'code' } });
    process.chdir(dir);

    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    });
    vi.mocked(loadProjectConfig).mockReturnValue(null);

    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(codePlatform);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Each full run waits one status-poll tick (3 s) before the deploy reads live.
  const FULL_RUN_BUDGET_MS = 10_000;

  // Each trigger body minus its per-run `deploymentId` (a fresh id every run).
  function triggerBodies(): string[] {
    return fetchSpy.mock.calls
      .filter(([u]) => String(u).includes('/deploy/trigger'))
      .map(([, init]) => String(init?.body ?? '').replace(/"deploymentId":"[^"]*",?/, ''));
  }

  it('a --force run prints nothing about --force', async () => {
    await expect(deploy({ code: true, force: true })).resolves.toBeUndefined();

    expect(printed()).not.toContain('--force');
    expect(printed()).not.toContain('no longer needed');
  }, FULL_RUN_BUDGET_MS);

  it('a --force run sends the same trigger as a run without it', async () => {
    await deploy({ code: true });
    const without = triggerBodies();
    expect(without).toHaveLength(1);

    fetchSpy.mockClear();
    logSpy.mockClear();
    await deploy({ code: true, force: 'yes' });

    expect(triggerBodies()).toEqual(without);
    expect(printed()).not.toContain('--force');
  }, 2 * FULL_RUN_BUDGET_MS);
});

// Nothing on the upload route answers 304, so neither upload site keeps a
// client-side "unchanged, nothing to deploy" exit that no server can reach.
describe('deploy.ts — no upload site waits for a 304', () => {
  it('both upload POST sites are found, and none branches on 304', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./deploy.ts', import.meta.url)),
      'utf8',
    );
    const uploadSites = source.split("'POST', `/apps/${appId}/deploy/upload`").slice(1);
    expect(uploadSites).toHaveLength(2);
    for (const site of uploadSites) {
      const end = site.indexOf('await uploadRes.json()) as');
      expect(end).toBeGreaterThan(0);
      const handling = site.slice(0, end);
      expect(handling).toContain('if (!uploadRes.ok)');
      expect(handling).not.toMatch(/\b304\b/);
      expect(handling).not.toContain('Nothing to deploy');
    }
  });
});

describe('deploy() — app.theme in guuey.json reaches a code app (guuey#1130 G59)', () => {
  let dir: string;
  let originalCwd: string;
  let fetchSpy: MockInstance<typeof fetch>;
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;
  const THEME = {
    name: 'acme',
    mode: 'light',
    colors: {
      light: { accent: '#8b7cf6', onAccent: '#0e1014', ink: '#111318', inkMuted: '#5b6270', surface: '#ffffff', canvas: '#f7f7f5', canvasMuted: '#eceded', error: '#d64545' },
      dark: { accent: '#8b7cf6', onAccent: '#0e1014', ink: '#e8e9ee', inkMuted: '#9aa0ac', surface: '#1b1e26', canvas: '#0f1116', canvasMuted: '#1b1e26', error: '#ff6b6b' },
    },
    typography: {},
    shape: { radius: 'soft', density: 'comfortable' },
  };

  function themePut(): { index: number; body: Record<string, unknown> } | undefined {
    const index = fetchSpy.mock.calls.findIndex(([u, init]) => String(u).endsWith('/apps/app-1') && init?.method === 'PUT');
    if (index === -1) return undefined;
    return { index, body: JSON.parse(String(fetchSpy.mock.calls[index]![1]?.body)) as Record<string, unknown> };
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-theme-test-'));
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({ host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test', appId: 'app-1' });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const deployed = codeDeployResponse(url);
      if (deployed) return deployed;
      if (url.endsWith('/apps/app-1') && init?.method === 'PUT') return new Response(JSON.stringify({ id: 'app-1' }), { status: 200 });
      // The app has no theme yet — the first-write-free case, in the real `{ app }` body (guuey#2401); the hint's GET after the PUT reads the same mock.
      if (url.endsWith('/apps/app-1')) return new Response(JSON.stringify({ app: { id: 'app-1', chatTheme: null } }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('an inline app.theme is PUT as chatTheme after the deploy goes live, and the Theme: line prints', async () => {
    writeCodeProject(dir, { schema: '1', appId: 'app-1', agent: { mode: 'code' }, app: { theme: THEME } });
    await deploy({ code: true });
    const put = themePut();
    expect(put).toBeDefined();
    expect(put!.body).toEqual({ chatTheme: THEME });
    const trigger = fetchSpy.mock.calls.findIndex(([u]) => String(u).includes('/deploy/trigger'));
    expect(put!.index).toBeGreaterThan(trigger);
    expect(logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')).toContain('Theme:  app.theme applied');
  });

  it('a { file } reference writes the resolved document', async () => {
    writeFileSync(join(dir, 'theme.json'), JSON.stringify(THEME));
    writeCodeProject(dir, { schema: '1', appId: 'app-1', agent: { mode: 'code' }, app: { theme: { file: 'theme.json' } } });
    await deploy({ code: true });
    expect(themePut()?.body).toEqual({ chatTheme: THEME });
  });

  it('an app that already has a chat theme is NEVER overwritten by a deploy — no PUT, the kept line names the doors', async () => {
    writeCodeProject(dir, { schema: '1', appId: 'app-1', agent: { mode: 'code' }, app: { theme: THEME } });
    fetchSpy.mockImplementation(async (input, init) => {
      const url = String(input);
      const deployed = codeDeployResponse(url);
      if (deployed) return deployed;
      if (url.endsWith('/apps/app-1') && init?.method === 'PUT') throw new Error('a deploy must never PUT over an existing theme');
      if (url.endsWith('/apps/app-1')) return new Response(JSON.stringify({ app: { id: 'app-1', chatTheme: { ...THEME, name: 'console-set' } } }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    await deploy({ code: true });
    expect(themePut()).toBeUndefined();
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('already has a chat theme');
    expect(printed).toContain('--chat-theme-file');
  });

  it('no app.theme → no PUT (a redeploy never touches the theme)', async () => {
    writeCodeProject(dir, { schema: '1', appId: 'app-1', agent: { mode: 'code' } });
    await deploy({ code: true });
    expect(themePut()).toBeUndefined();
  });

  it("a validator refusal prints the server's path-naming message and the deploy still succeeds", async () => {
    writeCodeProject(dir, { schema: '1', appId: 'app-1', agent: { mode: 'code' }, app: { theme: THEME } });
    fetchSpy.mockImplementation(async (input, init) => {
      const url = String(input);
      const deployed = codeDeployResponse(url);
      if (deployed) return deployed;
      if (url.endsWith('/apps/app-1') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ error: { code: 'CHAT_THEME_INVALID', message: 'chatTheme.colors.light.accent must be a hex colour like #2f6bff' } }), { status: 400 });
      }
      if (url.endsWith('/apps/app-1')) return new Response(JSON.stringify({ app: { id: 'app-1', chatTheme: null } }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    await expect(deploy({ code: true })).resolves.toBeUndefined();
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('app.theme was NOT applied');
    expect(printed).toContain('chatTheme.colors.light.accent');
    expect(printed).toContain('--chat-theme-file');
  });
});

// The --max-pods suite drives the code trigger. The legacy Dockerfile
// trigger is pinned at the source with it: every `/deploy/trigger` body
// literal in deploy.ts spreads maxPods, so a new deploy shape that forgets
// the field fails here.
describe('deploy.ts — every trigger POST site carries maxPods', () => {
  it('both body literals spread the knob', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./deploy.ts', import.meta.url)),
      'utf8',
    );
    const triggerPosts = source.split("'POST', `/apps/${appId}/deploy/trigger`").slice(1);
    expect(triggerPosts).toHaveLength(2);
    for (const site of triggerPosts) {
      const body = site.slice(0, site.indexOf('});'));
      expect(body).toContain('...(maxPods !== undefined ? { maxPods } : {})');
    }
  });
});

// The ${env.NAME} suite drives the code snapshot; this pins the rule at the
// source too: every snapshot deploy.ts builds goes through resolveEnvOrExit
// before it is sent.
describe('deploy.ts — every snapshot sent is ${env.NAME}-resolved', () => {
  it('each buildDeploySnapshot call is wrapped by resolveEnvOrExit', () => {
    const source = readFileSync(fileURLToPath(new URL('./deploy.ts', import.meta.url)), 'utf8');
    const built = source.match(/buildDeploySnapshot\(/g) ?? [];
    const wrapped = source.match(/resolveEnvOrExit\(\s*buildDeploySnapshot\(/g) ?? [];
    expect(built.length).toBe(1);
    expect(wrapped.length).toBe(built.length);
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
    writeCodeProject(dir, { schema: '1', appId: 'app-bound', agent: { mode: 'code' } });
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
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(codePlatform);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('★ a bound scaffold + --app-id Y deploys to Y — never silently to the bound id', async () => {
    await deploy({ code: true, 'app-id': 'app-other' });
    expect(triggerUrl()).toContain('/apps/app-other/deploy/trigger');
    expect(triggerUrl()).not.toContain('app-bound');
    // The binding on disk is untouched: an override is per-deploy, not a rebind.
    expect(JSON.parse(readFileSync(join(dir, 'guuey.json'), 'utf8')).appId).toBe('app-bound');
  });

  it('without the flag the binding is used, exactly as before', async () => {
    await deploy({ code: true });
    expect(triggerUrl()).toContain('/apps/app-bound/deploy/trigger');
  });

  it('a valueless --app-id (parsed as `true`) is rejected before any network call', async () => {
    await expect(deploy({ code: true, 'app-id': true })).rejects.toBeInstanceOf(ExitSignal);
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

// guuey#2349: a trigger without a guuey.json snapshot (the root-Dockerfile
// deploy) re-serves a stored build's definition; the 202's additive
// `redeployedFrom` names that build, and the CLI says which. An older server
// sends no field and the CLI prints nothing extra.
describe('printRedeploySource (guuey#2349)', () => {
  function printedBy(body: unknown): string[] {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });
    printRedeploySource(body);
    spy.mockRestore();
    return lines;
  }

  it('the live build: names its number and created time', () => {
    expect(
      printedBy({ redeployedFrom: { kind: 'live', buildNumber: 4, status: 'live', createdAt: '2026-10-04T12:00:00.000Z' } }),
    ).toEqual(["  Config: reused build #4's guuey.json (the live build, created 2026-10-04T12:00:00.000Z); this deploy sends none."]);
  });

  it('nothing live: names the newest build with one', () => {
    expect(
      printedBy({ redeployedFrom: { kind: 'newest', buildNumber: 5, status: 'failed', createdAt: '2026-10-05T12:00:00.000Z' } }),
    ).toEqual([
      "  Config: reused build #5's guuey.json (nothing is live, so the newest build with one, created 2026-10-05T12:00:00.000Z); this deploy sends none.",
    ]);
  });

  // A 'newest' build under a teardown still reads status 'live' and is not
  // serving: live or not is the kind's word, never the row's status.
  it("newest whose status reads live (under a teardown): never called live", () => {
    expect(
      printedBy({ redeployedFrom: { kind: 'newest', buildNumber: 2, status: 'live', createdAt: '2026-10-02T12:00:00.000Z' } }),
    ).toEqual([
      "  Config: reused build #2's guuey.json (nothing is live, so the newest build with one, created 2026-10-02T12:00:00.000Z); this deploy sends none.",
    ]);
  });

  it('the archive tombstone: says so, with no build number', () => {
    expect(printedBy({ redeployedFrom: { kind: 'archive', buildNumber: null, status: null, createdAt: null } })).toEqual([
      '  Config: reused the guuey.json saved when this app was archived; this deploy sends none.',
    ]);
  });

  it('an older server (no field) or junk: prints nothing', () => {
    expect(printedBy({ appId: 'app-1', buildNumber: 7, status: 'queued' })).toEqual([]);
    expect(printedBy({ redeployedFrom: { kind: 'oldest', buildNumber: 1 } })).toEqual([]);
    expect(printedBy({ redeployedFrom: 'live' })).toEqual([]);
    expect(printedBy(null)).toEqual([]);
  });

  it('readRedeploySource reads a malformed member as null and still names what it can', () => {
    expect(readRedeploySource({ kind: 'live', buildNumber: '4', status: '', createdAt: 7 })).toEqual({
      kind: 'live',
      buildNumber: null,
      status: null,
      createdAt: null,
    });
    expect(printedBy({ redeployedFrom: { kind: 'live', buildNumber: null, status: null, createdAt: null } })).toEqual([
      "  Config: reused a stored build's guuey.json (the live build); this deploy sends none.",
    ]);
  });

  // The legacy Dockerfile trigger is the one CLI site that sends no snapshot,
  // and it needs a tarball + S3 round trip this suite has no harness for (see
  // the maxPods pin), so its printing is pinned at the source.
  it('the snapshot-less trigger site prints the source and the trigger warnings', () => {
    const source = readFileSync(fileURLToPath(new URL('./deploy.ts', import.meta.url)), 'utf8');
    const sites = source.split("'POST', `/apps/${appId}/deploy/trigger`").slice(1);
    const bare = sites.filter((site) => !site.slice(0, site.indexOf('});')).includes('snapshotConfig'));
    expect(bare).toHaveLength(1);
    const handling = bare[0]!.slice(0, bare[0]!.indexOf('attachBuildLogStream'));
    expect(handling).toContain('printRedeploySource(');
    expect(handling).toContain('printTriggerWarnings(');
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
// The 0.19.0 release showed the order as shipped by #979:
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

  // guuey#1000 — the deploy installs on first run. The
  // default is no longer a refusal: a missing node_modules is installed,
  // FIRST, before any leg talks to the platform.
  it('★ by default a missing node_modules is INSTALLED first — before the ggui asset push or any other fetch', async () => {
    // The tail of the deploy (pack, upload, trigger) is not under test here;
    // whatever it does after the install, the order below is the claim.
    await deploy({ code: true }).catch(() => undefined);
    expect(childProcessLog.calls[0]).toBe('pnpm install');
    const firstFetchAt = fetchSpy.mock.invocationCallOrder[0];
    const installAt = vi.mocked((await import('node:child_process')).execSync).mock.invocationCallOrder[0];
    expect(installAt).toBeDefined();
    if (firstFetchAt !== undefined) expect(installAt).toBeLessThan(firstFetchAt);
    expect(errorSpy.mock.calls.flat().join('\n')).not.toMatch(/No node_modules in /);
  });
});

// ── guuey#979: code-mode deploy preflights node_modules ─────────────────────
// A first production deploy ran `pnpm build` in a
// fresh scaffold with no node_modules and died inside the build ("sh: tsup:
// command not found"); the only install instruction on screen was pnpm's own
// WARN. The preflight says it in our voice BEFORE any build. Since guuey#1000
// the default INSTALLS; `--no-install`
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
    expect(r.kind === 'missing' ? r.message : '').toMatch(/pnpm install/);
    expect(calls).toEqual([]);
  });

  it('by default it runs the project package manager install in the project root, says so, then proceeds', () => {
    const r = ensureInstalled({ root: '/p', install: true, ...io(new Set(['/p/package.json'])) });
    expect(r).toEqual({ kind: 'installed' });
    expect(calls).toEqual(['pnpm install']);
    expect(logs.join('\n')).toMatch(/No node_modules yet — installing dependencies \(pnpm install\)/);
  });

  it('a project with a finished install is untouched (no install, no message)', () => {
    const r = ensureInstalled({
      root: '/p',
      install: true,
      ...io(new Set(['/p/package.json', '/p/node_modules', '/p/node_modules/.modules.yaml'])),
    });
    expect(r).toEqual({ kind: 'present' });
    expect(calls).toEqual([]);
  });

  it.each(INSTALL_FINISHED_MARKERS)('guuey#3280: %s marks a finished install', (marker) => {
    const r = ensureInstalled({
      root: '/p',
      install: true,
      ...io(new Set(['/p/package.json', '/p/node_modules', `/p/node_modules/${marker}`])),
    });
    expect(r).toEqual({ kind: 'present' });
  });

  it('guuey#3280: a node_modules no package manager finished is installed again, and the line says why', () => {
    const r = ensureInstalled({ root: '/p', install: true, ...io(new Set(['/p/package.json', '/p/node_modules'])) });
    expect(r).toEqual({ kind: 'installed' });
    expect(calls).toEqual(['pnpm install']);
    expect(logs.join('\n')).toMatch(/from an install that did not finish — installing dependencies \(pnpm install\)/);
  });

  it('guuey#3280: with --no-install, a partial node_modules stops the deploy naming the cause', () => {
    const r = ensureInstalled({ root: '/p', install: false, ...io(new Set(['/p/package.json', '/p/node_modules'])) });
    expect(r.kind === 'missing' ? r.message : '').toMatch(/install that did not finish — you passed --no-install; run "pnpm install"/);
    expect(calls).toEqual([]);
  });

  it('guuey#3280: a bun project is taken as installed (its finish marker is not known here)', () => {
    const r = ensureInstalled({
      root: '/p',
      install: true,
      ...io(new Set(['/p/package.json', '/p/node_modules', '/p/bun.lock'])),
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

// guuey#2310 — a deprecated `agent.model` (registry `status: "deprecated"`)
// is never silently dropped. The deploy that CREATES the app refuses it before
// any prompt and before any request; a redeploy of an existing app warns on
// stderr and proceeds. An id the registry does not list keeps today's path.
describe('deploy() — a retired agent.model (guuey#2310)', () => {
  let dir: string;
  let originalCwd: string;
  let exitSpy: MockInstance<typeof process.exit>;
  let errSpy: MockInstance<typeof console.error>;
  let fetchSpy: MockInstance<typeof fetch>;

  /** Write guuey.json to disk AND hand the same parsed overlay to loadProjectConfig. */
  function manifest(doc: object): void {
    writeFileSync(join(dir, 'guuey.json'), JSON.stringify(doc));
    const parsed = safeParseGuueyJson(doc);
    if (!parsed.success) throw new Error('fixture manifest must parse');
    vi.mocked(loadProjectConfig).mockReturnValue(parsed.data);
  }

  /** An unbound code-mode project: the deploy offers to create the app. */
  function firstDeploy(framework: string, model: string): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'retired-model-test' }));
    manifest({ schema: '1', app: { builtFor: 'customers' }, agent: { mode: 'code', framework, model } });
  }

  /**
   * A bound code-mode project: the deploy redeploys an existing app. (Deploy
   * is code-only; a declarative project redeploys with `guuey agent apply`.)
   */
  function redeploy(framework: string, model: string): void {
    const doc = { schema: '1', appId: 'app-1', agent: { mode: 'code', framework, model } };
    writeCodeProject(dir, doc);
    manifest(doc);
  }

  function createCall(): Parameters<typeof fetch> | undefined {
    return fetchSpy.mock.calls.find(([u, init]) => new URL(String(u)).pathname === '/apps' && init?.method === 'POST');
  }
  function triggered(): boolean {
    return fetchSpy.mock.calls.some(([u]) => String(u).includes('/deploy/trigger'));
  }
  function stderr(): string {
    return errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
  }

  async function withTTY(fn: () => Promise<void>): Promise<void> {
    const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await fn();
    } finally {
      if (stdinDesc) Object.defineProperty(process.stdin, 'isTTY', stdinDesc);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutDesc) Object.defineProperty(process.stdout, 'isTTY', stdoutDesc);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  }

  /** A deprecated row with no retirement notice: the live registry carries none. */
  async function withNoticelessDeprecatedRow(id: string): Promise<void> {
    const actual = await vi.importActual<typeof import('@guuey/config')>('@guuey/config');
    const fixture = bindRegistry([{ id, provider: 'anthropic', label: 'Test Retired', status: 'deprecated' }]);
    expect(fixture.retirementNotice(id)).toBeUndefined();
    vi.mocked(retirementNotice).mockImplementation((m) => (m === id ? undefined : actual.retirementNotice(m)));
    vi.mocked(modelEntry).mockImplementation((m) => (m === id ? fixture.modelEntry(m) : actual.modelEntry(m)));
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-model-2310-'));
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({
      host: 'https://platform.guuey.test',
      apiUrl: 'https://api.guuey.test',
    });
    vi.mocked(createInterface).mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (new URL(url).pathname === '/apps') {
        return new Response(JSON.stringify({ app: { id: 'app-new', displayName: 'Retired' } }), { status: 201 });
      }
      if (url.includes('/deploy/trigger')) {
        return new Response(JSON.stringify({ buildNumber: 1 }), { status: 202 });
      }
      // A redeploy rides the code deploy through to Live.
      const code = codeDeployResponse(url);
      if (code !== null) return code;
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    const actual = await vi.importActual<typeof import('@guuey/config')>('@guuey/config');
    vi.mocked(retirementNotice).mockImplementation(actual.retirementNotice);
    vi.mocked(modelEntry).mockImplementation(actual.modelEntry);
    vi.mocked(loadProjectConfig).mockReturnValue(null);
  });

  describe('the first deploy, which creates the app, REFUSES before anything is asked or sent', () => {
    it.each([
      ['google-adk', 'gemini-3.1-pro', 'Google does not serve gemini-3.1-pro; use gemini-3.6-flash'],
      ['google-adk', 'gemini-3.5-flash', 'gemini-3.5-flash is retired for new apps; use gemini-3.6-flash'],
      ['openai-agents-sdk', 'gpt-4o', 'gpt-4o is retired for new apps; use gpt-6-luna'],
    ])('%s %s', async (framework, model, says) => {
      firstDeploy(framework, model);

      await withTTY(async () => {
        await expect(deploy({})).rejects.toBeInstanceOf(ExitSignal);
      });

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(createInterface).not.toHaveBeenCalled();
      expect(stderr()).toContain(says);
      expect(stderr()).toContain('agent.model in guuey.json');
    });

    it('a deprecated id with no retirement notice is refused too, naming no replacement', async () => {
      await withNoticelessDeprecatedRow('claude-test-retired-0');
      firstDeploy('claude-agent-sdk', 'claude-test-retired-0');

      await withTTY(async () => {
        await expect(deploy({})).rejects.toBeInstanceOf(ExitSignal);
      });

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('claude-test-retired-0 is retired for new apps');
      expect(stderr()).not.toContain('; use ');
      expect(stderr()).toContain('agent.model in guuey.json');
    });

    it('an offered (ga) model still creates the app, carrying the model', async () => {
      const model = defaultModelFor('google-adk');
      firstDeploy('google-adk', model);

      await withTTY(async () => {
        await deploy({}).catch(() => undefined);
      });

      const call = createCall();
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ intendedFramework: 'google-adk', intendedModel: model });
      expect(stderr()).not.toContain('retired');
    });

    it('an unlisted model still creates the app, without intendedModel', async () => {
      firstDeploy('google-adk', 'gemini-test-unlisted-0');

      await withTTY(async () => {
        await deploy({}).catch(() => undefined);
      });

      const call = createCall();
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).not.toHaveProperty('intendedModel');
      expect(stderr()).not.toContain('retired');
    });
  });

  describe('a redeploy of an existing app WARNS on stderr and proceeds', () => {
    it('unserved: says every call fails and names the replacement, never "deprecated", no date', async () => {
      redeploy('google-adk', 'gemini-3.1-pro');

      await deploy({});

      expect(exitSpy).not.toHaveBeenCalled();
      expect(triggered()).toBe(true);
      const said = stderr();
      expect(said).toContain('Google does not serve gemini-3.1-pro, so every call to it fails');
      expect(said).toContain('gemini-3.6-flash');
      expect(said).not.toContain('deprecated');
      expect(said).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('deprecated with no published date: retired for new apps, names the replacement, claims nothing about what serves it', async () => {
      redeploy('google-adk', 'gemini-3.5-flash');

      await deploy({});

      expect(exitSpy).not.toHaveBeenCalled();
      expect(triggered()).toBe(true);
      const said = stderr();
      expect(said).toContain('gemini-3.5-flash is retired for new apps');
      expect(said).toContain('Google has deprecated it without naming a shutdown date');
      expect(said).toContain('gemini-3.6-flash');
      // Google routes the id to 3.6 Flash: the line never claims the app still runs on 3.5.
      expect(said).not.toContain('keeps running on it');
      expect(said).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('deprecated with a sunset: carries the provider and the date', async () => {
      redeploy('openai-agents-sdk', 'gpt-4o');

      await deploy({});

      expect(triggered()).toBe(true);
      const said = stderr();
      expect(said).toContain('gpt-4o is retired for new apps');
      expect(said).toContain('OpenAI stops serving it on 2027-01-14');
      expect(said).toContain('gpt-6-luna');
    });

    it('deprecated with no notice: retired for new apps, and nothing more is claimed', async () => {
      await withNoticelessDeprecatedRow('claude-test-retired-0');
      redeploy('claude-agent-sdk', 'claude-test-retired-0');

      await deploy({});

      expect(triggered()).toBe(true);
      expect(stderr()).toContain('claude-test-retired-0 is retired for new apps');
      expect(stderr()).not.toContain('keeps running on it');
    });

    it.each([
      ['google-adk', defaultModelFor('google-adk')],
      ['google-adk', 'gemini-test-unlisted-0'],
    ])('%s %s: no warning', async (framework, model) => {
      redeploy(framework, model);

      await deploy({});

      expect(triggered()).toBe(true);
      expect(stderr()).not.toContain('retired');
      expect(stderr()).not.toContain('does not serve');
    });
  });
});

// guuey#2310 follow-up: the sunset's before / after faces read a clock, like the console's ModelRetirementBanner.
describe('retiredModelWarning — the sunset date', () => {
  const at = (iso: string) => Date.parse(iso);
  it('through the sunset day itself: keeps running until the date', () => {
    const said = retiredModelWarning('gpt-4o', at('2027-01-14T23:59:59.000Z'));
    expect(said).toContain('This app keeps running on it until OpenAI stops serving it on 2027-01-14');
    expect(said).toContain('gpt-6-luna');
  });
  it('from the day after: stopped, every call fails, never "keeps running"', () => {
    const said = retiredModelWarning('gpt-4o', at('2027-01-15T00:00:00.000Z'));
    expect(said).toContain('OpenAI stopped serving gpt-4o on 2027-01-14, so every call to it fails');
    expect(said).toContain('gpt-6-luna');
    expect(said).not.toContain('keeps running');
  });
  it('a date-less deprecation reads the same at any clock', () => {
    expect(retiredModelWarning('gemini-3.5-flash', at('2030-01-01T00:00:00.000Z'))).toBe(
      retiredModelWarning('gemini-3.5-flash', at('2026-01-01T00:00:00.000Z')),
    );
  });
});
