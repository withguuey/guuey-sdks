/**
 * guuey agent -- Agent hosting management commands.
 *
 * Subcommands:
 *   config                     Show current agent hosting config
 *   config --size <size>       Update container size (xs/sm/md/lg/xl)
 *   config --timeout <min>     Update idle timeout in minutes
 *   config --max-pods <n>      Update max pod replicas
 *
 * Usage:
 *   guuey agent config                           # Show current config
 *   guuey agent config --size md                  # Change to medium container
 *   guuey agent config --timeout 30 --max-pods 3  # Update scaling config
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';

const VALID_SIZES = ['xs', 'sm', 'md', 'lg', 'xl'];

const SIZE_LABELS: Record<string, string> = {
  xs: 'XS (256MB / 0.25 vCPU)',
  sm: 'SM (512MB / 0.5 vCPU)',
  md: 'MD (1GB / 1 vCPU)',
  lg: 'LG (2GB / 2 vCPU)',
  xl: 'XL (4GB / 4 vCPU)',
};

/**
 * Handle the `guuey agent config` command.
 *
 * With no update flags: shows current config from latest deployment.
 * With flags: updates config via PATCH /apps/:appId/config.
 */
export async function agentConfig(
  flags: Record<string, string | true>,
): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey link" or "guuey create" first.');
    process.exit(1);
  }

  if (!config.apiUrl) {
    out.error('REST API URL not configured. Ensure amplify_outputs.json is present or set GUUEY_API_URL.');
    process.exit(1);
  }

  const baseUrl = config.apiUrl.replace(/\/$/, '');
  const hasUpdates =
    flags.size !== undefined ||
    flags.timeout !== undefined ||
    flags['max-pods'] !== undefined;

  if (!hasUpdates) {
    // Show current config from latest deployment
    await showConfig(baseUrl, appId, auth.pat, flags.json === true);
    return;
  }

  // Build update payload
  const body: Record<string, unknown> = {};

  if (flags.size) {
    const size = flags.size as string;
    if (!VALID_SIZES.includes(size)) {
      out.error(
        `Invalid size: ${size}. Must be one of: ${VALID_SIZES.join(', ')}`,
      );
      process.exit(1);
    }
    body.size = size;
  }

  if (flags.timeout) {
    const timeout = Number(flags.timeout);
    if (isNaN(timeout) || timeout < 1 || timeout > 1440) {
      out.error('--timeout must be between 1 and 1440 minutes');
      process.exit(1);
    }
    body.idleTimeoutMinutes = timeout;
  }

  if (flags['max-pods']) {
    const maxPods = Number(flags['max-pods']);
    if (isNaN(maxPods) || maxPods < 1 || maxPods > 10) {
      out.error('--max-pods must be between 1 and 10');
      process.exit(1);
    }
    body.maxPods = maxPods;
  }

  const res = await fetch(`${baseUrl}/apps/${appId}/config`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.pat}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<
      string,
      string
    >;
    out.error(data.error ?? `Config update failed: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as { updated: string[] };
  out.success(`Updated: ${data.updated.join(', ')}`);
  console.log('Controller will reconcile with new config.');
}

async function showConfig(
  baseUrl: string,
  appId: string,
  pat: string,
  json: boolean,
): Promise<void> {
  // Fetch deployments to find the currently live config
  const res = await fetch(`${baseUrl}/apps/${appId}/deployments`, {
    headers: { Authorization: `Bearer ${pat}` },
  });

  if (!res.ok) {
    out.error('Failed to fetch deployment config');
    process.exit(1);
  }

  const data = (await res.json()) as {
    deployments: Array<{
      buildNumber: number;
      status: string;
      size: string;
      idleTimeoutMinutes?: number;
      maxPods?: number;
    }>;
  };

  if (data.deployments.length === 0) {
    console.log('No deployments yet. Run "guuey deploy" first.');
    return;
  }

  // Use the live deployment's config, not just the newest record.
  // If no deployment is live, fall back to the most recent one.
  const latest =
    data.deployments.find((d) => d.status === 'live') ?? data.deployments[0];

  if (json) {
    out.json({
      size: latest.size,
      sizeLabel: SIZE_LABELS[latest.size] ?? latest.size,
      idleTimeoutMinutes: latest.idleTimeoutMinutes ?? 10,
      maxPods: latest.maxPods ?? 1,
      buildNumber: latest.buildNumber,
      status: latest.status,
    });
    return;
  }

  console.log('Agent Hosting Configuration');
  console.log('');
  console.log(`  Size:            ${SIZE_LABELS[latest.size] ?? latest.size}`);
  console.log(`  Idle Timeout:    ${latest.idleTimeoutMinutes ?? 10} minutes`);
  console.log(`  Max Pods:        ${latest.maxPods ?? 1}`);
  console.log(`  Current Build:   #${latest.buildNumber} (${latest.status})`);
}
