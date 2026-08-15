/**
 * guuey undeploy -- Tear down a deployed agent without deleting the app.
 *
 * Usage:
 *   guuey undeploy              # Undeploy the current app (prompts [y/N] on a TTY)
 *   guuey undeploy --force      # Skip confirmation — required in non-interactive
 *                               # sessions; declined/refused confirmations exit 1
 */

import { createInterface } from 'node:readline';
import { resolveConfig } from '../config';
import { resolveTargetAppId } from '../app-id';
import { requireAuth } from '../auth';
import * as out from '../output';

/**
 * Destructive-op confirmation gate for `guuey undeploy` (pure — no I/O).
 *
 *   - `--force` always skips the prompt (`'skip'`).
 *   - An interactive session (both stdin AND stdout are TTYs) without
 *     `--force` prompts (`'prompt'`).
 *   - A non-interactive session (script/CI/pipe) without `--force` refuses
 *     outright (`'refuse'`) — there is no channel to confirm on. The old
 *     behavior read EOF as the default N and exited 0, which false-greened
 *     scripted teardowns (guuey#183).
 */
export function resolveUndeployConfirmation(opts: {
  force: boolean;
  stdinIsTTY: boolean | undefined;
  stdoutIsTTY: boolean | undefined;
}): 'skip' | 'prompt' | 'refuse' {
  if (opts.force) return 'skip';
  if (opts.stdinIsTTY === true && opts.stdoutIsTTY === true) return 'prompt';
  return 'refuse';
}

export async function undeploy(
  flags?: Record<string, string | true>,
): Promise<void> {
  const config = resolveConfig();
  const appId = resolveTargetAppId(flags, config);

  if (!appId) {
    out.error('No app configured. Run "guuey pull --app-id <id>" to bind an existing app, or "guuey create" to scaffold a new project first.');
    process.exit(1);
  }

  const auth = requireAuth();

  const confirmation = resolveUndeployConfirmation({
    force: flags?.force === true,
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  });

  if (confirmation === 'refuse') {
    out.error(
      `Refusing to undeploy app ${appId} without confirmation in a non-interactive session. Pass --force to confirm.`,
    );
    process.exit(1);
  }

  if (confirmation === 'prompt') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`  Tear down deployed agent for app ${appId}? [y/N] `, resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      // Non-zero on decline: automation must not read a declined prompt as
      // a completed teardown.
      console.log('  Cancelled.');
      process.exit(1);
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
