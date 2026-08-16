/**
 * Tests for `guuey agent apply` / `guuey agent status`
 * (`commands/agent-apply.ts`, agents-as-code guuey#190).
 *
 * Three layers: the pure provenance core (no I/O), the commands against a
 * mocked `fetch` + a real temp project on disk (the artifact loader is the
 * real `@guuey/config` loader), and the trailing SYNC GUARD pinning the
 * hand-written wire mirrors against `backend/libs/cli-wire/reconcile.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  agentApply,
  agentStatus,
  EXIT_DRIFT,
  loadLocalArtifacts,
  parseProvenanceFlag,
  repoSlugFromRemote,
  resolveProvenance,
  type AgentReconcileResult,
  type AgentReconcileStatus,
} from './agent-apply.js';
import { parseInterfaceFields } from '../wire-mirror-parse';

vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return {
    ...actual,
    requireAuth: vi.fn(() => ({ pat: 'guuey_svc_test', expiresAt: '2099-01-01T00:00:00.000Z' })),
  };
});

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    resolveConfig: vi.fn(() => ({
      host: 'https://guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    })),
  };
});

// `--wait` polls through the deploy module's poller; stub it so no timers run.
vi.mock('./deploy.js', () => ({
  pollDeployStatus: vi.fn(async () => ({ status: 'live', url: 'https://app-1.agents.guuey.test' })),
}));

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const GUUEY_JSON = JSON.stringify(
  {
    schema: '1',
    appId: 'app-1',
    agent: { model: 'claude-sonnet-5', systemPrompt: { file: 'prompts/system.md' } },
    app: { access: { guestAccess: false, allowedDomains: ['https://console.example.com'] } },
  },
  null,
  2,
);
const PROMPT = 'You are the helper. Em-dash — intact.\n';

function reconcileResult(over: Partial<AgentReconcileResult> = {}): AgentReconcileResult {
  return {
    applied: true,
    unchanged: false,
    dryRun: false,
    appId: 'app-1',
    buildNumber: 12,
    deploymentId: 'dep-12',
    status: 'queued',
    deployedContentHash: { agentDef: 'a'.repeat(64), systemPrompt: 'b'.repeat(64), snapshot: 'c'.repeat(64) },
    provenanceRecorded: true,
    statusPath: '/v1/apps/app-1/deployments/12/status',
    plan: { snapshot: 'changed', config: [{ field: 'guestAccess', current: null, desired: false }] },
    ...over,
  };
}

let fetchMock: MockInstance;
let logs: string[];
let dir: string;
let originalCwd: string;

beforeEach(() => {
  logs = [];
  fetchMock = vi.spyOn(globalThis, 'fetch');
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'agent-apply-test-'));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'guuey.json'), GUUEY_JSON);
  writeFileSync(join(dir, 'prompts', 'system.md'), PROMPT);
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── Pure core ───────────────────────────────────────────────────────────

describe('repoSlugFromRemote', () => {
  it.each([
    ['https://github.com/loqu-co/ggui.git', 'loqu-co/ggui'],
    ['https://github.com/loqu-co/ggui', 'loqu-co/ggui'],
    ['git@github.com:loqu-co/ggui.git', 'loqu-co/ggui'],
    ['ssh://git@github.com/loqu-co/ggui.git', 'loqu-co/ggui'],
    ['https://gitlab.example.com/group/sub/repo.git', 'sub/repo'],
  ])('%s → %s', (url, slug) => {
    expect(repoSlugFromRemote(url)).toBe(slug);
  });

  it('returns undefined for a URL with no org/repo tail', () => {
    expect(repoSlugFromRemote('https://github.com/')).toBeUndefined();
    expect(repoSlugFromRemote('not a url')).toBeUndefined();
  });
});

describe('parseProvenanceFlag', () => {
  it('absent / auto → auto; none → none', () => {
    expect(parseProvenanceFlag(undefined)).toEqual({ kind: 'auto' });
    expect(parseProvenanceFlag('auto')).toEqual({ kind: 'auto' });
    expect(parseProvenanceFlag('none')).toEqual({ kind: 'none' });
  });

  it('explicit <org/repo>@<sha>[:<path>]', () => {
    expect(parseProvenanceFlag('loqu-co/ggui@da49f6dca:guuey-agents/helper')).toEqual({
      kind: 'explicit',
      provenance: { repo: 'loqu-co/ggui', sha: 'da49f6dca', path: 'guuey-agents/helper' },
    });
    expect(parseProvenanceFlag('org/repo@abcdef0')).toEqual({
      kind: 'explicit',
      provenance: { repo: 'org/repo', sha: 'abcdef0', path: '.' },
    });
  });

  it('a bare flag or a non-sha value is a usage error', () => {
    expect(parseProvenanceFlag(true).kind).toBe('error');
    expect(parseProvenanceFlag('org/repo@main').kind).toBe('error');
  });
});

describe('resolveProvenance', () => {
  const gitOk = (answers: Record<string, string>) => (args: string) => {
    if (args in answers) return answers[args];
    throw new Error(`git ${args} failed`);
  };

  it('prefers GITHUB_REPOSITORY/GITHUB_SHA, with path relative to the repo root', () => {
    const r = resolveProvenance({
      env: { GITHUB_REPOSITORY: 'loqu-co/ggui', GITHUB_SHA: 'da49f6dca' },
      cwd: '/w/ggui/guuey-agents/helper',
      git: gitOk({ 'rev-parse --show-toplevel': '/w/ggui' }),
    });
    expect(r).toEqual({
      provenance: { repo: 'loqu-co/ggui', sha: 'da49f6dca', path: 'guuey-agents/helper' },
      dirty: false,
    });
  });

  it('falls back to git origin + HEAD locally, flags a dirty tree, path "." at the root', () => {
    const r = resolveProvenance({
      env: {},
      cwd: '/w/repo',
      git: gitOk({
        'rev-parse --show-toplevel': '/w/repo',
        'rev-parse HEAD': 'abc1234abc1234',
        'remote get-url origin': 'git@github.com:acme/agents.git',
        'status --porcelain': ' M guuey.json',
      }),
    });
    expect(r).toEqual({
      provenance: { repo: 'acme/agents', sha: 'abc1234abc1234', path: '.' },
      dirty: true,
    });
  });

  it('outside a repo, or without an origin, resolves to no provenance with a reason (never throws)', () => {
    expect(resolveProvenance({ env: {}, cwd: '/tmp/x', git: gitOk({}) })).toMatchObject({
      provenance: undefined,
      reason: expect.stringContaining('not inside a git repository'),
    });
    expect(
      resolveProvenance({
        env: {},
        cwd: '/w/repo',
        git: gitOk({ 'rev-parse --show-toplevel': '/w/repo', 'rev-parse HEAD': 'abc1234' }),
      }),
    ).toMatchObject({ provenance: undefined, reason: expect.stringContaining('origin') });
  });
});

describe('loadLocalArtifacts', () => {
  it('sends guuey.json VERBATIM and the prompt file bytes when systemPrompt is a file ref', () => {
    const a = loadLocalArtifacts(dir);
    expect(a.guueyJson).toBe(GUUEY_JSON);
    expect(a.systemPrompt).toBe(PROMPT);
  });

  it('sends no systemPrompt artifact when the document inlines the prompt', () => {
    writeFileSync(
      join(dir, 'guuey.json'),
      JSON.stringify({ schema: '1', agent: { systemPrompt: 'inline prompt' } }),
    );
    expect(loadLocalArtifacts(dir).systemPrompt).toBeUndefined();
  });

  it('a schema-invalid document throws the loader\'s error (same message as guuey deploy)', () => {
    writeFileSync(join(dir, 'guuey.json'), JSON.stringify({ schema: '1', agent: {}, name: 'x' }));
    expect(() => loadLocalArtifacts(dir)).toThrow();
  });
});

// ─── Commands ────────────────────────────────────────────────────────────

describe('agentApply', () => {
  it('POSTs artifacts + explicit provenance to /apps/:id/reconcile and reports the queued build + plan', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, reconcileResult()));

    await agentApply({ provenance: 'loqu-co/ggui@da49f6dca:agents/helper' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.guuey.test/apps/app-1/reconcile');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer guuey_svc_test');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      artifacts: { guueyJson: GUUEY_JSON, systemPrompt: PROMPT },
      provenance: { repo: 'loqu-co/ggui', sha: 'da49f6dca', path: 'agents/helper' },
    });
    // no config re-derived client-side; no dryRun member on a real apply
    expect('config' in body).toBe(false);
    expect('dryRun' in body).toBe(false);
    const output = logs.join('\n');
    expect(output).toContain('Applied — build #12 queued');
    expect(output).toContain('guestAccess: (unset) → false');
    expect(output).toContain('sha256 ' + 'c'.repeat(64));
  });

  it('--provenance none sends no provenance block', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, reconcileResult({ provenanceRecorded: false })));
    await agentApply({ provenance: 'none' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect('provenance' in JSON.parse(init.body as string)).toBe(false);
  });

  it('unchanged → success line, nothing else to do, exit 0', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        reconcileResult({ applied: false, unchanged: true, buildNumber: 11, status: 'live', plan: { snapshot: 'unchanged', config: [] } }),
      ),
    );
    await agentApply({ provenance: 'none' });
    expect(logs.join('\n')).toContain('Unchanged — build #11 (live) already serves these bytes');
  });

  it('--dry-run sends dryRun:true, prints the plan, and exits 2 on drift / 0 when in sync', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, reconcileResult({ applied: false, dryRun: true, buildNumber: 11, status: 'live' })),
    );
    await expect(agentApply({ 'dry-run': true, provenance: 'none' })).rejects.toThrow(
      new ExitSignal(EXIT_DRIFT).message,
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).dryRun).toBe(true);
    expect(logs.join('\n')).toContain('Plan: changes against build #11 (live)');

    logs.length = 0;
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        reconcileResult({ applied: false, dryRun: true, unchanged: true, buildNumber: 11, status: 'live', plan: { snapshot: 'unchanged', config: [] } }),
      ),
    );
    await agentApply({ 'dry-run': true, provenance: 'none' });
    expect(logs.join('\n')).toContain('Plan: no changes — in sync with build #11');
  });

  it('--json emits the wire response verbatim (the drift gate reads deployedContentHash)', async () => {
    const wire = reconcileResult();
    fetchMock.mockResolvedValue(jsonResponse(200, wire));
    await agentApply({ json: true, provenance: 'none' });
    expect(JSON.parse(logs.join('\n'))).toEqual(wire);
  });

  it('--wait polls the queued build to live', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, reconcileResult()));
    await agentApply({ wait: true, provenance: 'none' });
    const { pollDeployStatus } = await import('./deploy.js');
    expect(pollDeployStatus).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-1', buildNumber: 12 }),
    );
    expect(logs.join('\n')).toContain('Live at https://app-1.agents.guuey.test');
  });

  it('renders the cliApi error envelope and exits 1 (a service token on the wrong app, a schema 400, …)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { code: 'VALIDATION', message: 'artifacts.guueyJson failed guuey.json schema validation at "schema"' } }),
    );
    await expect(agentApply({ provenance: 'none' })).rejects.toThrow(new ExitSignal(1).message);
    expect(logs.join('\n')).toContain('[VALIDATION] artifacts.guueyJson failed');
  });

  it('a bad --provenance value is a usage error before any network call', async () => {
    await expect(agentApply({ provenance: 'org/repo@main' })).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('--app-id overrides the guuey.json binding for the request path', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, reconcileResult({ appId: 'app-2' })));
    await agentApply({ 'app-id': 'app-2', provenance: 'none' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.guuey.test/apps/app-2/reconcile');
  });
});

describe('agentStatus', () => {
  const STATUS: AgentReconcileStatus = {
    appId: 'app-1',
    live: {
      buildNumber: 11,
      status: 'live',
      deploymentId: 'dep-11',
      deployedAt: '2026-08-16T20:00:00.000Z',
      size: 'xs',
      provenance: { repo: 'loqu-co/ggui', sha: 'da49f6dcaabcdef', path: 'guuey-agents/helper' },
      contentHash: 'c'.repeat(64),
    },
    config: {
      userAuthMode: 'byo',
      userAuthConfig: { issuerUrl: 'https://iss.example', audience: 'aud' },
      allowedDomains: ['https://console.example.com'],
      guestAccess: false,
    },
  };

  it('GETs /apps/:id/reconcile and renders live build, provenance, config', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, STATUS));
    await agentStatus({});
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.guuey.test/apps/app-1/reconcile');
    expect(init.method).toBe('GET');
    const output = logs.join('\n');
    expect(output).toContain('Live: build #11 (live) · xs · deployed 2026-08-16T20:00:00.000Z');
    expect(output).toContain('managed from loqu-co/ggui@da49f6dcaabc (guuey-agents/helper)');
    expect(output).toContain('userAuthMode:   "byo"');
    expect(output).toContain('allowedDomains: ["https://console.example.com"]');
  });

  it('no active build / no provenance render honestly', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...STATUS,
        live: { ...STATUS.live, provenance: null, contentHash: null },
      }),
    );
    await agentStatus({});
    expect(logs.join('\n')).toContain('no provenance — deployed outside agents-as-code');

    logs.length = 0;
    fetchMock.mockResolvedValue(jsonResponse(200, { ...STATUS, live: null }));
    await agentStatus({});
    expect(logs.join('\n')).toContain('Live: no active build');
  });

  it('--check runs a dryRun reconcile from the local checkout: in sync → exit 0, drift → exit 2', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, STATUS))
      .mockResolvedValueOnce(
        jsonResponse(200, reconcileResult({ applied: false, dryRun: true, unchanged: true, buildNumber: 11, status: 'live', plan: { snapshot: 'unchanged', config: [] } })),
      );
    await agentStatus({ check: true });
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      artifacts: { guueyJson: GUUEY_JSON, systemPrompt: PROMPT },
      dryRun: true,
    });
    expect(logs.join('\n')).toContain('Checkout is in sync with build #11 (byte-exact)');

    logs.length = 0;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, STATUS))
      .mockResolvedValueOnce(
        jsonResponse(200, reconcileResult({ applied: false, dryRun: true, buildNumber: 11, status: 'live', plan: { snapshot: 'changed', config: [] } })),
      );
    await expect(agentStatus({ check: true })).rejects.toThrow(new ExitSignal(EXIT_DRIFT).message);
    expect(logs.join('\n')).toContain('DRIFT — this checkout differs from build #11');
  });

  it('--json --check nests the parity result under "check"', async () => {
    const parity = reconcileResult({ applied: false, dryRun: true, unchanged: true, buildNumber: 11, status: 'live', plan: { snapshot: 'unchanged', config: [] } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, STATUS)).mockResolvedValueOnce(jsonResponse(200, parity));
    await agentStatus({ check: true, json: true });
    expect(JSON.parse(logs.join('\n'))).toEqual({ ...STATUS, check: parity });
  });
});

// ─────────────────────────────────────────────────────────────────────
// SYNC GUARD: the wire mirrors above vs `backend/libs/cli-wire/reconcile.ts`.
// Field names + optionality only (types are widened on purpose — see
// `../wire-mirror-parse.ts`); skips when `backend/` is absent (a consumer's
// installed copy has no monorepo around it).
// ─────────────────────────────────────────────────────────────────────

function repoPath(relativeToThisFile: string): string {
  return fileURLToPath(new URL(relativeToThisFile, import.meta.url));
}

const WIRE_RECONCILE = repoPath('../../../../../backend/libs/cli-wire/reconcile.ts');
const CLI_RECONCILE = repoPath('./agent-apply.ts');
const haveWire = existsSync(WIRE_RECONCILE);

describe.skipIf(!haveWire)('reconcile wire mirrors — sync guard against @guuey-private/cli-wire', () => {
  const read = (path: string): string => readFileSync(path, 'utf8');

  it.each([
    'DeployProvenance',
    'AgentReconcileConfig',
    'AgentReconcileBody',
    'ReconcileContentHash',
    'ReconcileConfigDiff',
    'ReconcilePlan',
    'AgentReconcileResult',
    'AgentReconcileStatus',
  ])('%s declares exactly the wire fields, with the same optionality', (name) => {
    expect(parseInterfaceFields(read(CLI_RECONCILE), name)).toEqual(
      parseInterfaceFields(read(WIRE_RECONCILE), name),
    );
  });
});
