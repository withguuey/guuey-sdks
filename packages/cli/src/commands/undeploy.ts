/**
 * guuey undeploy -- Tear down a deployed agent without deleting the app.
 *
 * Usage:
 *   guuey undeploy              # Undeploy the current app
 *   guuey undeploy --force      # Skip confirmation
 */

import { createInterface } from 'node:readline';
import { resolveConfig } from '../config';
import { requireAuth } from '../auth';
import * as out from '../output';

export async function undeploy(
  flags?: Record<string, string | true>,
): Promise<void> {
  const config = resolveConfig();
  const appId = (flags?.['app-id'] as string) ?? config.appId;

  if (!appId) {
    out.error('No app configured. Run "guuey link" or "guuey create" first.');
    process.exit(1);
  }

  const auth = requireAuth();

  // Confirm unless --force
  if (flags?.force !== true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`  Tear down deployed agent for app ${appId}? [y/N] `, resolve);
    });
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('  Cancelled.');
      return;
    }
  }

  console.log('');
  console.log('  Tearing down deployed agent...');

  if (!config.apiUrl) {
    out.error('REST API URL not configured.');
    process.exit(1);
  }

  const baseUrl = config.apiUrl.replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/apps/${appId}/deploy/undeploy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.pat}`,
    },
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Undeploy failed: HTTP ${res.status}`);
    process.exit(1);
  }

  console.log('');
  out.success('Agent torn down. App is still available for future deploys.');
  console.log('');
}
