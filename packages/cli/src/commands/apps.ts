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
  /**
   * The cliApi wire field is `displayName` (see
   * `backend/amplify/functions/cliApi/handlers/apps.ts#AppWire`) — NOT
   * `name`. Reading `.name` here silently rendered an empty column (S5).
   */
  displayName: string;
  hasBYOK: boolean;
  createdAt: string;
}

interface AppDetail extends AppSummary {
  defaultShellType?: string;
  stylingPrompt?: string;
  webhookUrl?: string;
  rateLimitPerMinute?: number;
}

interface AppAccessState {
  guestAccess: boolean | null;
  guestDailyMessageLimit: number | null;
}

interface AppListing {
  name: string;
  status?: string;
  visibility?: string;
}

/**
 * Production portal origin for the printed share link — deliberately a
 * single hardcoded constant, not `resolveConfig().portalUrl`. Sandbox/dev
 * envs serve the same `/agent/<appId>` route at a different origin; the
 * `--help` text calls that out rather than making this command silently
 * env-aware.
 */
const PORTAL_ORIGIN = 'https://app.guuey.com';

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
    // cliApi's envelope is `{ error: { code, message } }` (see
    // backend/amplify/functions/shared/response.ts#httpError); older
    // surfaces used `{ error: string }`. `out.apiErrorMessage` renders
    // both and never yields "[object Object]".
    const body: unknown = await res.json();
    message = out.apiErrorMessage(body, `HTTP ${res.status}`);
  } catch {
    message = `HTTP ${res.status} ${res.statusText}`;
  }
  out.error(prefix ? `${prefix}: ${message}` : message);
  process.exit(1);
}

/**
 * Build one `out.table` row for `guuey apps list` (pure — no I/O), so the
 * Name-column-uses-`displayName` fix (S5) is unit-testable without a
 * `fetch` mock.
 */
export function appsListRow(a: AppSummary): Record<string, string> {
  return {
    ID: a.id,
    Name: a.displayName,
    BYOK: a.hasBYOK ? 'yes' : 'no',
    Created: a.createdAt?.slice(0, 10) ?? '-',
  };
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

  out.table(data.apps.map(appsListRow));
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
  console.log(`App: ${app.displayName} (${app.id})`);
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

  // cliApi POST /v1/apps expects `displayName` and returns `{ app: {...} }`
  // (the app's own PAT already authorizes deploys — no separate per-app API
  // key is minted anywhere in the CLI).
  const res = await apiRequest('POST', '/apps', {
    displayName: opts.name,
  });

  if (!res.ok) return handleError(res, 'Failed to create app');

  const data = (await res.json()) as { app: { id: string; displayName: string } };
  const appId = data.app.id;

  // Auto-configure the CLI with the new app id.
  const existing = loadConfig();
  existing.appId = appId;
  saveConfig(existing);

  if (opts.json) {
    out.json({ appId, displayName: data.app.displayName });
    return;
  }

  out.success(`Created app "${opts.name}"`);
  console.log('');
  console.log(`  App ID:   ${appId}`);
  console.log('');
  console.log('  Auto-configured: app-id saved to ~/.guuey/config.json');
}

/**
 * Handle `guuey apps update [appId]`.
 */
