/**
 * guuey mcp -- Manage hosted MCP servers on guuey cloud.
 *
 * The `mcp deploy` subcommand deploys a **hosted MCP server**
 * (workspace-owned, code/image-based) to guuey. Hosted MCP servers are
 * **always code-mode** (they ship a Dockerfile) — there is no declarative
 * mode here, unlike `guuey deploy`.
 *
 * It mirrors the code-mode path of `guuey deploy` (tarball → presigned-S3
 * upload → trigger → poll) but hits the **workspace-scoped** `/mcp/...`
 * endpoints instead of the app-scoped `/apps/:id/deploy/...` ones. The
 * server row reuse-or-create + build-numbering happen server-side; the CLI
 * just sends `name` + `workspaceId` + `size` + the tarball.
 *
 * Usage:
 *   guuey mcp deploy                       # Deploy from the current directory
 *   guuey mcp deploy --name mcp-weather    # Override server name
 *   guuey mcp deploy --workspace ws-123    # Owning workspace (or $GUUEY_WORKSPACE)
 *   guuey mcp deploy --size md             # Override runtime pod size
 *   guuey mcp deploy --label v1.0          # Version label
 *
 * Flow (always code mode):
 *   1. Pack source into a tarball (shared with `guuey deploy`)
 *   2. POST /mcp/deploy/upload → presigned S3 URL + serverId + buildNumber
 *   3. PUT the tarball to S3
 *   4. POST /mcp/deploy/trigger → queue the build
 *   5. Poll /mcp/deployments/:serverId/:buildNumber/status until live/failed
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { colocatedResourceUrl } from '@guuey/config';
import { requireAuth, type AuthTokens } from '../auth';
import { resolveConfig, type ResolvedConfig } from '../config';
import { apiRequest, cleanup, packSource, parseApiError } from '../deploy-shared';
import * as out from '../output';

/** Valid hosted-MCP pod sizes (matches the backend `validateSize`). */
export const MCP_SIZES = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
export type McpSize = (typeof MCP_SIZES)[number];

/** Git-tag-style version label rule, shared with `guuey deploy`. */
const LABEL_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// ─── Pure helpers (unit-tested without I/O) ─────────────────────────────

/**
 * Resolve the owning workspace id: `--workspace` flag wins, then the
 * `GUUEY_WORKSPACE` env var, then — when `opts.auth`/`opts.config` are
 * given — a fallback to `GET /v1/me/personal-workspace` (Task 4), which
 * idempotently ensures + returns the caller's personal workspace. This is
 * the PNA/front-door fix: a stranger's first `guuey deploy` with a hosted
 * MCP `source` leg in `guuey.json` has no `--workspace`/`$GUUEY_WORKSPACE`
 * and no personal workspace provisioned yet either — without this
 * fallback, deploy hard-fails with "needs a workspace" even though the
 * platform can trivially provision one for them.
 *
 * Returns `null` when no flag/env value is present AND either `opts` was
 * omitted or the personal-workspace request itself failed (network error,
 * non-2xx) — never on a request that merely succeeds with an unexpected
 * shape (that would be a backend contract break, not a "no workspace"
 * state). The caller prints the error + exits.
 *
 * Async (unlike the flag/env-only shape it replaces) because the fallback
 * is a network call — every call site must now `await` it.
 */
export async function resolveWorkspaceId(
  flags: Record<string, string | true> | undefined,
  env: NodeJS.ProcessEnv,
  opts?: { auth: AuthTokens; config: ResolvedConfig },
): Promise<string | null> {
  const flag = flags?.workspace;
  if (typeof flag === 'string' && flag.length > 0) return flag;
  const fromEnv = env.GUUEY_WORKSPACE;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  if (!opts) return null;

  const res = await apiRequest(opts.auth.pat, opts.config, 'GET', '/me/personal-workspace');
  if (!res.ok) return null;
  const data = (await res.json()) as { workspaceId: string };
  return data.workspaceId;
}

/**
 * Resolve the server name: `--name` flag wins, then the local package.json
 * `name` with any npm scope stripped (`@guuey/mcp-weather` → `mcp-weather` —
 * the segment after the last `/`). Returns `null` when neither yields a
 * non-empty string (the caller prints the error + exits).
 */
export function resolveServerName(
  flags: Record<string, string | true> | undefined,
  pkgName: string | undefined,
): string | null {
  const flag = flags?.name;
  if (typeof flag === 'string' && flag.length > 0) return flag;
  if (typeof pkgName === 'string' && pkgName.length > 0) {
    // Strip the npm scope: take the segment after the last '/'.
    const basenamed = pkgName.slice(pkgName.lastIndexOf('/') + 1);
    if (basenamed.length > 0) return basenamed;
  }
  return null;
}

/**
 * Validate a raw `--size` flag against the allowed pod sizes. Returns the
 * narrowed size on success, or `null` on an invalid/non-string value (the
 * caller prints the error + exits). The default of `'sm'` is applied by the
 * caller before validation, not here.
 */
export function validateMcpSize(raw: string | true | undefined): McpSize | null {
  if (typeof raw !== 'string') return null;
  // `.find` over the literal tuple narrows the result to `McpSize` without a
  // cast — the predicate compares the input against each valid size value.
  return MCP_SIZES.find((s) => s === raw) ?? null;
}

/**
 * Whether `label` is a valid git-tag-style version label (the same rule
 * `guuey deploy` uses): alphanumeric start, no spaces, no `..`, not ending
 * in `.lock` or `.`.
 */
export function isValidLabel(label: string): boolean {
  return (
    LABEL_REGEX.test(label) &&
    !label.includes('..') &&
    !label.endsWith('.lock') &&
    !label.endsWith('.')
  );
}

/** The exact `POST /mcp/deploy/upload` request body. */
export interface McpUploadBody {
  workspaceId: string;
  name: string;
  size: McpSize;
  contentLength: number;
  sourceHash: string;
}

/** Build the `POST /mcp/deploy/upload` request body. */
export function buildUploadBody(opts: {
  workspaceId: string;
  name: string;
  size: McpSize;
  contentLength: number;
  sourceHash: string;
}): McpUploadBody {
  return {
    workspaceId: opts.workspaceId,
    name: opts.name,
    size: opts.size,
    contentLength: opts.contentLength,
    sourceHash: opts.sourceHash,
  };
}

/** The exact `POST /mcp/deploy/trigger` request body. */
export interface McpTriggerBody {
  workspaceId: string;
  serverId: string;
  buildNumber: number;
  size: McpSize;
  /** The `s3Key` returned by the upload response (NOT recomputed). */
  sourceTarballKey: string;
  sourceHash: string;
  /** Omitted entirely when no `--label` was given. */
  versionLabel?: string;
}

/** Build the `POST /mcp/deploy/trigger` request body. */
export function buildTriggerBody(opts: {
  workspaceId: string;
  serverId: string;
  buildNumber: number;
  size: McpSize;
  sourceTarballKey: string;
  sourceHash: string;
  label?: string;
}): McpTriggerBody {
  return {
    workspaceId: opts.workspaceId,
    serverId: opts.serverId,
    buildNumber: opts.buildNumber,
    size: opts.size,
    sourceTarballKey: opts.sourceTarballKey,
    sourceHash: opts.sourceHash,
    ...(opts.label ? { versionLabel: opts.label } : {}),
  };
}

// ─── Command ────────────────────────────────────────────────────────────

/**
 * Read the local package.json `name`, or `undefined` if absent/unreadable.
 * Exported for reuse by the `guuey deploy` orchestrator (`../deploy-plan.ts`
 * consumer in `deploy.ts`), which resolves each hosted-MCP leg's deploy
 * name the same way `guuey mcp deploy` does — so a leg deployed via
 * `guuey deploy` and the same directory deployed directly via
 * `guuey mcp deploy` land on the identical workspace-unique name.
 */
