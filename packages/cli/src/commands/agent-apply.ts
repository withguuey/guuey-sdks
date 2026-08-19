/**
 * guuey agent apply / status / rollback — agents-as-code (guuey#190, #248).
 *
 * The GitOps verbs: converge the hosted agent to the checked-in
 * `guuey.json` (+ its prompt file) from CI, read back what is live and
 * which commit built it, and re-serve a previous build byte-exact. All
 * talk ONLY to `/v1/apps/:id/reconcile[/rollback]`, the routes an app
 * service token (`guuey_svc_*`, `guuey tokens create`) may write — so they
 * are the CI-safe path (`guuey deploy` needs a user or workspace key; its
 * `/deploy/trigger` route is deliberately outside the service token's
 * scope).
 *
 * Usage:
 *   guuey agent apply                     # converge; prints applied build / unchanged
 *   guuey agent apply --dry-run           # plan only; exit 2 when there is drift
 *   guuey agent apply --wait              # apply, then poll the build to live
 *   guuey agent apply --provenance none   # don't stamp repo@sha (default: auto)
 *   guuey agent status                    # live build + provenance + app config
 *   guuey agent status --check            # + byte-exact parity of THIS checkout
 *   guuey agent rollback --to 7           # re-serve build #7's bytes as a new build (no checkout)
 *   … --json                              # the wire response, verbatim (with --wait, apply adds a
 *                                         # `wait: {status,url,pageUrl}` block after polling; a
 *                                         # non-live final status exits 1)
 *   … --app-id <id>                       # target another app (binding untouched)
 *
 * What gets sent: the `guuey.json` bytes VERBATIM (so `deployedContentHash.
 * agentDef` is the file's own sha256) plus, when `agent.systemPrompt` is a
 * `{ file }` reference, that file's bytes as `artifacts.systemPrompt` (the
 * server inlines them byte-exact — a repo checkout's file ref cannot
 * resolve server-side). App policy is NOT re-derived here: the server reads
 * `guuey.json#app.access` itself (one derivation site).
 *
 * Provenance (`auto`): `GITHUB_REPOSITORY`/`GITHUB_SHA` when set (any CI
 * that exports them), else `git remote get-url origin` + `git rev-parse
 * HEAD`; `path` = cwd relative to the repo root. A dirty tree warns (the
 * sha describes committed content; the bytes may not) — never blocks.
 *
 * Exit codes: 0 ok / in sync · 1 error · 2 drift (`--dry-run`, `--check`).
 */

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { GUUEY_JSON_FILENAME, GuueyJsonSchemaError, loadGuueyJson } from '@guuey/config';
import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import { resolveTargetAppId } from '../app-id';
import { apiRequest, parseApiError } from '../deploy-shared';
import { awaitPageUrl, pollDeployStatus, printPageLine } from './deploy';
import * as out from '../output';

// ─── Wire mirrors of `backend/libs/cli-wire/reconcile.ts` ────────────────
// Hand-written (the CLI is published npm; the wire package is private) and
// pinned field-for-field by the sync guard in `agent-apply.test.ts` — see
// `../wire-mirror-parse.ts` for why.

export interface DeployProvenance {
  repo: string;
  path: string;
  sha: string;
}

export interface AgentReconcileConfig {
  userAuthMode?: string;
  userAuthConfig?: { issuerUrl: string; audience: string } | null;
  allowedDomains?: string[];
  guestAccess?: boolean | null;
}

export interface AgentReconcileBody {
  artifacts: { guueyJson: string; systemPrompt?: string };
  config?: AgentReconcileConfig;
  provenance?: DeployProvenance;
  deploymentId?: string;
  size?: string;
  dryRun?: boolean;
}

export interface ReconcileContentHash {
  systemPrompt?: string;
  agentDef: string;
  snapshot: string;
}

/** A reconcilable field's value as stored / as desired (`null` = unset/cleared). */
export type ReconcileConfigValue =
  | string
  | boolean
  | string[]
  | { issuerUrl: string; audience: string }
  | null;

export interface ReconcileConfigDiff {
  /** Widened from the wire's four-literal union so a future field prints verbatim. */
  field: string;
  current: ReconcileConfigValue;
  desired: ReconcileConfigValue;
}

