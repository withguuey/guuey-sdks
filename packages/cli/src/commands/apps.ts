/**
 * `guuey apps` — App management via the ggui REST API.
 *
 * All operations use PAT auth against the platform REST API.
 */

import { resolveConfig, saveConfig, loadConfig } from '../config';
import { isLoggedIn, requireAuth } from '../auth';
import { login } from './login';
import * as out from '../output';

interface AppSummary {
  id: string;
  name: string;
  hasBYOK: boolean;
  userAuthMode: string;
  createdAt: string;
}

interface AppDetail extends AppSummary {
  defaultShellType?: string;
  stylingPrompt?: string;
  webhookUrl?: string;
  rateLimitPerMinute?: number;
}

function getApiBase(): string {
  const config = resolveConfig();
  const apiUrl = config.apiUrl;
  if (!apiUrl) {
    throw new Error(
      'REST API URL not configured. Ensure amplify_outputs.json is present or set GUUEY_API_URL.',
    );
  }
  return apiUrl.replace(/\/$/, '');
}

async function apiRequest(method: string, path: string, body?: unknown): Promise<Response> {
  const auth = requireAuth();
  return fetch(`${getApiBase()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.pat}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function handleError(res: Response, prefix?: string): Promise<never> {
  let message: string;
  try {
    const data = (await res.json()) as { error?: string };
    message = data.error ?? `HTTP ${res.status}`;
  } catch {
    message = `HTTP ${res.status} ${res.statusText}`;
  }
  out.error(prefix ? `${prefix}: ${message}` : message);
  process.exit(1);
}

/**
 * Handle `guuey apps list`.
 */
export async function appsList(opts: { json?: boolean }): Promise<void> {
  const res = await apiRequest('GET', '/apps');
  if (!res.ok) return handleError(res);

  const data = (await res.json()) as { apps: AppSummary[] };

  if (opts.json) {
    out.json(data.apps);
    return;
  }

  out.table(
    data.apps.map((a) => ({
      ID: a.id,
      Name: a.name,
      Auth: a.userAuthMode,
      BYOK: a.hasBYOK ? 'yes' : 'no',
      Created: a.createdAt?.slice(0, 10) ?? '-',
    })),
  );
}

/**
 * Handle `guuey apps get [appId]`.
 */
export async function appsGet(
  appId: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass --app-id or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  const res = await apiRequest('GET', `/apps/${resolved}`);
  if (!res.ok) return handleError(res);

  const data = (await res.json()) as { app: AppDetail };

  if (opts.json) {
    out.json(data.app);
    return;
  }

  const app = data.app;
  console.log(`App: ${app.name} (${app.id})`);
  console.log(`  Auth Mode:    ${app.userAuthMode}`);
  console.log(`  BYOK:         ${app.hasBYOK ? 'yes' : 'no'}`);
  if (app.webhookUrl) console.log(`  Webhook:      ${app.webhookUrl}`);
  if (app.rateLimitPerMinute)
    console.log(`  Rate Limit:   ${app.rateLimitPerMinute}/min`);
  if (app.stylingPrompt) console.log(`  Styling:      ${app.stylingPrompt}`);
  console.log(`  Created:      ${app.createdAt}`);
}

/**
 * Handle `guuey apps create`.
 */
export async function appsCreate(opts: {
  name?: string;
  authMode?: string;
  json?: boolean;
}): Promise<void> {
  if (!opts.name) {
    out.error('App name is required. Use: guuey apps create --name "My App"');
    process.exit(1);
  }

  // Auto-login if not authenticated
  if (!isLoggedIn()) {
    console.log('Not logged in — opening browser to authenticate...\n');
    await login();
  }

  const res = await apiRequest('POST', '/apps', {
    name: opts.name,
    userAuthMode: opts.authMode ?? 'anonymous',
  });

  if (!res.ok) return handleError(res, 'Failed to create app');

  const data = (await res.json()) as { appId: string; apiKey: string };

  // Always auto-configure the CLI with the new app
  const existing = loadConfig();
  existing.appId = data.appId;
  existing.apiKey = data.apiKey;
  saveConfig(existing);

  if (opts.json) {
    out.json(data);
    return;
  }

  out.success(`Created app "${opts.name}"`);
  console.log('');
  console.log(`  App ID:   ${data.appId}`);
  console.log(`  API Key:  ${data.apiKey}`);
  console.log('');
  console.log('  Save the API key now — it won\'t be shown again.');
  console.log('');
  console.log('  Auto-configured: app-id and api-key saved to ~/.guuey/config.json');
}

/**
 * Handle `guuey apps update [appId]`.
 */
export async function appsUpdate(
  appId: string | undefined,
  opts: {
    name?: string;
    authMode?: string;
    stylingPrompt?: string;
    webhookUrl?: string;
    rateLimit?: string;
    domains?: string;
    json?: boolean;
  },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided.');
    process.exit(1);
  }

  const body: Record<string, unknown> = {};
  if (opts.name) body.name = opts.name;
  if (opts.authMode) body.userAuthMode = opts.authMode;
  if (opts.stylingPrompt) body.stylingPrompt = opts.stylingPrompt;
  if (opts.webhookUrl) body.webhookUrl = opts.webhookUrl;
  if (opts.rateLimit) body.rateLimitPerMinute = parseInt(opts.rateLimit, 10);
  if (opts.domains) body.allowedDomains = opts.domains.split(',').map((d) => d.trim());

  if (Object.keys(body).length === 0) {
    out.error('No fields to update. Use --name, --auth-mode, --styling-prompt, etc.');
    process.exit(1);
  }

  const res = await apiRequest('PUT', `/apps/${resolved}`, body);
  if (!res.ok) return handleError(res);

  if (opts.json) {
    out.json({ success: true });
  } else {
    out.success(`Updated app ${resolved}`);
  }
}

/**
 * Handle `guuey apps delete [appId]`.
 */
export async function appsDelete(
  appId: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  if (!opts.json) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Delete app ${resolved}? This cannot be undone. (y/N) `, resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  const res = await apiRequest('DELETE', `/apps/${resolved}`);
  if (!res.ok) return handleError(res);

  const data = (await res.json()) as {
    deleted: boolean;
    appId: string;
    recoverable: boolean;
    expiresAt: string;
  };

  // Clear local config if this was the active app
  const config = loadConfig();
  if (config.appId === resolved) {
    delete config.appId;
    delete config.apiKey;
    saveConfig(config);
  }

  if (opts.json) {
    out.json(data);
  } else {
    out.success(`Deleted app ${resolved}`);
    if (data.recoverable) {
      console.log(`  Recoverable until ${data.expiresAt.slice(0, 10)}`);
      console.log(`  To recover: guuey apps recover ${resolved}`);
    }
  }
}

/**
 * Handle `guuey apps recover [appId]`.
 */
export async function appsRecover(
  appId: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  if (!appId) {
    out.error('App ID is required. Use: guuey apps recover <appId>');
    process.exit(1);
  }

  const res = await apiRequest('POST', `/apps/${appId}/recover`);
  if (!res.ok) return handleError(res);

  if (opts.json) {
    out.json({ recovered: true, appId });
  } else {
    out.success(`Recovered app ${appId}`);
  }
}
