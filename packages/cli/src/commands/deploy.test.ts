import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  awaitPageUrl,
  createLinkedApp,
  deploy,
  pollDeployStatus,
  portalLine,
  portalOriginForHost,
  printPageLine,
} from './deploy.js';
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

      expect(result).toEqual({ status: 'live', url: 'https://app-1.guuey.app', pageUrl: null });
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
    expect(printed).toContain('guuey pull --app-id');
    expect(printed).not.toContain('guuey create');
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