export interface ReconcilePlan {
  snapshot: 'unchanged' | 'changed';
  config: ReconcileConfigDiff[];
}

export interface AgentReconcileResult {
  applied: boolean;
  unchanged: boolean;
  dryRun: boolean;
  appId: string;
  buildNumber: number;
  deploymentId?: string;
  status: string;
  deployedContentHash: ReconcileContentHash;
  provenanceRecorded: boolean;
  statusPath: string;
  plan: ReconcilePlan;
}

export interface AgentReconcileStatus {
  appId: string;
  live: {
    buildNumber: number;
    status: string;
    deploymentId: string;
    deployedAt: string | null;
    size: string | null;
    provenance: DeployProvenance | null;
    contentHash: string | null;
    rolledBackFrom: number | null;
  } | null;
  config: {
    userAuthMode: string | null;
    userAuthConfig: { issuerUrl: string; audience: string } | null;
    allowedDomains: string[];
    guestAccess: boolean | null;
  };
}

export interface AgentRollbackBody {
  buildNumber: number;
  deploymentId?: string;
}

export interface AgentRollbackResult {
  applied: boolean;
  unchanged: boolean;
  appId: string;
  rolledBackFrom: number;
  buildNumber: number;
  deploymentId?: string;
  status: string;
  contentHash: string;
  provenance: DeployProvenance | null;
  statusPath: string;
}

// ─── Exit codes ──────────────────────────────────────────────────────────

/** `--dry-run` / `--check` found drift: the checkout is NOT what is live. */
export const EXIT_DRIFT = 2;

// ─── Provenance detection (pure core, testable) ──────────────────────────

/** Everything `resolveProvenance` reads from the environment, injected for tests. */
export interface ProvenanceEnv {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Run a git command, returning trimmed stdout; throws when git/repo is absent. */
  git: (args: string) => string;
}

/**
 * `org/repo` from a git remote URL — https, ssh (`git@host:org/repo.git`),
 * `ssh://git@host/org/repo`; trailing `.git` stripped. `undefined` when the
 * URL has no recognizable `org/repo` tail (the caller then omits provenance
 * rather than stamping garbage).
 */
export function repoSlugFromRemote(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const scp = /^[^@/]+@[^:/]+:(.+)$/.exec(trimmed);
  const path = scp ? scp[1] : (() => {
    try {
      return new URL(trimmed).pathname.replace(/^\/+/, '');
    } catch {
      return undefined;
    }
  })();
  if (!path) return undefined;
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) return undefined;
  return parts.slice(-2).join('/');
}

/**
 * Parse `--provenance <value>`:
 *   - `auto` (default) → detect (see {@link resolveProvenance})
 *   - `none`           → send no provenance
 *   - `<repo>@<sha>[:<path>]` → explicit (path defaults to `.`)
 * Returns `{ kind: 'error' }` with a usage message for anything else.
 */
export function parseProvenanceFlag(
  value: string | true | undefined,
):
  | { kind: 'auto' }
  | { kind: 'none' }
  | { kind: 'explicit'; provenance: DeployProvenance }
  | { kind: 'error'; message: string } {
  if (value === undefined || value === 'auto') return { kind: 'auto' };
  if (value === true) {
    return {
      kind: 'error',
      message: '--provenance takes auto | none | <org/repo>@<sha>[:<path>]',
    };
  }
  if (value === 'none') return { kind: 'none' };
  const m = /^([^@\s]+)@([0-9a-fA-F]{7,64})(?::(.+))?$/.exec(value);
  if (!m) {
    return {
      kind: 'error',
      message: `--provenance "${value}" is not auto | none | <org/repo>@<sha>[:<path>]`,
    };
  }
  return { kind: 'explicit', provenance: { repo: m[1], sha: m[2], path: m[3] ?? '.' } };
}

/** Outcome of auto-detection: the provenance, or a reason it was skipped. */
export type ProvenanceResolution =
  | { provenance: DeployProvenance; dirty: boolean }
  | { provenance: undefined; reason: string };

