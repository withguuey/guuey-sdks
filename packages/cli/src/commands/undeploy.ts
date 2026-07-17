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
    out.error('No app configured. Run "guuey pull --app-id <id>" to bind an existing app, or "guuey create" to scaffold a new project first.');
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

  const body: unknown = await res.json().catch(() => undefined);

  if (!res.ok) {
    if (res.status === 404) {
      // Older backends that predate the undeploy cliApi surface return 404 for
      // this route. Keep an honest fallback so a stale control plane degrades
      // gracefully rather than printing a raw HTTP error.
      out.error(
        'Undeploy is not available on this API yet — use "guuey delete" to archive the app ' +
          '(tears down via the 30-day deletion cascade), or redeploy to replace the running agent.',
      );
    } else {
      out.error(out.apiErrorMessage(body, `Undeploy failed: HTTP ${res.status}`));
    }
    process.exit(1);
  }

  // The backend claimed the deployment (status → 'undeploying'); the
  // deploy-controller deletes the agent's namespace on its next reconcile tick,
  // so teardown completes asynchronously after this call returns.
  const buildNumber =
    body && typeof body === 'object' && 'buildNumber' in body
      ? (body as { buildNumber?: unknown }).buildNumber
      : undefined;

  console.log('');
  out.success(
    typeof buildNumber === 'number'
      ? `Undeploy queued for build #${buildNumber}.`
      : 'Undeploy queued.',
  );
  console.log('  Teardown completes asynchronously; the app stays available for future deploys.');
  console.log('');
}