export function readPackageName(cwd: string): string | undefined {
  const pkgJsonPath = join(cwd, 'package.json');
  if (!existsSync(pkgJsonPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { name?: unknown };
    return typeof pkg.name === 'string' ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/** Result of a successful {@link deployMcpFromSource} call. */
export interface McpSourceDeployResult {
  serverId: string;
  runtimeUrl?: string;
  buildNumber: number;
}

/**
 * Deploy a hosted MCP server from a local source directory.
 *
 * This is the reusable core of `guuey mcp deploy`: pack `dir` into a
 * tarball, upload it to S3 via a presigned URL (`serverId` + `buildNumber`
 * come back on the upload response), trigger the build with the upload's
 * `s3Key`, then poll `/mcp/deployments/:serverId/:buildNumber/status` until
 * the deploy reaches a terminal state. Throws on `failed` (using the status
 * payload's `errorMessage`), `superseded`, a non-202 trigger response, an S3
 * PUT failure, or a 22-minute timeout — callers decide how to present the
 * error (the CLI command prints it + exits; `guuey deploy`'s orchestrator
 * may aggregate it across multiple hosted MCP entries).
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection — network stubbing without a live backend.
 */
export async function deployMcpFromSource(
  opts: {
    /** Absolute path to the MCP package (must contain a Dockerfile). */
    dir: string;
    /** Workspace-unique server name. */
    name: string;
    workspaceId: string;
    /** Runtime pod size. Defaults to `'sm'` (matches `guuey mcp deploy`'s own default). */
    size?: McpSize;
    auth: AuthTokens;
    config: ResolvedConfig;
    /** Git-tag-style version label. Omitted entirely when not given. */
    label?: string;
  },
  deps?: { api?: typeof apiRequest },
): Promise<McpSourceDeployResult> {
  const api = deps?.api ?? apiRequest;
  const { dir, name, workspaceId, auth, config, label } = opts;
  const size = opts.size ?? 'sm';

  if (!existsSync(join(dir, 'Dockerfile'))) {
    throw new Error(
      'guuey mcp deploy requires a Dockerfile in the current directory (hosted MCP servers are code-mode).',
    );
  }

  console.log('');
  console.log('  Deploying hosted MCP server to guuey cloud...');
  console.log('');

  // 1. Pack source into a tarball. `includeWorkingTree` — a hosted MCP's
  // source lives in the builder's project tree (often uncommitted, e.g. a
  // scaffolded `mcps/todo`); tar the working tree deterministically rather
  // than `git archive`'s committed-only snapshot (which is empty for a
  // freshly scaffolded, not-yet-committed app). Same robust path the agent
  // leg uses.
  const buildId = randomUUID().slice(0, 12);
  const { tarballPath, tarballSize, sourceHash } = packSource({
    buildId,
    cwd: dir,
    includeWorkingTree: true,
  });

  // 2. Get presigned upload URL + reserve serverId + buildNumber.
  const uploadRes = await api(auth.pat, config, 'POST', '/mcp/deploy/upload', {
    ...buildUploadBody({ workspaceId, name, size, contentLength: tarballSize, sourceHash }),
  });

  if (!uploadRes.ok) {
    const data: unknown = await uploadRes.json().catch(() => ({}));
    cleanup(tarballPath);
    throw new Error(parseApiError(data, `Upload failed: HTTP ${uploadRes.status}`));
  }

  const { uploadUrl, serverId, buildNumber, s3Key } = (await uploadRes.json()) as {
    uploadUrl: string;
    uploadId: string;
    serverId: string;
    buildNumber: number;
    s3Key: string;
  };

  // 3. Upload tarball to S3 via the presigned URL.
  const fileBuffer = readFileSync(tarballPath);
  const uploadToS3 = await fetch(uploadUrl, {
    method: 'PUT',
    body: fileBuffer,
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(tarballSize),
    },
  });

  if (!uploadToS3.ok) {
    cleanup(tarballPath);
    throw new Error(`S3 upload failed: HTTP ${uploadToS3.status}`);
  }

  // 4. Trigger the build + deploy.
  console.log('  Building & deploying...');
  const triggerRes = await api(auth.pat, config, 'POST', '/mcp/deploy/trigger', {
    ...buildTriggerBody({
      workspaceId,
      serverId,
      buildNumber,
      size,
      sourceTarballKey: s3Key,
      sourceHash,
      label,
    }),
  });

  if (triggerRes.status !== 202) {
    const data = (await triggerRes.json().catch(() => ({}))) as { retryAfterSeconds?: number };
    cleanup(tarballPath);
    if (triggerRes.status === 429) {
      // Quota hit — surface the reason + a Retry-After hint if we got one.
      const secs = Number(
        data.retryAfterSeconds ?? triggerRes.headers.get('Retry-After') ?? 0,
      );
      const when = secs > 0 ? ` Retry in ~${Math.ceil(secs / 60)} minute(s).` : '';
      throw new Error(`${parseApiError(data, 'Build quota exceeded.')}${when}`);
    }
    // Includes 409 (concurrent build number) — surface its message.
    throw new Error(parseApiError(data, `Deploy trigger failed: HTTP ${triggerRes.status}`));
  }

  // 5. Poll for completion. No build-log streaming endpoint for MCP — poll only.
  let status = 'queued';
  let runtimeUrl: string | null = null;
  let lastMessage = '';
  const startTime = Date.now();
  // Kaniko build budget — matches code-mode deploy's 22-minute ceiling.
  const TIMEOUT_MS = 22 * 60 * 1000;

  while (status !== 'live' && status !== 'failed' && status !== 'superseded') {
    if (Date.now() - startTime > TIMEOUT_MS) {
      cleanup(tarballPath);
      throw new Error('Deploy timed out after 22 minutes.');
    }

    await new Promise((r) => setTimeout(r, 3000));

    const statusRes = await api(
      auth.pat,
      config,
      'GET',
      `/mcp/deployments/${serverId}/${buildNumber}/status`,
    );
    if (!statusRes.ok) {
      if (process.env.GGUI_DEBUG) {
        const errBody = await statusRes.text().catch(() => '');
        console.error(`  [poll] HTTP ${statusRes.status}: ${errBody.slice(0, 100)}`);
      }
      continue;
    }

    const data = (await statusRes.json()) as {
      status: string;
      runtimeUrl?: string | null;
      errorMessage?: string | null;
      message?: string;
    };

    if (data.status === 'queued' && lastMessage !== 'Queued...') {
      console.log('  Queued...');
      lastMessage = 'Queued...';
    } else if (data.message && data.message !== lastMessage) {
      console.log(`  ${data.message}`);
      lastMessage = data.message;
    } else if (data.status !== status && data.status !== 'queued') {
      console.log(`  ${data.status}...`);
    }

    status = data.status;
    if (data.runtimeUrl) runtimeUrl = data.runtimeUrl;
    // The MCP status payload uses `errorMessage` (the app-deploy one used `error`).
    if (data.errorMessage) {
      cleanup(tarballPath);
      throw new Error(data.errorMessage);
    }
  }

  // 6. Done.
  cleanup(tarballPath);

  if (status === 'superseded') {
    console.log('');
    throw new Error(
      'Deployment superseded by a newer deploy. Run "guuey mcp deploy" again if needed.',
    );
  }

  if (status === 'failed') {
    console.log('');
    throw new Error('Deployment failed.');
  }

  console.log('');
  out.success(`Hosted MCP live at ${runtimeUrl}`);
  console.log('');
  console.log(`  Server: ${name}`);
  console.log(`  Build:  #${buildNumber}${label ? ` (${label})` : ''}`);
  console.log(`  Size:   ${size}`);
  console.log('  Scales to zero when idle.');
  console.log('');

  return { serverId, runtimeUrl: runtimeUrl ?? undefined, buildNumber };
}

/**
 * Handle the `guuey mcp deploy` command.
 *
 * Resolves + validates inputs (workspace, name, size, label) from CLI flags
 * exactly as before, then delegates the pack→upload→trigger→poll flow to
 * {@link deployMcpFromSource}, printing its thrown error + exiting 1 on
 * failure (matching the command's pre-refactor behavior).
 *
 * @param flags - CLI flags (e.g., `{ name: 'mcp-weather', size: 'md' }`)
 */
export async function mcpDeploy(flags?: Record<string, string | true>): Promise<void> {
  const cwd = process.cwd();

  // ── Resolve + validate inputs BEFORE any I/O ─────────────────────────
  const auth = requireAuth();
  const config = resolveConfig();
  const workspaceId = await resolveWorkspaceId(flags, process.env, { auth, config });
  if (!workspaceId) {
    out.error(
      'No workspace resolved. Pass --workspace <id>, set GUUEY_WORKSPACE, or check ' +
        'connectivity — the personal-workspace fallback (GET /v1/me/personal-workspace) also failed.',
    );
    process.exit(1);
  }

  const name = resolveServerName(flags, readPackageName(cwd));
  if (!name) {
    out.error(
      'No server name. Pass --name <server-name> or add a "name" to your package.json.',
    );
    process.exit(1);
  }

  // Default to 'sm' before validating; the validator only accepts/rejects.
  const rawSize = flags?.size ?? 'sm';
  const size = validateMcpSize(rawSize);
  if (!size) {
    out.error(
      `Invalid --size "${String(rawSize)}". Must be one of: ${MCP_SIZES.join(', ')}.`,
    );
    process.exit(1);
  }

  const label = typeof flags?.label === 'string' ? flags.label : undefined;
  if (label !== undefined && !isValidLabel(label)) {
    out.error(
      `Invalid label "${label}". Use git-tag format: alphanumeric, dots, hyphens, underscores. No spaces or special characters.`,
    );
    process.exit(1);
  }

  // ── Preconditions ────────────────────────────────────────────────────
  try {
    await deployMcpFromSource({ dir: cwd, name, workspaceId, size, auth, config, label });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ─── mcp secrets (set / list / unset) ───────────────────────────────────
//
// Manage a hosted MCP server's secret vault via the workspace-scoped
// `/mcp/secrets` endpoints (T7.2). Secrets are KMS-encrypted server-side; the
// value never leaves the gateway. The CLI mirrors that contract:
//
//   SECURITY: the CLI NEVER prints a secret value. `set`/`unset` success
//   messages show the NAME only; `list` prints names only (the endpoint
//   returns no values). There is no code path here that logs a value.

/** Env-var-style secret name rule — matches the backend `SECRET_NAME_RE`. */
const SECRET_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a `NAME=VALUE` assignment into its parts.
 *
 * Splits on the FIRST `=` only, so a value may itself contain `=`
 * (`X=a=b` → `{ name: 'X', value: 'a=b' }`). Returns `null` when:
 *   - there is no `=` (e.g. `FOO`),
 *   - the name is empty (e.g. `=v`),
 *   - the name is not env-var-style (`^[A-Za-z_][A-Za-z0-9_]*$`), or
 *   - the value is empty (e.g. `FOO=` — the backend rejects empty values).
 */
export function parseSecretAssignment(
  arg: string | undefined,
): { name: string; value: string } | null {
  if (typeof arg !== 'string') return null;
  const eq = arg.indexOf('=');
  if (eq < 0) return null;
  const name = arg.slice(0, eq);
  const value = arg.slice(eq + 1);
  if (name.length === 0 || !SECRET_NAME_REGEX.test(name)) return null;
  if (value.length === 0) return null;
  return { name, value };
}

/**
 * Resolve the target hosted-MCP server id: `--server` flag wins, then the
 * `GUUEY_MCP_SERVER` env var. Returns `null` when neither yields a value (the
 * caller prints the error + exits). Mirrors `resolveWorkspaceId`.
 */
export function resolveServerId(
  flags: Record<string, string | true> | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  const flag = flags?.server;
  if (typeof flag === 'string' && flag.length > 0) return flag;
  const fromEnv = env.GUUEY_MCP_SERVER;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return null;
}

/** Read an authenticated-error response into a human message + exit 1. */
async function failFromResponse(res: Response): Promise<never> {
  const data: unknown = await res.json().catch(() => ({}));
  out.error(parseApiError(data, `HTTP ${res.status}`));
  process.exit(1);
}

/**
 * `guuey mcp secrets set NAME=VALUE --server <id>`
 *
 * KMS-encrypts + stores a hosted-MCP secret. The success message shows the
 * NAME only — the value is NEVER printed.
 */
export async function mcpSecretsSet(
  assignment: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  const parsed = parseSecretAssignment(assignment);
  if (!parsed) {
    out.error('Usage: guuey mcp secrets set NAME=VALUE --server <id>');
    process.exit(1);
  }

  const serverId = resolveServerId(flags, process.env);
  if (!serverId) {
    out.error(
      'No MCP server specified. Pass --server <id> or set the GUUEY_MCP_SERVER environment variable.',
    );
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();

  const res = await apiRequest(auth.pat, config, 'POST', '/mcp/secrets', {
    serverId,
    name: parsed.name,
    value: parsed.value,
  });
  if (!res.ok) return failFromResponse(res);

  // SECURITY: NAME only — never print parsed.value.
  out.success(`Set ${parsed.name} for ${serverId}`);
}

/**
 * `guuey mcp secrets list --server <id>`
 *
 * Lists a server's secret NAMES. The endpoint returns names only — there is
 * no value to print.
 */
export async function mcpSecretsList(
  flags?: Record<string, string | true>,
): Promise<void> {
  const serverId = resolveServerId(flags, process.env);
  if (!serverId) {
    out.error(
      'No MCP server specified. Pass --server <id> or set the GUUEY_MCP_SERVER environment variable.',
    );
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();

  const res = await apiRequest(
    auth.pat,
    config,
    'GET',
    `/mcp/secrets?serverId=${encodeURIComponent(serverId)}`,
  );
  if (!res.ok) return failFromResponse(res);

  const data = (await res.json()) as { names: string[] };

  if (data.names.length === 0) {
    console.log(
      '  No secrets set. Add one: guuey mcp secrets set NAME=VALUE --server <id>',
    );
    return;
  }

  // SECURITY: NAMES only — the endpoint returns no values to print.
  for (const name of data.names) {
    console.log(`  ${name}`);
  }
}

/**
 * `guuey mcp secrets unset NAME --server <id>`
 *
 * Removes a hosted-MCP secret (idempotent server-side). The success message
 * shows the NAME only.
 */
export async function mcpSecretsUnset(
  name: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (typeof name !== 'string' || name.length === 0) {
    out.error('Usage: guuey mcp secrets unset NAME --server <id>');
    process.exit(1);
  }

  const serverId = resolveServerId(flags, process.env);
  if (!serverId) {
    out.error(
      'No MCP server specified. Pass --server <id> or set the GUUEY_MCP_SERVER environment variable.',
    );
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();

  const res = await apiRequest(auth.pat, config, 'DELETE', '/mcp/secrets', {
    serverId,
    name,
  });
  if (!res.ok) return failFromResponse(res);

  out.success(`Unset ${name} for ${serverId}`);
}

// ─── mcp logs (captured build output) ───────────────────────────────────
//
// `guuey mcp logs <server> [--build N]` renders the CAPTURED build output for
// one build of a hosted MCP server — there is NO live log streaming (spec M4,
// amended 2026-07-04: zero new log infrastructure in this cut).
//
// Source of truth: the Task-1 status route
// `GET /mcp/servers/:serverId?workspaceId=…`, whose `deployments[]` rows carry
// `errorMessage` — the deploy-controller's best-effort tail-50-lines Kaniko
// capture (≤2000 chars, see `deploy-controller/src/k8s/mcp-build.ts
// #captureMcpBuildLogs`). The reconciler writes it ONLY on the
// `building → failed` transitions (build error or timeout — see
// `reconcile-mcp-one.ts`), so successful builds have no captured output; the
// renderer says so honestly instead of implying logs were lost.

/**
 * Resolve the target server for positional-style mcp commands
 * (`guuey mcp logs <server>`): `--server` flag wins, then the positional
 * argument, then the `GUUEY_MCP_SERVER` env var (via {@link resolveServerId}).
 * Returns `null` when nothing yields a value (the caller prints the error +
 * exits).
 */
export function resolveServerRef(
  positional: string | undefined,
  flags: Record<string, string | true> | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  const flag = flags?.server;
  if (typeof flag === 'string' && flag.length > 0) return flag;
  if (typeof positional === 'string' && positional.length > 0) return positional;
  return resolveServerId(undefined, env);
}

/**
 * One row of the status route's `deployments[]` projection (the T1
 * `mcp-registry.ts#McpDeploymentProjection` wire shape — newest-first,
 * capped at the 10 most recent builds).
 */
export interface McpDeploymentInfo {
  buildNumber: number;
  status: string;
  /** Captured build-failure tail (only failed builds carry one). */
  errorMessage?: string;
  updatedAt: string;
}

/** The `GET /mcp/servers/:serverId` (T1 status route) response shape. */
export interface McpServerStatusResponse {
  server: {
    serverId: string;
    name: string;
    hostingStatus: string;
    size: string;
    runtimeUrl?: string;
    updatedAt: string;
  };
  deployments: McpDeploymentInfo[];
  grantCount: number;
}

/**
 * Pick the build to render: `--build N` selects by build number; no flag
 * means the latest build (`deployments[0]` — the route returns newest-first).
 * Errors are returned (not thrown) so the pure helper stays I/O-free; every
 * error names `guuey mcp status` as the next step.
 */
export function selectMcpBuild(
  deployments: McpDeploymentInfo[],
  buildFlag: string | true | undefined,
): { ok: true; deployment: McpDeploymentInfo } | { ok: false; error: string } {
  if (deployments.length === 0) {
    return {
      ok: false,
      error:
        'No builds found for this server. Run "guuey mcp status <server>" to check its deploy history.',
    };
  }
  if (buildFlag === undefined) {
    // Newest-first projection — the first row is the latest build.
    return { ok: true, deployment: deployments[0]! };
  }
  if (typeof buildFlag !== 'string' || !/^[1-9][0-9]*$/.test(buildFlag)) {
    return {
      ok: false,
      error: `Invalid --build "${String(buildFlag)}". Pass a positive build number, e.g. --build 3.`,
    };
  }
  const wanted = Number(buildFlag);
  const deployment = deployments.find((d) => d.buildNumber === wanted);
  if (!deployment) {
    return {
      ok: false,
      error:
        `Build #${wanted} not found in the ${deployments.length} most recent build(s). ` +
        'Run "guuey mcp status <server>" to see available builds.',
    };
  }
  return { ok: true, deployment };
}

/**
 * Render one build's captured output as plain lines (pure — the command adds
 * the indent + prints). Layout:
 *
 *   1. Header: build number, status, updatedAt.
 *   2. The `errorMessage` content VERBATIM when present (it is the
 *      deploy-controller's tail-50 Kaniko capture), else an honest
 *      "no captured output" line — plus, for non-failed builds, a note that
 *      only failed builds capture output at all.
 *   3. ALWAYS ends with the one-liner that full build/runtime log streaming
 *      is a future observability slice — never implies more logs exist.
 */
export function renderMcpBuildLogs(deployment: McpDeploymentInfo): string[] {
  const lines: string[] = [
    `Build #${deployment.buildNumber} — ${deployment.status} — ${deployment.updatedAt}`,
    '',
  ];
  if (deployment.errorMessage) {
    lines.push(...deployment.errorMessage.split('\n'));
  } else {
    lines.push('No captured output for this build.');
    if (deployment.status !== 'failed') {
      lines.push('(Only failed builds capture output — the build-failure tail from the builder.)');
    }
  }
  lines.push('');
  lines.push(
    'Note: full build/runtime log streaming is a future observability slice; this shows the captured build output only.',
  );
  return lines;
}

/**
 * The reusable core of `guuey mcp logs`: fetch the server's status
 * projection, select the requested build (default: latest), and print its
 * captured output — or the selected deployment row as JSON with `--json`.
 * Throws on API failures (via `parseApiError`) and on build-selection errors;
 * the command wrapper prints + exits.
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection (mirrors {@link deployMcpFromSource}).
 */
export async function mcpLogsCore(
  opts: {
    serverId: string;
    workspaceId: string;
    /** Raw `--build` flag value; `undefined` = latest build. */
    buildFlag: string | true | undefined;
    json: boolean;
    auth: AuthTokens;
    config: ResolvedConfig;
  },
  deps?: { api?: typeof apiRequest },
): Promise<void> {
  const api = deps?.api ?? apiRequest;

  const res = await api(
    opts.auth.pat,
    opts.config,
    'GET',
    `/mcp/servers/${encodeURIComponent(opts.serverId)}?workspaceId=${encodeURIComponent(opts.workspaceId)}`,
  );
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }

  const data = (await res.json()) as McpServerStatusResponse;
  const selected = selectMcpBuild(data.deployments, opts.buildFlag);
  if (!selected.ok) throw new Error(selected.error);

  if (opts.json) {
    out.json(selected.deployment);
    return;
  }

  console.log('');
  for (const line of renderMcpBuildLogs(selected.deployment)) {
    console.log(line.length > 0 ? `  ${line}` : '');
  }
  console.log('');
}

// ─── mcp list / mcp status ──────────────────────────────────────────────
//
// `guuey mcp list` and `guuey mcp status <server>` render the T1 registry
// read routes (`GET /mcp/servers` / `GET /mcp/servers/:serverId`). Both
// reuse `McpServerStatusResponse`/`McpDeploymentInfo` (declared above for
// `mcp logs`) plus the new `McpServerListItem` for the list projection,
// which additionally carries `latestBuild` (list-only — the status route's
// `server` projection omits it since `deployments[]` already covers build
// history there).

/**
 * One row of the `servers-list` route's projection (the T1
 * `mcp-registry.ts#McpServerListItem` wire shape).
 */
export interface McpServerListItem {
  serverId: string;
  name: string;
  hostingStatus: string;
  size: string;
  runtimeUrl?: string;
  updatedAt: string;
  /** Newest deployment for this server, if any have been triggered yet. */
  latestBuild?: { buildNumber: number; status: string };
}

/** The `GET /mcp/servers` (T1 list route) response shape. */
export interface McpServersListResponse {
  servers: McpServerListItem[];
}

/**
 * Render a `latestBuild` as `"#<n> <status>"`, or an em dash when the
 * server has never had a build triggered.
 */
export function formatLatestBuild(
  latestBuild: { buildNumber: number; status: string } | undefined,
): string {
  if (!latestBuild) return '—';
  return `#${latestBuild.buildNumber} ${latestBuild.status}`;
}

/**
 * Build one `out.table` row for `guuey mcp list`: NAME, SERVER ID, STATUS,
 * SIZE, URL, LAST BUILD (an em dash for an absent URL/build, matching
 * {@link formatLatestBuild}'s convention).
 */
export function mcpServerListRow(server: McpServerListItem): Record<string, string> {
  return {
    NAME: server.name,
    'SERVER ID': server.serverId,
    STATUS: server.hostingStatus,
    SIZE: server.size,
    URL: server.runtimeUrl ?? '—',
    'LAST BUILD': formatLatestBuild(server.latestBuild),
  };
}

/** Column order for the `guuey mcp list` table (passed to `out.table`). */
const MCP_LIST_COLUMNS = ['NAME', 'SERVER ID', 'STATUS', 'SIZE', 'URL', 'LAST BUILD'];

/**
 * Build one `out.table` row for `guuey mcp status`'s deployments table:
 * BUILD, STATUS, UPDATED, NOTE. `NOTE` flags (never prints the content of)
 * a captured build-failure tail — pointing at `mcp logs` for the detail,
 * so the status view stays a short scannable table.
 */
export function mcpDeploymentRow(d: McpDeploymentInfo): Record<string, string> {
  return {
    BUILD: `#${d.buildNumber}`,
    STATUS: d.status,
    UPDATED: d.updatedAt,
    NOTE: d.errorMessage ? 'captured output — see mcp logs' : '',
  };
}

/** Column order for the `guuey mcp status` deployments table. */
const MCP_STATUS_DEPLOYMENTS_COLUMNS = ['BUILD', 'STATUS', 'UPDATED', 'NOTE'];

/**
 * The reusable core of `guuey mcp list`: fetch the workspace's server
 * registry and render it as a table (or the raw `servers` array with
 * `--json`). An empty workspace prints a friendly line instead of an empty
 * table — this is a normal, expected state (a fresh workspace with no
 * hosted MCP servers yet), not an error.
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection (mirrors {@link mcpLogsCore}).
 */
export async function mcpListCore(
  opts: {
    workspaceId: string;
    json: boolean;
    auth: AuthTokens;
    config: ResolvedConfig;
  },
  deps?: { api?: typeof apiRequest },
): Promise<void> {
  const api = deps?.api ?? apiRequest;

  const res = await api(
    opts.auth.pat,
    opts.config,
    'GET',
    `/mcp/servers?workspaceId=${encodeURIComponent(opts.workspaceId)}`,
  );
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }

  const data = (await res.json()) as McpServersListResponse;

  if (opts.json) {
    out.json(data.servers);
    return;
  }

  if (data.servers.length === 0) {
    console.log('  No hosted MCP servers in this workspace yet. Run "guuey mcp deploy" to add one.');
    return;
  }

  out.table(data.servers.map(mcpServerListRow), MCP_LIST_COLUMNS);
}

/**
 * `guuey mcp list [--workspace <id>] [--json]`
 *
 * List the workspace's hosted MCP server registry as a table (name, id,
 * status, size, URL, last build) — or the raw servers array with `--json`.
 * Workspace resolution: `--workspace` | `$GUUEY_WORKSPACE`.
 */
export async function mcpList(flags?: Record<string, string | true>): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const workspaceId = await resolveWorkspaceId(flags, process.env, { auth, config });
  if (!workspaceId) {
    out.error(
      'No workspace resolved. Pass --workspace <id>, set GUUEY_WORKSPACE, or check ' +
        'connectivity — the personal-workspace fallback (GET /v1/me/personal-workspace) also failed.',
    );
    process.exit(1);
  }

  try {
    await mcpListCore({ workspaceId, json: flags?.json === true, auth, config });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * The reusable core of `guuey mcp status`: fetch one server's registry row
 * + deployment history + grant count (the T1 status route) and render a
 * summary block + deployments table + grant count — or the whole response
 * verbatim with `--json`.
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection (mirrors {@link mcpLogsCore}).
 */
export async function mcpStatusCore(
  opts: {
    serverId: string;
    workspaceId: string;
    json: boolean;
    auth: AuthTokens;
    config: ResolvedConfig;
  },
  deps?: { api?: typeof apiRequest },
): Promise<void> {
  const api = deps?.api ?? apiRequest;

  const res = await api(
    opts.auth.pat,
    opts.config,
    'GET',
    `/mcp/servers/${encodeURIComponent(opts.serverId)}?workspaceId=${encodeURIComponent(opts.workspaceId)}`,
  );
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }

  const data = (await res.json()) as McpServerStatusResponse;

  if (opts.json) {
    out.json(data);
    return;
  }

  const { server, deployments, grantCount } = data;
  console.log('');
  console.log(`  ${server.name} (${server.serverId})`);
  console.log(`  Status:  ${server.hostingStatus}`);
  console.log(`  Size:    ${server.size}`);
  console.log(`  URL:     ${server.runtimeUrl ?? '—'}`);
  console.log(`  Updated: ${server.updatedAt}`);
  console.log('');
  out.table(deployments.map(mcpDeploymentRow), MCP_STATUS_DEPLOYMENTS_COLUMNS);
  console.log('');
  console.log(`  Grants: ${grantCount} ${grantCount === 1 ? 'app' : 'apps'}`);
  console.log('');
}

/**
 * `guuey mcp status <server> [--workspace <id>] [--json]`
 *
 * Show one hosted MCP server's registry row, deployment history, and grant
 * count. Server resolution: `--server` | positional | `$GUUEY_MCP_SERVER`;
 * workspace: `--workspace` | `$GUUEY_WORKSPACE`.
 */
export async function mcpStatus(
  serverArg: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  const serverId = resolveServerRef(serverArg, flags, process.env);
  if (!serverId) {
    out.error(
      'No MCP server specified. Pass <server>, --server <id>, or set the GUUEY_MCP_SERVER environment variable.',
    );
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();
  const workspaceId = await resolveWorkspaceId(flags, process.env, { auth, config });
  if (!workspaceId) {
    out.error(
      'No workspace resolved. Pass --workspace <id>, set GUUEY_WORKSPACE, or check ' +
        'connectivity — the personal-workspace fallback (GET /v1/me/personal-workspace) also failed.',
    );
    process.exit(1);
  }

  try {
    await mcpStatusCore({
      serverId,
      workspaceId,
      json: flags?.json === true,
      auth,
      config,
    });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * `guuey mcp logs <server> [--build N] [--workspace <id>] [--json]`
 *
 * Show the captured build output for one build of a hosted MCP server
 * (default: the latest build). Server resolution: `--server` | positional |
 * `$GUUEY_MCP_SERVER`; workspace: `--workspace` | `$GUUEY_WORKSPACE`.
 */
export async function mcpLogs(
  serverArg: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  const serverId = resolveServerRef(serverArg, flags, process.env);
  if (!serverId) {
    out.error(
      'No MCP server specified. Pass <server>, --server <id>, or set the GUUEY_MCP_SERVER environment variable.',
    );
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();
  const workspaceId = await resolveWorkspaceId(flags, process.env, { auth, config });
  if (!workspaceId) {
    out.error(
      'No workspace resolved. Pass --workspace <id>, set GUUEY_WORKSPACE, or check ' +
        'connectivity — the personal-workspace fallback (GET /v1/me/personal-workspace) also failed.',
    );
    process.exit(1);
  }

  try {
    await mcpLogsCore({
      serverId,
      workspaceId,
      buildFlag: flags?.build,
      json: flags?.json === true,
      auth,
      config,
    });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ─── mcp delete (fail-closed deprovision) ───────────────────────────────
//
// `guuey mcp delete <server> [--force] [--yes]` requests deprovision via the
// T4 `DELETE /mcp/servers/:serverId` route, then polls
// `/mcp/servers/:serverId/delete-status` to completion. Deletion is
// fail-closed (spec M3): the backend refuses while `HostedMcpGrant` rows
// exist unless `--force` is passed (which also revokes those grants), and
// refuses while a deployment is in-flight regardless of `--force`. Both
// cases come back as a TOP-LEVEL `{code, ...}` 409 body (NOT the standard
// nested `{error:{code,message}}` envelope) so the CLI can special-case the
// grants-exist app list; every other failure goes through the shared
// `parseApiError`, which already falls back to a top-level `message` field.

/**
 * Thrown when the DELETE route refuses because `HostedMcpGrant` rows still
 * exist and `--force` was not passed. Carries the attached app ids
 * separately from `message` so the command can render them as a list
 * instead of the single comma-joined sentence the backend message uses.
 */
export class McpDeleteGrantsExistError extends Error {
  readonly apps: string[];

  constructor(apps: string[], message: string) {
    super(message);
    this.name = 'McpDeleteGrantsExistError';
    this.apps = apps;
  }
}

/** The DELETE route's top-level `grants-exist` 409 body (spec §3-4 / T4). */
interface McpDeleteGrantsExistBody {
  code: 'grants-exist';
  apps: string[];
  message: string;
}

/** The DELETE route's top-level `deployment-in-progress` 409 body. */
interface McpDeleteInProgressBody {
  code: 'deployment-in-progress';
  message: string;
}

function isGrantsExistBody(data: unknown): data is McpDeleteGrantsExistBody {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return (
    record.code === 'grants-exist' &&
    Array.isArray(record.apps) &&
    record.apps.every((app) => typeof app === 'string') &&
    typeof record.message === 'string'
  );
}

function isDeploymentInProgressBody(data: unknown): data is McpDeleteInProgressBody {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return record.code === 'deployment-in-progress' && typeof record.message === 'string';
}

/**
 * Destructive-op confirmation gate for `guuey mcp delete` (pure — no I/O).
 *
 *   - `--yes` always skips the prompt (`'skip'`).
 *   - An interactive session (both stdin AND stdout are TTYs) without
 *     `--yes` prompts (`'prompt'`) — the caller runs the actual readline
 *     question.
 *   - A non-interactive session (script/CI/pipe) without `--yes` refuses
 *     outright (`'refuse'`) — there is no channel to confirm on, and
 *     silently proceeding on a destructive op would be unsafe.
 */
export function resolveMcpDeleteConfirmation(opts: {
  yes: boolean;
  stdinIsTTY: boolean | undefined;
  stdoutIsTTY: boolean | undefined;
}): 'skip' | 'prompt' | 'refuse' {
  if (opts.yes) return 'skip';
  if (opts.stdinIsTTY === true && opts.stdoutIsTTY === true) return 'prompt';
  return 'refuse';
}

/** Parse a readline answer as an affirmative confirmation (`y`/`yes`, case-insensitive). */
export function parseYesNoAnswer(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

/**
 * Poll `GET /mcp/servers/:serverId/delete-status` until the deprovision
 * completes. Per spec §3-4 / T4: the route reports `{status:'deleting'}`
 * while the deploy-controller's deleting phase is still tearing down
 * resources; once its FINAL step (the `McpServer` row delete) lands, the
 * route 404s — the CLI treats that 404 as terminal success, never a
 * fabricated `'deleted'` status. A 409 (the row exists but isn't in
 * `'deleting'` status) or any other failure surfaces via `parseApiError`.
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection (mirrors {@link mcpLogsCore}). `intervalMs` defaults to 3
 * seconds in production; tests override it (and `timeoutMs`) to stay fast.
 */
export async function pollMcpDeleteStatus(
  opts: {
    auth: { pat: string };
    config: { apiUrl?: string };
    serverId: string;
    workspaceId: string;
    timeoutMs: number;
    intervalMs?: number;
  },
  deps?: { api?: typeof apiRequest },
): Promise<'deleted'> {
  const api = deps?.api ?? apiRequest;
  const { auth, config, serverId, workspaceId, timeoutMs } = opts;
  const intervalMs = opts.intervalMs ?? 3000;
  const startTime = Date.now();
  let lastStatus = '';
  let deleted = false;

  while (!deleted) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(
        `Delete timed out after ${Math.round(timeoutMs / 60000)} minute(s). ` +
          `The deprovision may still complete in the background — check ` +
          `"guuey mcp status ${serverId}" later.`,
      );
    }

    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await api(
      auth.pat,
      config,
      'GET',
      `/mcp/servers/${encodeURIComponent(serverId)}/delete-status?workspaceId=${encodeURIComponent(workspaceId)}`,
    );

    // Registry 404 = deleted (success) — the row's final teardown step.
    if (res.status === 404) {
      deleted = true;
      continue;
    }

    if (!res.ok) {
      const data: unknown = await res.json().catch(() => ({}));
      throw new Error(parseApiError(data, `HTTP ${res.status}`));
    }

    const data = (await res.json()) as { status: string };
    if (data.status !== lastStatus) {
      console.log(`  ${data.status}...`);
      lastStatus = data.status;
    }
  }

  return 'deleted';
}

/**
 * The reusable core of `guuey mcp delete`: request deprovision (T4's
 * `DELETE /mcp/servers/:serverId`), then poll to completion. Throws
 * {@link McpDeleteGrantsExistError} for the no-force grants-exist 409,
 * a plain `Error` (backend's message verbatim) for the deployment-in-progress
 * 409, and a `parseApiError`-derived `Error` for every other failure.
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection (mirrors {@link deployMcpFromSource}).
 */
export async function mcpDeleteCore(
  opts: {
    serverId: string;
    workspaceId: string;
    force: boolean;
    auth: AuthTokens;
    config: ResolvedConfig;
    /** Poll timeout in ms; defaults to 5 minutes. Tests override to stay fast. */
    pollTimeoutMs?: number;
    /** Poll interval in ms; defaults to 3 seconds. Tests override to stay fast. */
    pollIntervalMs?: number;
  },
  deps?: { api?: typeof apiRequest },
): Promise<void> {
  const api = deps?.api ?? apiRequest;
  const { serverId, workspaceId, force, auth, config } = opts;

  const query = `workspaceId=${encodeURIComponent(workspaceId)}${force ? '&force=1' : ''}`;
  const res = await api(
    auth.pat,
    config,
    'DELETE',
    `/mcp/servers/${encodeURIComponent(serverId)}?${query}`,
  );

  if (res.status !== 202) {
    const data: unknown = await res.json().catch(() => ({}));
    if (isGrantsExistBody(data)) {
      throw new McpDeleteGrantsExistError(data.apps, data.message);
    }
    if (isDeploymentInProgressBody(data)) {
      throw new Error(data.message);
    }
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }

  console.log('');
  console.log(`  Deleting ${serverId}...`);

  await pollMcpDeleteStatus(
    {
      auth,
      config,
      serverId,
      workspaceId,
      timeoutMs: opts.pollTimeoutMs ?? 5 * 60 * 1000,
      intervalMs: opts.pollIntervalMs,
    },
    { api },
  );

  console.log('');
  out.success(`Deleted ${serverId}`);
  console.log('');
}

/**
 * `guuey mcp delete <server> [--force] [--yes] [--workspace <id>]`
 *
 * Fail-closed deprovision of a hosted MCP server. Destructive — gated by
 * {@link resolveMcpDeleteConfirmation}: an interactive TTY session prompts
 * "delete <serverId>? [y/N]" unless `--yes` is passed; a non-interactive
 * session without `--yes` refuses outright. `--force` overrides the
 * backend's grants-exist refusal (and revokes those grants). Server
 * resolution: `--server` | positional | `$GUUEY_MCP_SERVER`; workspace:
 * `--workspace` | `$GUUEY_WORKSPACE`.
 */
export async function mcpDelete(
  serverArg: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  const serverId = resolveServerRef(serverArg, flags, process.env);
  if (!serverId) {
    out.error(
      'No MCP server specified. Pass <server>, --server <id>, or set the GUUEY_MCP_SERVER environment variable.',
    );
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();
  const workspaceId = await resolveWorkspaceId(flags, process.env, { auth, config });
  if (!workspaceId) {
    out.error(
      'No workspace resolved. Pass --workspace <id>, set GUUEY_WORKSPACE, or check ' +
        'connectivity — the personal-workspace fallback (GET /v1/me/personal-workspace) also failed.',
    );
    process.exit(1);
  }

  const force = flags?.force === true;
  const yes = flags?.yes === true;

  const confirmation = resolveMcpDeleteConfirmation({
    yes,
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  });

  if (confirmation === 'refuse') {
    out.error(
      `Refusing to delete '${serverId}' without confirmation in a non-interactive session. Pass --yes to confirm.`,
    );
    process.exit(1);
  }

  if (confirmation === 'prompt') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = await new Promise<string>((res) =>
        rl.question(`  Delete '${serverId}'? [y/N] `, res),
      );
    } finally {
      rl.close();
    }
    if (!parseYesNoAnswer(answer)) {
      console.log('  Aborted.');
      return;
    }
  }

  try {
    await mcpDeleteCore({ serverId, workspaceId, force, auth, config });
  } catch (err) {
    if (err instanceof McpDeleteGrantsExistError) {
      out.error(err.message);
      console.log('');
      console.log('  Attached app(s):');
      for (const appId of err.apps) console.log(`    - ${appId}`);
      console.log('');
      process.exit(1);
    }
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ─── mcp state list|export|wipe (spec §4, walls2 T6) ────────────────────
//
// The ratified colocated-state admin leg: `guuey mcp state ...` lets a
// builder inspect/export/wipe end-user KV state on ONE MCP server (hosted
// or colocated) they administer. It hits the stateApi's Task-8 admin
// surface (`POST /state/admin.{list,export,wipe}`), NOT the cliApi — same
// HttpApi origin, same PAT `apiRequest` helper, but a DIFFERENT (flat
// `{code,message}`) error envelope. `parseApiError` already falls through
// to its top-level `record.message` branch for a body with no `error`
// field, so it renders the flat envelope correctly with no changes needed
// here or in `deploy-shared.ts`.

/** One user's usage row within `guuey mcp state list`'s `admin.list` result. */
export interface McpStateScopeUsage {
  userId: string;
  usedBytes: number;
  keyCount: number;
}

/** The stateApi `admin.list` route's `{ result: { scopes } }` response shape. */
interface McpStateAdminListResponse {
  result: { scopes: McpStateScopeUsage[] };
}

/** The stateApi `admin.export` route's `{ result: { entries } }` response shape. */
interface McpStateAdminExportResponse {
  result: { entries: Record<string, unknown> };
}

/** The stateApi `admin.wipe` route's `{ result: { deleted } }` response shape. */
interface McpStateAdminWipeResponse {
  result: { deleted: number };
}

/**
 * Resolve the target MCP server's admin `serverUrl` for `guuey mcp state
 * list|export|wipe`: `--colocated <appId>/<name>` composes
 * `colocatedResourceUrl(appId, name)` directly — a colocated server has no
 * `McpServer` registry row, so no network round-trip is needed or possible.
 * `--server <id>` resolves via the T1 status route (`GET
 * /mcp/servers/:serverId`) to its `runtimeUrl`. Exactly one of the two
 * flags must be given. `label` is the human-readable ref (the raw flag
 * value the caller typed) for prompts/messages — never the resolved URL.
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection (mirrors {@link mcpLogsCore}).
 */
export async function resolveMcpStateServerUrl(
  flags: Record<string, string | true> | undefined,
  opts: { workspaceId: string; auth: AuthTokens; config: ResolvedConfig },
  deps?: { api?: typeof apiRequest },
): Promise<{ ok: true; serverUrl: string; label: string } | { ok: false; error: string }> {
  const serverFlag = flags?.server;
  const colocatedFlag = flags?.colocated;
  const hasServer = typeof serverFlag === 'string' && serverFlag.length > 0;
  const hasColocated = typeof colocatedFlag === 'string' && colocatedFlag.length > 0;

  if (hasServer && hasColocated) {
    return {
      ok: false,
      error: 'Pass either --server <id> or --colocated <appId>/<name>, not both.',
    };
  }

  if (hasColocated) {
    const ref = colocatedFlag as string;
    const slash = ref.indexOf('/');
    if (slash <= 0 || slash === ref.length - 1) {
      return { ok: false, error: `Invalid --colocated "${ref}". Expected <appId>/<name>.` };
    }
    try {
      return {
        ok: true,
        serverUrl: colocatedResourceUrl(ref.slice(0, slash), ref.slice(slash + 1)),
        label: ref,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (hasServer) {
    const ref = serverFlag as string;
    const api = deps?.api ?? apiRequest;
    const res = await api(
      opts.auth.pat,
      opts.config,
      'GET',
      `/mcp/servers/${encodeURIComponent(ref)}?workspaceId=${encodeURIComponent(opts.workspaceId)}`,
    );
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => ({}));
      return { ok: false, error: parseApiError(data, `HTTP ${res.status}`) };
    }
    const data = (await res.json()) as McpServerStatusResponse;
    if (!data.server.runtimeUrl) {
      return {
        ok: false,
        error:
          `Server '${ref}' has no runtime URL yet — it may not be deployed live. ` +
          `Run "guuey mcp status ${ref}" to check.`,
      };
    }
    return { ok: true, serverUrl: data.server.runtimeUrl, label: ref };
  }

  return {
    ok: false,
    error: 'No MCP server specified. Pass --server <id> or --colocated <appId>/<name>.',
  };
}

/**
 * Resolve `--workspace <id>` (or `$GUUEY_WORKSPACE`, or the personal-
 * workspace fallback) ONLY when `--server <id>` is the server-selection
 * flag in play — a `--colocated` ref composes its URL directly and needs
 * no workspace resolution at all. Exits the process (mirroring every other
 * `mcp` command's workspace-resolution failure) when `--server` is given
 * but no workspace resolves.
 */
async function resolveMcpStateWorkspaceIfNeeded(
  flags: Record<string, string | true> | undefined,
  auth: AuthTokens,
  config: ResolvedConfig,
): Promise<string> {
  if (typeof flags?.server !== 'string') return '';
  const workspaceId = await resolveWorkspaceId(flags, process.env, { auth, config });
  if (!workspaceId) {
    out.error(
      'No workspace resolved. Pass --workspace <id>, set GUUEY_WORKSPACE, or check ' +
        'connectivity — the personal-workspace fallback (GET /v1/me/personal-workspace) also failed.',
    );
    process.exit(1);
  }
  return workspaceId;
}

/** Column order for `guuey mcp state list`'s table. */
const MCP_STATE_LIST_COLUMNS = ['USER ID', 'USED BYTES', 'KEY COUNT'];

/** Build one `out.table` row for `guuey mcp state list`. */
export function mcpStateScopeRow(scope: McpStateScopeUsage): Record<string, string> {
  return {
    'USER ID': scope.userId,
    'USED BYTES': String(scope.usedBytes),
    'KEY COUNT': String(scope.keyCount),
  };
}

/**
 * The reusable core of `guuey mcp state list`: POST `/state/admin.list`
 * and render a table of per-user usage — or the raw `scopes` array with
 * `--json`.
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection (mirrors {@link mcpLogsCore}).
 */
export async function mcpStateListCore(
  opts: { serverUrl: string; json: boolean; auth: AuthTokens; config: ResolvedConfig },
  deps?: { api?: typeof apiRequest },
): Promise<void> {
  const api = deps?.api ?? apiRequest;
  const res = await api(opts.auth.pat, opts.config, 'POST', '/state/admin.list', {
    serverUrl: opts.serverUrl,
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }
  const data = (await res.json()) as McpStateAdminListResponse;

  if (opts.json) {
    out.json(data.result.scopes);
    return;
  }

  if (data.result.scopes.length === 0) {
    console.log('  No stored state for this server yet.');
    return;
  }

  out.table(data.result.scopes.map(mcpStateScopeRow), MCP_STATE_LIST_COLUMNS);
}

/**
 * `guuey mcp state list (--server <id> | --colocated <appId>/<name>) [--workspace <id>] [--json]`
 *
 * List per-user stored-state usage for one MCP server as a table — or the
 * raw `scopes` array with `--json`.
 */
export async function mcpStateList(flags?: Record<string, string | true>): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const workspaceId = await resolveMcpStateWorkspaceIfNeeded(flags, auth, config);

  const resolved = await resolveMcpStateServerUrl(flags, { workspaceId, auth, config });
  if (!resolved.ok) {
    out.error(resolved.error);
    process.exit(1);
  }

  try {
    await mcpStateListCore({ serverUrl: resolved.serverUrl, json: flags?.json === true, auth, config });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * The reusable core of `guuey mcp state export`: POST `/state/admin.export`
 * and either print the entries as pretty JSON to stdout (default) or write
 * them to `opts.outFile` (`-o <file>`).
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection (mirrors {@link mcpLogsCore}).
 */
export async function mcpStateExportCore(
  opts: {
    serverUrl: string;
    userId: string;
    /** `-o <file>` target; `undefined` prints to stdout instead. */
    outFile?: string;
    auth: AuthTokens;
    config: ResolvedConfig;
  },
  deps?: { api?: typeof apiRequest },
): Promise<void> {
  const api = deps?.api ?? apiRequest;
  const res = await api(opts.auth.pat, opts.config, 'POST', '/state/admin.export', {
    serverUrl: opts.serverUrl,
    userId: opts.userId,
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }
  const data = (await res.json()) as McpStateAdminExportResponse;
  const pretty = JSON.stringify(data.result.entries, null, 2);

  if (opts.outFile) {
    writeFileSync(opts.outFile, `${pretty}\n`, 'utf-8');
    out.success(`Wrote state export for '${opts.userId}' to ${opts.outFile}`);
    return;
  }

  console.log(pretty);
}

/**
 * `guuey mcp state export (--server <id> | --colocated <appId>/<name>) --user <userId> [-o <file>] [--json]`
 *
 * Export one user's stored KV entries for an MCP server. Prints pretty
 * JSON to stdout by default; `-o <file>` writes it to a file instead.
 * `--json` is accepted for symmetry with `mcp state list` but changes
 * nothing here — the default output is already the raw pretty-printed
 * entries, with no table view to switch away from.
 */
export async function mcpStateExport(flags?: Record<string, string | true>): Promise<void> {
  const userId = flags?.user;
  if (typeof userId !== 'string' || userId.length === 0) {
    out.error(
      'Usage: guuey mcp state export (--server <id> | --colocated <appId>/<name>) --user <userId>',
    );
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();
  const workspaceId = await resolveMcpStateWorkspaceIfNeeded(flags, auth, config);

  const resolved = await resolveMcpStateServerUrl(flags, { workspaceId, auth, config });
  if (!resolved.ok) {
    out.error(resolved.error);
    process.exit(1);
  }

  const outFile = typeof flags?.o === 'string' ? flags.o : undefined;

  try {
    await mcpStateExportCore({ serverUrl: resolved.serverUrl, userId, outFile, auth, config });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Ask `question` on `process.stdin`/`process.stdout` via a one-shot
 * readline interface and return the raw answer. The default
 * `deps.confirm` for {@link mcpStateWipeCore} — mirrors `mcp delete`'s
 * inline readline usage, factored out so tests can inject a fake asker
 * instead of driving real stdin.
 */
async function defaultConfirm(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((res) => rl.question(question, res));
  } finally {
    rl.close();
  }
}

/**
 * The reusable core of `guuey mcp state wipe`: resolves the destructive-
 * confirm gate ({@link resolveMcpDeleteConfirmation}, the SAME contract
 * `mcp delete` uses), asks for confirmation when interactive (via
 * `deps.confirm`), and POSTs `/state/admin.wipe` only once confirmed.
 * Unlike `mcp delete` (which puts the confirm flow in its I/O wrapper,
 * untested), the confirm flow lives HERE — behind injectable `deps.api`
 * and `deps.confirm` — so the whole refuse/prompt/abort/proceed flow is
 * unit-testable without touching real stdin or `requireAuth`/`resolveConfig`.
 *
 * `deps.api` defaults to the real `apiRequest`; `deps.confirm` defaults to
 * {@link defaultConfirm}. Both exist purely for test injection.
 */
export async function mcpStateWipeCore(
  opts: {
    serverUrl: string;
    userId: string;
    /** The raw `--server`/`--colocated` ref, for the confirm prompt. */
    label: string;
    yes: boolean;
    stdinIsTTY: boolean | undefined;
    stdoutIsTTY: boolean | undefined;
    auth: AuthTokens;
    config: ResolvedConfig;
  },
  deps?: { api?: typeof apiRequest; confirm?: (question: string) => Promise<string> },
): Promise<
  | { status: 'refused'; error: string }
  | { status: 'aborted' }
  | { status: 'wiped'; deleted: number }
> {
  const api = deps?.api ?? apiRequest;

  const confirmation = resolveMcpDeleteConfirmation({
    yes: opts.yes,
    stdinIsTTY: opts.stdinIsTTY,
    stdoutIsTTY: opts.stdoutIsTTY,
  });

  if (confirmation === 'refuse') {
    return {
      status: 'refused',
      error: `Refusing to wipe state for '${opts.userId}' without confirmation in a non-interactive session. Pass --yes to confirm.`,
    };
  }

  if (confirmation === 'prompt') {
    const ask = deps?.confirm ?? defaultConfirm;
    const answer = await ask(`  Wipe stored state for '${opts.userId}' on '${opts.label}'? [y/N] `);
    if (!parseYesNoAnswer(answer)) {
      return { status: 'aborted' };
    }
  }

  const res = await api(opts.auth.pat, opts.config, 'POST', '/state/admin.wipe', {
    serverUrl: opts.serverUrl,
    userId: opts.userId,
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }
  const data = (await res.json()) as McpStateAdminWipeResponse;
  return { status: 'wiped', deleted: data.result.deleted };
}

/**
 * `guuey mcp state wipe (--server <id> | --colocated <appId>/<name>) --user <userId> [--yes]`
 *
 * Irreversibly deletes one user's stored KV entries for an MCP server.
 * Destructive — gated by {@link resolveMcpDeleteConfirmation} via
 * {@link mcpStateWipeCore}: an interactive TTY session prompts "Wipe
 * stored state for '<userId>' on '<server>'? [y/N]" unless `--yes` is
 * passed; a non-interactive session without `--yes` refuses outright.
 */
export async function mcpStateWipe(flags?: Record<string, string | true>): Promise<void> {
  const userId = flags?.user;
  if (typeof userId !== 'string' || userId.length === 0) {
    out.error(
      'Usage: guuey mcp state wipe (--server <id> | --colocated <appId>/<name>) --user <userId>',
    );
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();
  const workspaceId = await resolveMcpStateWorkspaceIfNeeded(flags, auth, config);

  const resolved = await resolveMcpStateServerUrl(flags, { workspaceId, auth, config });
  if (!resolved.ok) {
    out.error(resolved.error);
    process.exit(1);
  }

  try {
    const result = await mcpStateWipeCore({
      serverUrl: resolved.serverUrl,
      userId,
      label: resolved.label,
      yes: flags?.yes === true,
      stdinIsTTY: process.stdin.isTTY,
      stdoutIsTTY: process.stdout.isTTY,
      auth,
      config,
    });

    if (result.status === 'refused') {
      out.error(result.error);
      process.exit(1);
    }
    if (result.status === 'aborted') {
      console.log('  Aborted.');
      return;
    }
    out.success(`Wiped ${result.deleted} entries`);
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