/**
 * Detect provenance from the environment: GitHub Actions env first (any CI
 * exporting `GITHUB_REPOSITORY` + `GITHUB_SHA`), else the local git repo.
 * `path` is cwd relative to the repo root (`.` at the root). Never throws —
 * a non-git directory yields `{ provenance: undefined, reason }` and the
 * caller applies without a stamp.
 */
export function resolveProvenance(io: ProvenanceEnv): ProvenanceResolution {
  const ghRepo = io.env.GITHUB_REPOSITORY;
  const ghSha = io.env.GITHUB_SHA;
  let root: string | undefined;
  try {
    root = io.git('rev-parse --show-toplevel');
  } catch {
    root = undefined;
  }
  const path = root ? relative(root, io.cwd).split('\\').join('/') || '.' : '.';

  if (ghRepo && ghSha) {
    return { provenance: { repo: ghRepo, sha: ghSha, path }, dirty: false };
  }
  if (!root) {
    return { provenance: undefined, reason: 'not inside a git repository (and no GITHUB_REPOSITORY/GITHUB_SHA)' };
  }
  let sha: string;
  try {
    sha = io.git('rev-parse HEAD');
  } catch {
    return { provenance: undefined, reason: 'git repository has no commits yet' };
  }
  let remote: string;
  try {
    remote = io.git('remote get-url origin');
  } catch {
    return { provenance: undefined, reason: 'git remote "origin" is not configured' };
  }
  const repo = repoSlugFromRemote(remote);
  if (!repo) {
    return { provenance: undefined, reason: `could not read org/repo from remote "${remote}"` };
  }
  let dirty = false;
  try {
    dirty = io.git('status --porcelain').length > 0;
  } catch {
    dirty = false;
  }
  return { provenance: { repo, sha, path }, dirty };
}

function realGit(cwd: string): (args: string) => string {
  return (args) =>
    execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
}

// ─── Artifact loading ────────────────────────────────────────────────────

/** The two artifacts a reconcile submits, read from the project at `cwd`. */
export interface LocalArtifacts {
  guueyJson: string;
  systemPrompt?: string;
}

/**
 * Read `guuey.json` VERBATIM (its bytes are what `agentDef` hashes) and,
 * when `agent.systemPrompt` is a `{ file }` reference, the prompt file's
 * bytes. Validation + file resolution ride `loadGuueyJson` — the same
 * loader `guuey deploy` uses — so a schema error reads the same here.
 *
 * Schema-version stance (guuey#248 b2): the loader refuses a document whose
 * root `schema` is newer than this CLI's `@guuey/config` understands
 * (`SCHEMA_TOO_NEW` — upgrade `@guuey/cli`) or older with no migration
 * (`SCHEMA_UNSUPPORTED`). The platform's reconcile route runs the same gate
 * against the same constant, so the two never disagree about a document —
 * an apply that passes here and 400s server-side means this CLI is AHEAD
 * of the platform. The error is re-thrown with its code prefixed so the
 * failure is greppable in CI logs.
 */
export function loadLocalArtifacts(cwd: string): LocalArtifacts {
  const path = join(cwd, GUUEY_JSON_FILENAME);
  const guueyJson = readFileSync(path, 'utf8');
  let loaded: ReturnType<typeof loadGuueyJson>;
  try {
    loaded = loadGuueyJson(path);
  } catch (err) {
    if (err instanceof GuueyJsonSchemaError) {
      throw new Error(`[${err.code}] ${err.message}`);
    }
    throw err;
  }
  const ref = loaded.doc.agent.systemPrompt;
  if (ref !== undefined && typeof ref !== 'string' && loaded.resolvedSystemPrompt !== undefined) {
    return { guueyJson, systemPrompt: loaded.resolvedSystemPrompt };
  }
  return { guueyJson };
}

// ─── Rendering ───────────────────────────────────────────────────────────

function fmtValue(v: ReconcileConfigValue | undefined): string {
  return v === null || v === undefined ? '(unset)' : JSON.stringify(v);
}

