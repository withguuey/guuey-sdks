/**
 * `guuey byok` — Manage BYOK (Bring Your Own Key) provider API keys.
 *
 * Subcommands:
 *   set    --provider <name> --key <value>   Store a provider API key
 *   list                                      List configured provider keys
 *   remove --provider <name>                  Remove a provider key
 *
 * NOT YET AVAILABLE: the `/v1/apps/:id/keys/*` cliApi routes are deferred
 * (B6 — see cliApi handler.ts "Deferred to follow-up slices"). Every
 * subcommand fails fast with a roadmap notice and is de-advertised from
 * `guuey --help`. The full implementation below is kept intact and
 * re-activates by removing the `notYetAvailable` gates when the routes ship.
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';

const VALID_PROVIDERS = ['anthropic', 'openai', 'google', 'bedrock', 'openrouter'] as const;

interface KeyInfo {
  provider: string;
  keyPrefix: string;
  status: string;
  createdAt: string;
}

async function apiRequest(
  method: string,
  appId: string,
  body?: unknown,
): Promise<Response> {
  const auth = requireAuth();
  const config = resolveConfig();

  // Use Lambda-backed REST API endpoint (from amplify_outputs.json)
  const apiUrl = config.apiUrl;
  if (!apiUrl) {
    throw new Error(
      'REST API URL not configured. Ensure amplify_outputs.json is present or set GUUEY_API_URL.',
    );
  }
  const baseUrl = apiUrl.replace(/\/$/, '');

  return fetch(`${baseUrl}/apps/${appId}/keys`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.pat}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function handleError(res: Response): Promise<never> {
  let message: string;
  try {
    const data = (await res.json()) as { error?: string };
    message = data.error ?? `HTTP ${res.status}`;
  } catch {
    message = `HTTP ${res.status} ${res.statusText}`;
  }
  out.error(message);
  process.exit(1);
}

/**
 * `guuey byok set --provider <name> --key <value>`
 */
export async function byokSet(flags: Record<string, string | true>): Promise<void> {
  out.notYetAvailable(
    "guuey byok set isn't available yet — bring-your-own-key provider keys are on the guuey launch roadmap.",
  );
  const provider = flags.provider as string | undefined;
  const apiKey = flags.key as string | undefined;
  const appId = (flags['app-id'] as string) ?? resolveConfig().appId;

  if (!provider) {
    out.error('Missing --provider. Use: guuey byok set --provider anthropic --key <key>');
    process.exit(1);
  }
  if (!apiKey || typeof apiKey !== 'string') {
    out.error('Missing --key. Use: guuey byok set --provider anthropic --key <key>');
    process.exit(1);
  }
  if (!appId) {
    out.error('No app ID. Run: guuey config set app-id <id>');
    process.exit(1);
  }
  if (!VALID_PROVIDERS.includes(provider as (typeof VALID_PROVIDERS)[number])) {
    out.error(`Invalid provider "${provider}". Must be one of: ${VALID_PROVIDERS.join(', ')}`);
    process.exit(1);
  }

  const res = await apiRequest('POST', appId, { provider, apiKey });
  if (!res.ok) return handleError(res);

  const data = (await res.json()) as { keyPrefix: string };
  out.success(`Stored ${provider} key (${data.keyPrefix})`);
}

/**
 * `guuey byok list`
 */
export async function byokList(flags: Record<string, string | true>): Promise<void> {
  out.notYetAvailable(
    "guuey byok list isn't available yet — bring-your-own-key provider keys are on the guuey launch roadmap.",
  );
  const appId = (flags['app-id'] as string) ?? resolveConfig().appId;
  const jsonFlag = flags.json === true;

  if (!appId) {
    out.error('No app ID. Run: guuey config set app-id <id>');
    process.exit(1);
  }

  const res = await apiRequest('GET', appId);
  if (!res.ok) return handleError(res);

  const data = (await res.json()) as { keys: KeyInfo[] };

  if (jsonFlag) {
    out.json(data.keys);
    return;
  }

  if (data.keys.length === 0) {
    console.log('No provider keys configured.');
    console.log('');
    console.log('  Add one: guuey byok set --provider anthropic --key <key>');
    return;
  }

  out.table(
    data.keys.map((k) => ({
      Provider: k.provider,
      Key: k.keyPrefix,
      Status: k.status,
      Added: k.createdAt?.slice(0, 10) ?? '-',
    })),
  );
}

/**
 * `guuey byok remove --provider <name>`
 */
export async function byokRemove(flags: Record<string, string | true>): Promise<void> {
  out.notYetAvailable(
    "guuey byok remove isn't available yet — bring-your-own-key provider keys are on the guuey launch roadmap.",
  );
  const provider = flags.provider as string | undefined;
  const appId = (flags['app-id'] as string) ?? resolveConfig().appId;

  if (!provider) {
    out.error('Missing --provider. Use: guuey byok remove --provider anthropic');
    process.exit(1);
  }
  if (!appId) {
    out.error('No app ID. Run: guuey config set app-id <id>');
    process.exit(1);
  }

  const res = await apiRequest('DELETE', appId, { provider });
  if (!res.ok) return handleError(res);

  out.success(`Removed ${provider} key`);
}
