/**
 * `guuey app` — per-(app, end-user) admin actions that don't fit under the
 * bulk-app-management `guuey apps` group.
 *
 * `guuey app byo-user erase --app <appId> --sub <sub> [--status]` — a thin
 * wrapper over cliApi's builder byo-user erase routes (erasecomp Task 3,
 * `backend/amplify/functions/cliApi/handlers/byo-users.ts`):
 *
 *   POST /v1/apps/{appId}/byo-users/erase                (default)
 *   GET  /v1/apps/{appId}/byo-users/erase-status?sub=…   (--status)
 *
 * Lets a builder honor a BYO-auth end-user's GDPR erasure request without
 * deleting the builder's whole Guuey app — see the handler's module doc for
 * the full authz ladder + cross-tenant boundary. This module mirrors
 * `apps.ts`'s local `apiRequest`/`handleError` idiom exactly (PAT bearer
 * auth via `requireAuth()`, base URL via `resolveConfig().apiUrl`, the same
 * `{ error: { code, message} }` envelope rendering) — same fetch shape, same
 * error-exit convention, same `apps.test.ts`-style fetch-spy tests.
 */

import { resolveConfig } from '../config';
import { requireAuth } from '../auth';
import * as out from '../output';

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
    // backend/amplify/functions/shared/response.ts#httpError).
    const body: unknown = await res.json();
    message = out.apiErrorMessage(body, `HTTP ${res.status}`);
  } catch {
    message = `HTTP ${res.status} ${res.statusText}`;
  }
  out.error(prefix ? `${prefix}: ${message}` : message);
  process.exit(1);
}

/** `POST /v1/apps/:id/byo-users/erase` response (202). */
interface ByoUserEraseResponse {
  wipeId: string;
  status: 'queued';
}

/** `GET /v1/apps/:id/byo-users/erase-status` response. */
interface ByoUserEraseStatusResponse {
  wipeId: string;
  status: 'queued' | 'done' | 'none';
  requestedAt?: string;
  attempts?: number;
  stuck?: boolean;
}

/**
 * Handle `guuey app byo-user erase --app <appId> --sub <sub>` and its
 * `--status` variant (same command; `--status` switches the request to a
 * GET against `erase-status` instead of POSTing `erase`).
 */
export async function appByoUserErase(opts: {
  app?: string;
  sub?: string;
  status?: string | true;
  json?: boolean;
}): Promise<void> {
  const appId = opts.app ?? resolveConfig().appId;
  if (!appId) {
    out.error('No app ID provided. Use --app <appId>, or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  const sub = opts.sub;
  if (!sub) {
    out.error(
      'Usage: guuey app byo-user erase --app <appId> --sub <sub> [--status]',
    );
    process.exit(1);
  }

  if (opts.status !== undefined) {
    return appByoUserEraseStatus(appId, sub, opts);
  }

  const res = await apiRequest('POST', `/apps/${appId}/byo-users/erase`, { sub });
  if (!res.ok) return handleError(res, 'Failed to erase byo-user');

  const data = (await res.json()) as ByoUserEraseResponse;

  if (opts.json) {
    out.json(data);
    return;
  }

  out.success(`Erase queued (wipeId: ${data.wipeId}, status: ${data.status})`);
  console.log('');
  console.log(
    '  queued; the memory wipe completes within ~15 minutes — check with --status;',
  );
  console.log('  thread/session deletion already completed with this command');
}

/**
 * `--status` leg: point-poll `erase-status` and render `queued|done|none`,
 * surfacing `stuck: true` as a visible operator-facing warning (the janitor
 * has retried without draining — same signal as the backend alarm).
 */
async function appByoUserEraseStatus(
  appId: string,
  sub: string,
  opts: { json?: boolean },
): Promise<void> {
  const res = await apiRequest(
    'GET',
    `/apps/${appId}/byo-users/erase-status?sub=${encodeURIComponent(sub)}`,
  );
  if (!res.ok) return handleError(res, 'Failed to fetch erase status');

  const data = (await res.json()) as ByoUserEraseStatusResponse;

  if (opts.json) {
    out.json(data);
    return;
  }

  console.log(`  status: ${data.status}`);
  if (data.requestedAt) console.log(`  requested at: ${data.requestedAt}`);
  if (typeof data.attempts === 'number') console.log(`  attempts: ${data.attempts}`);
  if (data.stuck) {
    out.error('wipe appears stuck — contact support');
  }
}
