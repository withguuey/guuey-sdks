/**
 * guuey deployments -- List and manage agent deployments.
 *
 * Subcommands:
 *   list                           List all deployments for the current app
 *   rollback [version]             Rollback to a specific version (or previous)
 *   logs <buildNumber>             Show build logs for a specific deployment
 *
 * Usage:
 *   guuey deployments                # List all deployments (default)
 *   guuey deployments list           # Same as above
 *   guuey deployments rollback       # Rollback to previous version
 *   guuey deployments rollback 3     # Rollback to version 3
 *   guuey deployments logs 5         # Show build logs for build #5
 *
 * NOT YET AVAILABLE (rollback + logs only): the `/v1/apps/:id/deploy/rollback`
 * and `/v1/apps/:id/deploy/build-logs/:n` cliApi routes are deferred (see
 * cliApi handler.ts "Deferred to follow-up slices"). Those two subcommands
 * fail fast with a roadmap notice and are de-advertised from `guuey --help`;
 * `deployments list` is live. The full implementations are kept intact and
 * re-activate by removing the `notYetAvailable` gates when the routes ship.
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';

/**
 * Handle the `guuey deployments list` command.
 *
 * Fetches all deployments for the current app from the CLI API
 * and prints them as a table (or JSON with `--json`).
 *
 * @param opts - Output options (e.g., `{ json: true }`)
 */
export async function deploymentsList(opts: { json?: boolean }): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = config.appId;

  if (!appId) {
    out.error('No app ID found.');
    process.exit(1);
  }

  const res = await apiRequest(auth.pat, config, 'GET', `/apps/${appId}/deployments`);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Failed: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as {
    deployments: Array<{
      buildNumber: number;
      status: string;
      size: string;
      createdAt: string;
      deployedBy: string;
    }>;
  };

  if (opts.json) {
    out.json(data.deployments);
    return;
  }

  if (data.deployments.length === 0) {
    console.log('No deployments yet. Run "guuey deploy" to deploy your agent.');
    return;
  }

  out.table(
    data.deployments.map((d) => ({
      Build: d.buildNumber,
      Status: d.status,
      Size: d.size,
      'Deployed At': d.createdAt ? new Date(d.createdAt).toLocaleString() : '-',
    })),
  );
}

/**
 * Handle the `guuey deployments rollback` command.
 *
 * Triggers a rollback to a specific deployment version (or the
 * previous version if no version is specified).
 *
 * @param versionArg - Target version number (optional)
 * @param flags - CLI flags
 */
export async function deploymentsRollback(
  versionArg?: string,
  _flags?: Record<string, string | true>,
): Promise<void> {
  out.notYetAvailable(
    "guuey deployments rollback isn't available yet — deploy rollback is on the guuey launch roadmap.",
  );
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = config.appId;

  if (!appId) {
    out.error('No app ID found.');
    process.exit(1);
  }

  const buildNumber = versionArg ? parseInt(versionArg, 10) : undefined;

  const res = await apiRequest(auth.pat, config, 'POST', `/apps/${appId}/deploy/rollback`, {
    buildNumber,
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Rollback failed: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as { buildNumber: number; status: string };
  out.success(`Rolled back to build #${data.buildNumber}`);
}

/**
 * Handle the `guuey deployments logs <buildNumber>` command.
 *
 * Fetches Kaniko build logs for a specific deployment from the CLI API.
 */
export async function deploymentsLogs(
  buildNumberArg: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  out.notYetAvailable(
    "guuey deployments logs isn't available yet — build-log retrieval is on the guuey launch roadmap.",
  );
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = config.appId;

  if (!appId) {
    out.error('No app ID found.');
    process.exit(1);
  }

  if (!buildNumberArg) {
    out.error('Usage: guuey deployments logs <buildNumber>');
    process.exit(1);
  }

  const buildNumber = parseInt(buildNumberArg, 10);
  if (isNaN(buildNumber)) {
    out.error(`Invalid build number: ${buildNumberArg}`);
    process.exit(1);
  }

  console.log(`Fetching build logs for #${buildNumber}...`);
  console.log('');

  const res = await apiRequest(
    auth.pat,
    config,
    'GET',
    `/apps/${appId}/deploy/build-logs/${buildNumber}`,
  );

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Failed: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as {
    jobName: string | null;
    status: string;
    source?: 'archive' | 'live';
    retentionDays?: number;
    logs: Array<{ timestamp: string; message: string }>;
  };

  if (opts.json) {
    out.json(data);
    return;
  }

  const statusColor =
    data.status === 'succeeded'
      ? '\x1b[32m'
      : data.status === 'failed'
        ? '\x1b[31m'
        : data.status === 'running'
          ? '\x1b[33m'
          : '\x1b[90m';
  const reset = '\x1b[0m';

  console.log(`Build #${buildNumber}: ${statusColor}${data.status}${reset}`);
  if (data.jobName) console.log(`Job: ${data.jobName}`);
  if (data.source === 'archive' && data.retentionDays) {
    console.log(`Source: archived (retained ${data.retentionDays} days)`);
  } else if (data.source === 'live') {
    console.log('Source: live (not yet archived)');
  }
  console.log('');

  if (data.logs.length === 0) {
    console.log(
      data.status === 'not-found'
        ? 'Build logs no longer available — archive expired (30-day retention).'
        : 'No logs yet.',
    );
    return;
  }

  for (const entry of data.logs) {
    const time = new Date(entry.timestamp).toISOString().slice(11, 23);
    console.log(`${time}  ${entry.message}`);
  }
}

/** Make an authenticated JSON request to the CLI API. */
async function apiRequest(
  pat: string,
  config: { apiUrl?: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  if (!config.apiUrl) {
    throw new Error('REST API URL not configured. Ensure amplify_outputs.json is present or set GUUEY_API_URL.');
  }
  const baseUrl = config.apiUrl.replace(/\/$/, '');
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pat}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
