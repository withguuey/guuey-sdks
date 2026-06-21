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
import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
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

/** Read the local package.json `name`, or `undefined` if absent/unreadable. */
function readPackageName(cwd: string): string | undefined {
  const pkgJsonPath = join(cwd, 'package.json');
  if (!existsSync(pkgJsonPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { name?: unknown };
    return typeof pkg.name === 'string' ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Handle the `guuey mcp deploy` command.
 *
 * Resolves + validates inputs (workspace, name, size, label), requires a
 * Dockerfile (hosted MCP servers are code-mode), then packs the source,
 * uploads it to S3 via a presigned URL, triggers the build, and polls until
 * the server is live or the deploy fails.
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

  if (!existsSync(join(cwd, 'Dockerfile'))) {
    out.error(
      'guuey mcp deploy requires a Dockerfile in the current directory (hosted MCP servers are code-mode).',
    );
    process.exit(1);
  }

  console.log('');
  console.log('  Deploying hosted MCP server to guuey cloud...');
  console.log('');

  // 1. Pack source into a tarball.
  const buildId = randomUUID().slice(0, 12);
  const { tarballPath, tarballSize, sourceHash } = packSource({ buildId, cwd });

  // 2. Get presigned upload URL + reserve serverId + buildNumber.
  const uploadRes = await apiRequest(auth.pat, config, 'POST', '/mcp/deploy/upload', {
    ...buildUploadBody({ workspaceId, name, size, contentLength: tarballSize, sourceHash }),
  });

  if (!uploadRes.ok) {
    const data = (await uploadRes.json().catch(() => ({}))) as { error?: string };
    out.error(data.error ?? `Upload failed: HTTP ${uploadRes.status}`);
    cleanup(tarballPath);
    process.exit(1);
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
    out.error(`S3 upload failed: HTTP ${uploadToS3.status}`);
    cleanup(tarballPath);
    process.exit(1);
  }

  // 4. Trigger the build + deploy.
  console.log('  Building & deploying...');
  const triggerRes = await apiRequest(auth.pat, config, 'POST', '/mcp/deploy/trigger', {
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
    if (triggerRes.status === 429) {
      // Quota hit — show the reason + a Retry-After hint if we got one.
      const secs = Number(
        data.retryAfterSeconds ?? triggerRes.headers.get('Retry-After') ?? 0,
      );
      const when = secs > 0 ? ` Retry in ~${Math.ceil(secs / 60)} minute(s).` : '';
      out.error(`${data.error ?? 'Build quota exceeded.'}${when}`);
    } else {
      // Includes 409 (concurrent build number) — surface its message + exit 1.
      out.error(data.error ?? `Deploy trigger failed: HTTP ${triggerRes.status}`);
    }
    cleanup(tarballPath);
    process.exit(1);
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
      out.error('Deploy timed out after 22 minutes.');
      cleanup(tarballPath);
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, 3000));

    const statusRes = await apiRequest(
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
      out.error(data.errorMessage);
      cleanup(tarballPath);
      process.exit(1);
    }
  }

  // 6. Done.
  cleanup(tarballPath);

  if (status === 'superseded') {
    console.log('');
    out.error('Deployment superseded by a newer deploy. Run "guuey mcp deploy" again if needed.');
    process.exit(1);
  }

  if (status === 'failed') {
    console.log('');
    out.error('Deployment failed.');
    process.exit(1);
  }

  console.log('');
  out.success(`Hosted MCP live at ${runtimeUrl}`);
  console.log('');
  console.log(`  Server: ${name}`);
  console.log(`  Build:  #${buildNumber}${label ? ` (${label})` : ''}`);
  console.log(`  Size:   ${size}`);
  console.log('  Scales to zero when idle.');
  console.log('');
}
