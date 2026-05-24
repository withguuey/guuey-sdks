/**
 * guuey delete -- Delete a Guuey app from the platform.
 *
 * Usage:
 *   guuey delete app_abc123         # Delete by app ID
 *   guuey delete                    # Delete the app configured in guuey.yml or ~/.guuey/config.json
 *   guuey delete app_abc123 --force # Skip confirmation prompt
 */

import { createInterface } from 'node:readline';
import { resolveConfig, loadConfig, saveConfig } from '../config';
import { isLoggedIn, requireAuth } from '../auth';
import { login } from './login';
import * as out from '../output';

/**
 * Handle the `guuey delete [appId]` command.
 *
 * Deletes a Guuey app from the platform after interactive confirmation.
 * Falls back to the configured app ID if no argument is provided.
 * Clears local config if the deleted app was the currently configured one.
 *
 * @param appIdArg - Optional app ID from the positional argument
 * @param flags - CLI flags (e.g., `{ force: true }`)
 */
export async function deleteApp(
  appIdArg?: string,
  flags?: Record<string, string | true>,
): Promise<void> {
  const config = resolveConfig();
  const appId = appIdArg ?? config.appId;

  if (!appId) {
    out.error(
      'No app ID provided. Pass it as argument or configure via guuey.yml / guuey config set app-id <id>',
    );
    process.exit(1);
  }

  // Confirm unless --force
  if (flags?.force !== true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) =>
      rl.question(`Delete app ${appId}? This cannot be undone. (y/N): `, resolve),
    );
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  // Auto-login if not authenticated
  if (!isLoggedIn()) {
    console.log('Not logged in — opening browser to authenticate...\n');
    await login();
  }
  const auth = requireAuth();
  const baseUrl = config.host!.replace(/\/$/, '');

  const res = await fetch(`${baseUrl}/api/cli/apps/${appId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${auth.pat}`,
    },
  });

  if (!res.ok) {
    let message: string;
    try {
      const data = (await res.json()) as { error?: string };
      message = data.error ?? `HTTP ${res.status}`;
    } catch {
      message = `HTTP ${res.status} ${res.statusText}`;
    }
    out.error(`Failed to delete app: ${message}`);
    process.exit(1);
  }

  // Clear local config if this was the active app
  const localConfig = loadConfig();
  if (localConfig.appId === appId) {
    delete localConfig.appId;
    delete localConfig.apiKey;
    saveConfig(localConfig);
  }

  out.success(`Deleted app ${appId}`);
}