/** The plan lines shared by apply/dry-run/check output. */
export function renderPlan(res: AgentReconcileResult): string[] {
  const lines: string[] = [];
  lines.push(`  snapshot:  ${res.plan.snapshot}`);
  if (res.plan.config.length === 0) {
    lines.push('  config:    holds');
  } else {
    lines.push('  config:');
    for (const d of res.plan.config) {
      lines.push(`    ${d.field}: ${fmtValue(d.current)} → ${fmtValue(d.desired)}`);
    }
  }
  const h = res.deployedContentHash;
  lines.push(`  sha256 agentDef:  ${h.agentDef}`);
  if (h.systemPrompt) lines.push(`  sha256 prompt:    ${h.systemPrompt}`);
  lines.push(`  sha256 snapshot:  ${h.snapshot}`);
  return lines;
}

// ─── Shared prologue ─────────────────────────────────────────────────────

interface Ctx {
  pat: string;
  config: { apiUrl?: string };
  appId: string;
}

function context(flags: Record<string, string | true> | undefined): Ctx {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = resolveTargetAppId(flags, config);
  if (!appId) {
    out.error(
      `No app linked. Set "appId" in ${GUUEY_JSON_FILENAME}, run "guuey pull --app-id <id>", or pass --app-id <id>.`,
    );
    process.exit(1);
  }
  if (!config.apiUrl) {
    out.error('REST API URL not configured (set GUUEY_API_URL).');
    process.exit(1);
  }
  return { pat: auth.pat, config, appId };
}

async function failFromResponse(res: Response, fallback: string): Promise<never> {
  const data: unknown = await res.json().catch(() => ({}));
  out.error(parseApiError(data, `${fallback}: HTTP ${res.status}`));
  process.exit(1);
}

async function postReconcile(ctx: Ctx, body: AgentReconcileBody): Promise<AgentReconcileResult> {
  const res = await apiRequest(ctx.pat, ctx.config, 'POST', `/apps/${ctx.appId}/reconcile`, body);
  if (!res.ok) await failFromResponse(res, 'Reconcile failed');
  return (await res.json()) as AgentReconcileResult;
}

// ─── guuey agent apply ───────────────────────────────────────────────────

