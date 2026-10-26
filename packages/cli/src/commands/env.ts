/**
 * guuey env -- Manage environment variables for a deployed agent.
 *
 * Usage:
 *   guuey env set KEY=VALUE [KEY2=VALUE2]   # Set env vars
 *   guuey env list                          # List env vars
 *   guuey env list --json                   # List as JSON
 *   guuey env unset KEY [KEY2]              # Remove env vars
 *
 * A provider key name (`ANTHROPIC_API_KEY`, …: `@guuey/config`'s one BYOK
 * list) is refused before the network (guuey#2412): a plain variable of that
 * name never switches the app to the builder's key, so `env set` would look
 * like it worked when it did not. The refusal points at `guuey byok set`, the
 * door that does. Every server error prints through `out.apiErrorMessage`.
 */

import {
  BYOK_PROVIDER_IDS,
  BYOK_PROVIDER_SLOT_ENV,
  type ByokProviderId,
  isRuntimeReservedEnvName,
} from '@guuey/config';
import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import { resolveTargetAppId } from '../app-id';
import * as out from '../output';
import { cliApiAuthHeaders } from '../cli-api-headers';

/**
 * The code cliApi's env door answers for a provider key name (guuey#2412), mirrored from
 * `@guuey-private/cli-wire` `env.ts` (pinned by `wire-sync.test.ts`).
 */
export const PROVIDER_KEY_ENV_NAME = 'PROVIDER_KEY_ENV_NAME';

/** The BYOK provider whose key is delivered in env var `name`, or `undefined` for any other name. */
function providerForSlotEnvName(name: string): ByokProviderId | undefined {
  return BYOK_PROVIDER_IDS.find((provider) => BYOK_PROVIDER_SLOT_ENV[provider] === name);
}

/** The pointer at the provider-key door, for `provider` (or a placeholder when this CLI does not know it). */
function byokSetPointer(provider: ByokProviderId | undefined, appId: string): string {
  return `Use: guuey byok set --provider ${provider ?? '<provider>'} --app-id ${appId}`;
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
      ...cliApiAuthHeaders(pat),
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
 * @param flags - CLI flags (`--app-id` targets a specific app)
 */
export async function envSet(args: string[], flags?: Record<string, string | true>): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = resolveTargetAppId(flags, config);

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

  // The runtime-reserved names (`@guuey/config`, the one list `guuey deploy`
  // and the host apply). The API refuses them either way; this only saves the
  // round trip.
  const reserved = Object.keys(pairs).filter(isRuntimeReservedEnvName);
  if (reserved.length > 0) {
    for (const key of reserved) {
      out.error(`"${key}" is reserved by the platform and cannot be set`);
    }
    process.exit(1);
  }

  // The provider key names (`@guuey/config`'s one BYOK list). The API refuses
  // them too, with the same door-neutral line; this door adds its pointer.
  const providerKeyNames = Object.keys(pairs).filter((key) => providerForSlotEnvName(key) !== undefined);
  if (providerKeyNames.length > 0) {
    for (const key of providerKeyNames) {
      const provider = providerForSlotEnvName(key);
      out.error(
        `"${key}" is a provider key name. A plain variable doesn't switch the app to your key. ` +
          `Set it as the app's ${provider} provider key instead.`,
      );
      console.error(byokSetPointer(provider, appId));
    }
    process.exit(1);
  }

  const res = await apiRequest(auth.pat, config, 'PATCH', `/apps/${appId}/env`, { vars: pairs });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => undefined);
    out.error(out.appApiErrorMessage(res.status, body, appId, 'set env vars on', `Failed: HTTP ${res.status}`));
    if (out.apiErrorCode(body) === PROVIDER_KEY_ENV_NAME) {
      // A name the server holds as a provider key slot and this CLI does not (every one it knows was
      // refused above, before the call), so the provider is the server message's to name.
      console.error(byokSetPointer(undefined, appId));
    }
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
 * @param flags - CLI flags (`--app-id` targets a specific app)
 */
export async function envList(
  opts: { json?: boolean },
  flags?: Record<string, string | true>,
): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = resolveTargetAppId(flags, config);

  if (!appId) {
    out.error('No app ID found. Run "guuey pull --app-id <id>" to bind an existing app, or "guuey create" to scaffold a new project first.');
    process.exit(1);
  }

  const res = await apiRequest(auth.pat, config, 'GET', `/apps/${appId}/env`);
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => undefined);
    out.error(out.appApiErrorMessage(res.status, body, appId, 'read env vars from', `Failed: HTTP ${res.status}`));
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
 * @param flags - CLI flags (`--app-id` targets a specific app)
 */
export async function envUnset(args: string[], flags?: Record<string, string | true>): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = resolveTargetAppId(flags, config);

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
    const body: unknown = await res.json().catch(() => undefined);
    out.error(out.appApiErrorMessage(res.status, body, appId, 'unset env vars on', `Failed: HTTP ${res.status}`));
    process.exit(1);
  }

  for (const key of keys) {
    out.success(`Removed ${key}`);
  }
}
