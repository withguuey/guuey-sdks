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

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireAuth, type AuthTokens } from '../auth';
import { resolveConfig, type ResolvedConfig } from '../config';
import { apiRequest, cleanup, packSource } from '../deploy-shared';
import * as out from '../output';

/** Valid hosted-MCP pod sizes (matches the backend `validateSize`). */
export const MCP_SIZES = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
export type McpSize = (typeof MCP_SIZES)[number];

/** Git-tag-style version label rule, shared with `guuey deploy`. */
const LABEL_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// ─── Pure helpers (unit-tested without I/O) ─────────────────────────────

/**
 * Resolve the owning workspace id: `--workspace` flag wins, then the
 * `GUUEY_WORKSPACE` env var. Returns `null` when neither yields a value
 * (the caller prints the error + exits).
 */
export function resolveWorkspaceId(
  flags: Record<string, string | true> | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  const flag = flags?.workspace;
  if (typeof flag === 'string' && flag.length > 0) return flag;
  const fromEnv = env.GUUEY_WORKSPACE;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return null;
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
    /** Runtime pod size. Defaults to `'xs'`. */
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
  const size = opts.size ?? 'xs';

  if (!existsSync(join(dir, 'Dockerfile'))) {
    throw new Error(
      'guuey mcp deploy requires a Dockerfile in the current directory (hosted MCP servers are code-mode).',
    );
  }

  console.log('');
  console.log('  Deploying hosted MCP server to guuey cloud...');
  console.log('');

  // 1. Pack source into a tarball.
  const buildId = randomUUID().slice(0, 12);
  const { tarballPath, tarballSize, sourceHash } = packSource({ buildId, cwd: dir });

  // 2. Get presigned upload URL + reserve serverId + buildNumber.
  const uploadRes = await api(auth.pat, config, 'POST', '/mcp/deploy/upload', {
    ...buildUploadBody({ workspaceId, name, size, contentLength: tarballSize, sourceHash }),
  });

  if (!uploadRes.ok) {
    const data = (await uploadRes.json().catch(() => ({}))) as { error?: string };
    cleanup(tarballPath);
    throw new Error(data.error ?? `Upload failed: HTTP ${uploadRes.status}`);
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
    const data = (await triggerRes.json().catch(() => ({}))) as {
      error?: string;
      retryAfterSeconds?: number;
    };
    cleanup(tarballPath);
    if (triggerRes.status === 429) {
      // Quota hit — surface the reason + a Retry-After hint if we got one.
      const secs = Number(
        data.retryAfterSeconds ?? triggerRes.headers.get('Retry-After') ?? 0,
      );
      const when = secs > 0 ? ` Retry in ~${Math.ceil(secs / 60)} minute(s).` : '';
      throw new Error(`${data.error ?? 'Build quota exceeded.'}${when}`);
    }
    // Includes 409 (concurrent build number) — surface its message.
    throw new Error(data.error ?? `Deploy trigger failed: HTTP ${triggerRes.status}`);
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
  const workspaceId = resolveWorkspaceId(flags, process.env);
  if (!workspaceId) {
    out.error(
      'No workspace specified. Pass --workspace <id> or set the GUUEY_WORKSPACE environment variable.',
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
  const auth = requireAuth();
  const config = resolveConfig();

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

/**
 * The cliApi error body shape: `{ error: { code, message } }`. The handlers
 * here may also surface a bare-string `error` on some paths, so the extractor
 * tolerates both without erasing types.
 */
interface CliApiErrorBody {
  error?: { code?: string; message?: string } | string;
}

/** Read an authenticated-error response into a human message + exit 1. */
async function failFromResponse(res: Response): Promise<never> {
  const data = (await res.json().catch(() => ({}))) as CliApiErrorBody;
  let message: string;
  if (typeof data.error === 'string') {
    message = data.error;
  } else if (data.error?.message) {
    message = data.error.message;
  } else {
    message = `HTTP ${res.status}`;
  }
  out.error(message);
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