export async function agentApply(flags?: Record<string, string | true>): Promise<void> {
  const dryRun = flags?.['dry-run'] === true;
  const wait = flags?.wait === true;
  const jsonOut = flags?.json === true;
  const prov = parseProvenanceFlag(flags?.provenance);
  if (prov.kind === 'error') {
    out.error(prov.message);
    process.exit(1);
  }

  const ctx = context(flags);
  const cwd = process.cwd();

  let artifacts: LocalArtifacts;
  try {
    artifacts = loadLocalArtifacts(cwd);
  } catch (err) {
    out.error(`Failed to load ${GUUEY_JSON_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let provenance: DeployProvenance | undefined;
  if (prov.kind === 'explicit') {
    provenance = prov.provenance;
  } else if (prov.kind === 'auto') {
    const resolved = resolveProvenance({ env: process.env, cwd, git: realGit(cwd) });
    if (resolved.provenance) {
      provenance = resolved.provenance;
      if (resolved.dirty && !jsonOut) {
        console.log(
          `  ! working tree has uncommitted changes — provenance ${provenance.repo}@${provenance.sha.slice(0, 12)} describes the last commit, not necessarily these bytes.`,
        );
      }
    } else if (!jsonOut) {
      console.log(`  (no provenance stamped: ${resolved.reason})`);
    }
  }

  const body: AgentReconcileBody = {
    artifacts,
    ...(provenance ? { provenance } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  };
  const result = await postReconcile(ctx, body);

  if (jsonOut) {
    if (dryRun) {
      out.json(result);
      if (!result.unchanged) process.exit(EXIT_DRIFT);
      return;
    }
    // `--wait --json`: poll exactly like the human path, then emit ONE
    // JSON document — the wire response plus a `wait` block with the
    // final build status. Without this, `--wait` was silently inert
    // under `--json` and CI went green on a still-queued build that
    // could later fail (found by the guuey#280 helper-agent review).
    if (wait && !result.unchanged) {
      const { status, url, pageUrl } = await pollDeployStatus({
        auth: { pat: ctx.pat },
        config: ctx.config,
        appId: ctx.appId,
        buildNumber: result.buildNumber,
        timeoutMs: 7 * 60 * 1000,
      });
      out.json({ ...result, wait: { status, url, pageUrl } });
      if (status !== 'live') process.exit(1);
      return;
    }
    out.json(result);
    return;
  }

  console.log('');
  if (dryRun) {
    if (result.unchanged) {
      out.success(`Plan: no changes — in sync with build #${result.buildNumber} (${result.status}).`);
    } else {
      console.log(
        result.buildNumber === 0
          ? '  Plan: first apply — a new build would be queued.'
          : `  Plan: changes against build #${result.buildNumber} (${result.status}) — a new build would be queued.`,
      );
    }
    for (const line of renderPlan(result)) console.log(line);
    console.log('');
    if (!result.unchanged) process.exit(EXIT_DRIFT);
    return;
  }

  if (result.unchanged) {
    out.success(`Unchanged — build #${result.buildNumber} (${result.status}) already serves these bytes. Nothing queued.`);
    for (const line of renderPlan(result)) console.log(line);
    console.log('');
    return;
  }

  out.success(`Applied — build #${result.buildNumber} queued${result.provenanceRecorded ? ` (provenance ${provenance?.repo}@${provenance?.sha.slice(0, 12)})` : ''}.`);
  for (const line of renderPlan(result)) console.log(line);
  console.log(`  status:    guuey deployments  ·  ${result.statusPath}`);
  console.log('');

  if (wait) {
    console.log('  Waiting for the build to go live...');
    const auth = { pat: ctx.pat };
    const { status, url, pageUrl } = await pollDeployStatus({
      auth,
      config: ctx.config,
      appId: ctx.appId,
      buildNumber: result.buildNumber,
      timeoutMs: 7 * 60 * 1000,
    });
    if (status === 'live') {
      out.success(`Live at ${url}`);
      // guuey#249 — the app's page (default slug claimed at first Live),
      // read back from the status projection, never derived here.
      printPageLine(
        await awaitPageUrl({
          auth,
          config: ctx.config,
          appId: ctx.appId,
          buildNumber: result.buildNumber,
          pageUrl,
        }),
      );
      return;
    }
    out.error(
      status === 'superseded'
        ? 'Build superseded by a newer deploy.'
        : 'Build failed. Run "guuey deployments list" for details.',
    );
    process.exit(1);
  }
}

// ─── guuey agent status ──────────────────────────────────────────────────

export async function agentStatus(flags?: Record<string, string | true>): Promise<void> {
  const check = flags?.check === true;
  const jsonOut = flags?.json === true;
  const ctx = context(flags);

  const res = await apiRequest(ctx.pat, ctx.config, 'GET', `/apps/${ctx.appId}/reconcile`);
  if (!res.ok) await failFromResponse(res, 'Status read failed');
  const status = (await res.json()) as AgentReconcileStatus;

  let parity: AgentReconcileResult | undefined;
  if (check) {
    let artifacts: LocalArtifacts;
    try {
      artifacts = loadLocalArtifacts(process.cwd());
    } catch (err) {
      out.error(`--check needs a loadable ${GUUEY_JSON_FILENAME} in the current directory: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    parity = await postReconcile(ctx, { artifacts, dryRun: true });
  }

  if (jsonOut) {
    out.json(parity ? { ...status, check: parity } : status);
    if (parity && !parity.unchanged) process.exit(EXIT_DRIFT);
    return;
  }

  console.log('');
  console.log(`  App:  ${status.appId}`);
  if (status.live === null) {
    console.log('  Live: no active build');
  } else {
    const l = status.live;
    console.log(
      `  Live: build #${l.buildNumber} (${l.status})${l.rolledBackFrom !== null ? ` (rolled back from #${l.rolledBackFrom})` : ''}${l.size ? ` · ${l.size}` : ''}${l.deployedAt ? ` · deployed ${l.deployedAt}` : ''}`,
    );
    console.log(
      l.provenance
        ? `        managed from ${l.provenance.repo}@${l.provenance.sha.slice(0, 12)} (${l.provenance.path})`
        : '        no provenance — deployed outside agents-as-code (guuey deploy / Studio)',
    );
    if (l.contentHash) console.log(`        snapshot sha256 ${l.contentHash}`);
  }
  const c = status.config;
  console.log('  Config:');
  console.log(`    userAuthMode:   ${fmtValue(c.userAuthMode)}`);
  console.log(`    userAuthConfig: ${fmtValue(c.userAuthConfig)}`);
  console.log(`    allowedDomains: ${fmtValue(c.allowedDomains)}`);
  console.log(`    guestAccess:    ${fmtValue(c.guestAccess)}`);

  if (parity) {
    console.log('');
    if (parity.unchanged) {
      out.success(`Checkout is in sync with build #${parity.buildNumber} (byte-exact).`);
    } else {
      out.error(
        parity.buildNumber === 0
          ? 'DRIFT — nothing is live yet; this checkout has never been applied.'
          : `DRIFT — this checkout differs from build #${parity.buildNumber}:`,
      );
      for (const line of renderPlan(parity)) console.log(line);
    }
  }
  console.log('');
  if (parity && !parity.unchanged) process.exit(EXIT_DRIFT);
}

// ─── guuey agent rollback ────────────────────────────────────────────────

/**
 * Parse `--to <n>`: a positive integer build number, or a usage message.
 * Exported for tests; the command exits 1 on the message.
 */
export function parseRollbackTarget(value: string | true | undefined): number | string {
  if (value === undefined || value === true) {
    return '--to <buildNumber> is required — the build whose bytes to re-serve (see "guuey deployments").';
  }
  const n = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n)) {
    return `--to "${value}" is not a build number (a positive integer, e.g. --to 7).`;
  }
  return n;
}

