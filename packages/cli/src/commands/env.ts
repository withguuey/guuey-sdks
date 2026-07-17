/**
 * guuey env -- Manage environment variables for a deployed agent.
 *
 * Usage:
 *   guuey env set KEY=VALUE [KEY2=VALUE2]   # Set env vars
 *   guuey env list                          # List env vars
 *   guuey env list --json                   # List as JSON
 *   guuey env unset KEY [KEY2]              # Remove env vars
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';

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

/**
 * Handle the `guuey env set` command.
 *
 * Parses KEY=VALUE pairs from positional arguments and sends them
 * to the platform API.
 *
 * @param args - Positional arguments (KEY=VALUE pairs) from the CLI parser
 * @param flags - CLI flags (unused, reserved for future options)
 */
export async function envSet(args: string[], _flags?: Record<string, string | true>): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey pull --app-id <id>" to bind an existing app, or "guuey create" to scaffold a new project first.');
    process.exit(1);
  }

  // Parse KEY=VALUE pairs from positional args
  const pairs: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) continue;
    const eqIdx = arg.indexOf('=');
    if (eqIdx === -1) {
      out.error(`Invalid format: "${arg}". Use KEY=VALUE.`);
      process.exit(1);
    }
    pairs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
  }

  if (Object.keys(pairs).length === 0) {
    out.error('No environment variables provided. Usage: guuey env set KEY=VALUE [KEY2=VALUE2]');
    process.exit(1);
  }

  const res = await apiRequest(auth.pat, config, 'PATCH', `/apps/${appId}/env`, { vars: pairs });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Failed: HTTP ${res.status}`);
    process.exit(1);
  }

  for (const [key] of Object.entries(pairs)) {
    out.success(`Set ${key}`);
  }
}

/**
 * Handle the `guuey env list` command.
 *
 * Fetches all environment variables for the current app and prints
 * them as a table (or JSON with `--json`).
 *
 * @param opts - Output options (`json` for JSON output)
 */
export async function envList(opts: { json?: boolean }): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey pull --app-id <id>" to bind an existing app, or "guuey create" to scaffold a new project first.');
    process.exit(1);
  }

  const res = await apiRequest(auth.pat, config, 'GET', `/apps/${appId}/env`);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Failed: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as { envVars: Record<string, string> };

  if (opts.json) {
    out.json(data.envVars);
    return;
  }

  const entries = Object.entries(data.envVars);
  if (entries.length === 0) {
    console.log('No environment variables set.');
    return;
  }

  out.table(
    entries.map(([key, value]) => ({
      Key: key,
      Value: value.length > 20 ? value.slice(0, 17) + '...' : value,
    })),
  );
}

/**
 * Handle the `guuey env unset` command.
 *
 * Removes the specified environment variable keys from the current app.
 *
 * @param args - Positional arguments (key names) from the CLI parser
 * @param flags - CLI flags (unused, reserved for future options)
 */
export async function envUnset(args: string[], _flags?: Record<string, string | true>): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey pull --app-id <id>" to bind an existing app, or "guuey create" to scaffold a new project first.');
    process.exit(1);
  }

  const keys = args.filter((a) => !a.startsWith('--'));
  if (keys.length === 0) {
    out.error('No keys provided. Usage: guuey env unset KEY [KEY2]');
    process.exit(1);
  }

  const res = await apiRequest(auth.pat, config, 'DELETE', `/apps/${appId}/env`, { keys });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Failed: HTTP ${res.status}`);
    process.exit(1);
  }

  for (const key of keys) {
    out.success(`Removed ${key}`);
  }
}
