/**
 * guuey stop / start / restart — Agent lifecycle management.
 *
 * Usage:
 *   guuey stop                # Pause deployed agent (scale to 0)
 *   guuey start               # Resume stopped agent
 *   guuey restart              # Rolling restart of agent pods
 */

import { resolveConfig } from '../config';
import { requireAuth } from '../auth';
import * as out from '../output';

async function lifecycleRequest(
  action: 'stop' | 'start' | 'restart',
  flags?: Record<string, string | true>,
): Promise<void> {
  const config = resolveConfig();
  const appId = (flags?.['app-id'] as string) ?? config.appId;

  if (!appId) {
    out.error('No app configured. Run "guuey link" or "guuey create" first.');
    process.exit(1);
  }

  const auth = requireAuth();

  if (!config.apiUrl) {
    out.error('REST API URL not configured.');
    process.exit(1);
  }

  const labels: Record<string, string> = {
    stop: 'Stopping agent...',
    start: 'Starting agent...',
    restart: 'Restarting agent...',
  };

  const successMessages: Record<string, string> = {
    stop: 'Agent stopped. Run "guuey start" to resume.',
    start: 'Agent started.',
    restart: 'Agent restarted.',
  };

  console.log('');
  console.log(`  ${labels[action]}`);

  const baseUrl = config.apiUrl.replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/apps/${appId}/deploy/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.pat}`,
    },
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `${action} failed: HTTP ${res.status}`);
    process.exit(1);
  }

  console.log('');
  out.success(successMessages[action]);
  console.log('');
}

export const stop = (flags?: Record<string, string | true>) => lifecycleRequest('stop', flags);
export const start = (flags?: Record<string, string | true>) => lifecycleRequest('start', flags);
export const restart = (flags?: Record<string, string | true>) => lifecycleRequest('restart', flags);