/**
 * `guuey agent rollback --to <n> [--wait] [--json] [--app-id <id>]` —
 * pin-to-build rollback (guuey#248 b3): re-serve build N's persisted
 * snapshot byte-exact as a new build. Needs NO checkout: it runs anywhere
 * with `--app-id` (or the binding). The platform refuses (409
 * ROLLBACK_NOT_EXACT) rather than approximate when the stored snapshot
 * would not re-serialize byte-identical — the message names the way out.
 */
export async function agentRollback(flags?: Record<string, string | true>): Promise<void> {
  const wait = flags?.wait === true;
  const jsonOut = flags?.json === true;
  const target = parseRollbackTarget(flags?.to);
  if (typeof target === 'string') {
    out.error(target);
    process.exit(1);
  }
  const ctx = context(flags);

  const body: AgentRollbackBody = { buildNumber: target };
  const res = await apiRequest(ctx.pat, ctx.config, 'POST', `/apps/${ctx.appId}/reconcile/rollback`, body);
  if (!res.ok) await failFromResponse(res, 'Rollback failed');
  const result = (await res.json()) as AgentRollbackResult;

  if (jsonOut) {
    out.json(result);
    return;
  }

  console.log('');
  const prov = result.provenance
    ? ` — bytes from ${result.provenance.repo}@${result.provenance.sha.slice(0, 12)} (${result.provenance.path})`
    : '';
  if (result.unchanged) {
    out.success(
      `Unchanged — build #${result.buildNumber} (${result.status}) already serves build #${result.rolledBackFrom}'s bytes. Nothing queued.`,
    );
    console.log(`  sha256 snapshot:  ${result.contentHash}${prov}`);
    console.log('');
    return;
  }

  out.success(`Rolled back — build #${result.buildNumber} queued, re-serving build #${result.rolledBackFrom} byte-exact${prov}.`);
  console.log(`  sha256 snapshot:  ${result.contentHash}`);
  console.log(`  status:    guuey deployments  ·  ${result.statusPath}`);
  console.log('');

  if (wait) {
    console.log('  Waiting for the build to go live...');
    const { status, url } = await pollDeployStatus({
      auth: { pat: ctx.pat },
      config: ctx.config,
      appId: ctx.appId,
      buildNumber: result.buildNumber,
      timeoutMs: 7 * 60 * 1000,
    });
    if (status === 'live') {
      out.success(`Live at ${url}`);
      return;
    }
    out.error(
      status === 'superseded'
        ? 'Build superseded by a newer deploy.'
        : 'Build failed. Run "guuey deployments list" for details.',
    );
    process.exit(1);
  }
}