export async function appsUpdate(
  appId: string | undefined,
  opts: {
    name?: string;
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
  if (opts.stylingPrompt) body.stylingPrompt = opts.stylingPrompt;
  if (opts.webhookUrl) body.webhookUrl = opts.webhookUrl;
  if (opts.rateLimit) body.rateLimitPerMinute = parseInt(opts.rateLimit, 10);
  if (opts.domains) body.allowedDomains = opts.domains.split(',').map((d) => d.trim());

  if (Object.keys(body).length === 0) {
    out.error('No fields to update. Use --name, --styling-prompt, etc.');
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
    archived: boolean;
    appId: string;
    scheduledDeleteAt: string;
    teardown?: { buildNumber: number; status: string };
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
    out.success(`Archived app ${resolved}`);
    console.log(`  Hard delete scheduled: ${data.scheduledDeleteAt.slice(0, 10)}`);
    if (data.teardown) {
      console.log(
        `  Tearing down live deployment (build #${data.teardown.buildNumber})`,
      );
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
  out.notYetAvailable(
    "guuey apps recover isn't available yet — archived apps are kept 30 days before hard delete; restore is on the guuey launch roadmap.",
  );
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

/**
 * Handle `guuey apps access [appId]`.
 *
 * Personal-apps-only: `PUT /apps/:id` 404s for workspace-owned apps (see
 * `guuey apps access --help`).
 */
export async function appsAccess(
  appId: string | undefined,
  opts: {
    guests?: string | true;
    guestLimit?: string | true;
    json?: boolean;
  },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  if (opts.guests === undefined && opts.guestLimit === undefined) {
    out.error(
      'No flags provided. Use --guests on|off and/or --guest-limit N|off. See: guuey apps access --help',
    );
    process.exit(1);
  }

  const body: Record<string, unknown> = {};

  if (opts.guests !== undefined) {
    if (opts.guests !== 'on' && opts.guests !== 'off') {
      out.error('Invalid --guests value. Use: on | off');
      process.exit(1);
    }
    body.guestAccess = opts.guests === 'on';
  }

  if (opts.guestLimit !== undefined) {
    if (opts.guestLimit === 'off') {
      body.guestDailyMessageLimit = null;
    } else {
      const raw = typeof opts.guestLimit === 'string' ? opts.guestLimit.trim() : '';
      // Digits-only pre-check: Number() alone would admit '1e2', '0x10', etc.
      const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1) {
        out.error("Invalid --guest-limit value. Use a positive integer, or 'off' to clear.");
        process.exit(1);
      }
      body.guestDailyMessageLimit = n;
    }
  }

  const res = await apiRequest('PUT', `/apps/${resolved}`, body);
  if (!res.ok) return handleError(res);

  const data = (await res.json()) as { app: AppAccessState };

  if (opts.json) {
    out.json(data.app);
    return;
  }

  out.success(`Updated access for app ${resolved}`);
  console.log('');
  console.log(`  Guests:            ${data.app.guestAccess === false ? 'off' : 'on'}`);
  console.log(
    `  Guest daily limit: ${
      data.app.guestDailyMessageLimit == null ? 'unlimited' : data.app.guestDailyMessageLimit
    }`,
  );
}

/**
 * Handle `guuey apps publish [appId]`.
 *
 * Personal-apps-only: `POST /apps/:id/listing` 404s for workspace-owned
 * apps (see `guuey apps publish --help`). Always forces `status:
 * 'published'` and `visibility: 'public'` over whatever metadata flags
 * are passed — those flags only control the listing's display fields.
 */
export async function appsPublish(
  appId: string | undefined,
  opts: {
    name?: string;
    description?: string;
    category?: string;
    iconUrl?: string;
    json?: boolean;
  },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  const body: Record<string, unknown> = {};
  if (opts.name) body.name = opts.name;
  if (opts.description) body.description = opts.description;
  if (opts.category) body.category = opts.category;
  if (opts.iconUrl) body.iconUrl = opts.iconUrl;
  // Publishing always forces these — metadata flags never override them.
  body.status = 'published';
  body.visibility = 'public';

  const res = await apiRequest('POST', `/apps/${resolved}/listing`, body);
  if (!res.ok) return handleError(res, 'Failed to publish app');

  const data = (await res.json()) as { listing: AppListing };
  const shareLink = `${PORTAL_ORIGIN}/agent/${resolved}`;

  if (opts.json) {
    out.json({ shareLink, listing: data.listing });
    return;
  }

  out.success(`Published "${data.listing.name}" — listed in the store`);
  console.log('');
  console.log(`  Share link: ${shareLink}`);
}

/**
 * Handle `guuey apps unpublish [appId]`.
 *
 * Personal-apps-only: `DELETE /apps/:id/listing` 404s for workspace-owned
 * apps (see `guuey apps unpublish --help`). Idempotent — unpublishing an
 * app with no listing (or an already-archived one) still succeeds.
 * Deactivating the listing does not tear down the app itself, so the
 * direct share link keeps working; only store-browse discovery goes away.
 */
export async function appsUnpublish(
  appId: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  const res = await apiRequest('DELETE', `/apps/${resolved}/listing`);
  if (!res.ok) return handleError(res, 'Failed to unpublish app');

  const data = (await res.json()) as { listing: AppListing | null };

  if (opts.json) {
    out.json({ unpublished: true, listing: data.listing });
    return;
  }

  out.success(`App ${resolved} unpublished — the share link still works`);
}
