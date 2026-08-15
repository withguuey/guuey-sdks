/**
 * guuey tokens -- Manage app-scoped service tokens
 * (`/v1/apps/:appId/service-tokens*`, guuey#217).
 *
 * Usage:
 *   guuey tokens create --label "ggui CI"   # Mint; prints the secret ONCE
 *   guuey tokens list                       # Prefix + label + lifecycle, never the secret
 *   guuey tokens revoke <tokenId>           # Stamp revokedAt (idempotent)
 *
 * A service token (`guuey_svc_*`) is the durable headless-CI credential
 * for agents-as-code: bound to exactly ONE app, honored only on that
 * app's reconcile route + deployment reads, acting on behalf of the
 * owner who minted it. It never expires — revoke is the kill switch —
 * and unlike a personal PAT it cannot be clobbered by a laptop login,
 * carries no personal authority, and survives `guuey login` churn.
 *
 * CI usage: store the printed secret as a CI secret and pass it per
 * invocation via `GUUEY_API_KEY` (honored by every CLI command since
 * guuey#182) or as the raw `Authorization: Bearer` on direct curl calls.
 *
 * Mint/list/revoke themselves are app-OWNER operations — they require
 * your personal login (or PAT), never a service token.
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';

/**
 * Wire mirrors of `backend/libs/cli-wire/service-tokens.ts`. The CLI is a
 * published npm package and cannot depend on the private source package, so
 * it keeps hand-written copies pinned field-for-field by the sync guard in
 * `tokens.test.ts` (widget-keys/domains precedent).
 */
export interface ServiceTokenItem {
  id: string;
  appId: string;
  /** 14-char display tail (`guuey_svc_xxxx`) — never enough to authenticate. */
  tokenPrefix: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/** `POST /v1/apps/:appId/service-tokens` — 201. */
export interface ServiceTokenCreateResponse {
  /** The ONE time this value exists outside your own storage. */
  token: string;
  item: ServiceTokenItem;
}

/** `GET /v1/apps/:appId/service-tokens` — 200. */
export interface ServiceTokenListResponse {
  items: ServiceTokenItem[];
}

/** `DELETE /v1/apps/:appId/service-tokens/:tokenId` — 200. */
export interface ServiceTokenRevokeResponse {
  id: string;
  revokedAt: string;
}

async function apiRequest(
  pat: string,
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pat}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

interface RequestContext {
  pat: string;
  baseUrl: string;
  appId: string;
}

/** Shared prologue: auth + REST base URL + target appId (flag over config). */
function requestContext(flags?: Record<string, string | true>): RequestContext {
  const auth = requireAuth();
  const config = resolveConfig();
  const flagValue = flags?.['app-id'];
  const appId = typeof flagValue === 'string' ? flagValue : config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey pull --app-id <id>" to bind an existing app, or pass --app-id <id>.');
    process.exit(1);
  }

  if (!config.apiUrl) {
    out.error('REST API URL not configured.');
    process.exit(1);
  }

  return { pat: auth.pat, baseUrl: config.apiUrl.replace(/\/$/, ''), appId };
}

/** Render the cliApi error envelope (`{ error: { code, message } }`) and exit 1. */
async function handleApiError(res: Response): Promise<never> {
  let message: string;
  try {
    const body: unknown = await res.json();
    message = out.apiErrorMessage(body, `HTTP ${res.status}`);
  } catch {
    message = `HTTP ${res.status} ${res.statusText}`;
  }
  out.error(message);
  process.exit(1);
}

export async function tokensCreate(
  flags?: Record<string, string | true>,
): Promise<void> {
  const labelFlag = flags?.['label'];
  const label = typeof labelFlag === 'string' ? labelFlag.trim() : '';
  if (!label) {
    out.error('Usage: guuey tokens create --label "<what uses this token>"');
    process.exit(1);
  }

  const { pat, baseUrl, appId } = requestContext(flags);

  const res = await apiRequest(pat, baseUrl, 'POST', `/apps/${appId}/service-tokens`, { label });
  if (!res.ok) await handleApiError(res);
  const data = (await res.json()) as ServiceTokenCreateResponse;

  console.log('');
  out.success(`Service token minted for app ${appId} (${data.item.label}).`);
  console.log('');
  console.log('  This secret is shown ONCE. Store it as a CI secret now:');
  console.log('');
  console.log(`    ${data.token}`);
  console.log('');
  console.log('  Use it headlessly via GUUEY_API_KEY (CLI) or as the raw');
  console.log('  Authorization bearer (curl). Scope: this app\'s reconcile');
  console.log('  route + deployment reads only. It never expires — revoke with:');
  console.log('');
  console.log(`    guuey tokens revoke ${data.item.id}`);
  console.log('');
}

export async function tokensList(
  flags?: Record<string, string | true>,
): Promise<void> {
  const { pat, baseUrl, appId } = requestContext(flags);

  const res = await apiRequest(pat, baseUrl, 'GET', `/apps/${appId}/service-tokens`);
  if (!res.ok) await handleApiError(res);
  const data = (await res.json()) as ServiceTokenListResponse;

  console.log('');
  if (data.items.length === 0) {
    console.log(`  No service tokens for app ${appId}.`);
    console.log('  Mint one: guuey tokens create --label "<what uses it>"');
    console.log('');
    return;
  }
  for (const item of data.items) {
    const state = item.revokedAt
      ? `✗ revoked ${item.revokedAt}`
      : item.lastUsedAt
        ? `✓ active, last used ${item.lastUsedAt}`
        : '✓ active, never used';
    console.log(`  ${item.tokenPrefix}…  ${item.label}`);
    console.log(`    id ${item.id} · created ${item.createdAt} · ${state}`);
  }
  console.log('');
}

export async function tokensRevoke(
  tokenId: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (!tokenId) {
    out.error('Usage: guuey tokens revoke <tokenId>  (ids from "guuey tokens list")');
    process.exit(1);
  }

  const { pat, baseUrl, appId } = requestContext(flags);

  const res = await apiRequest(pat, baseUrl, 'DELETE', `/apps/${appId}/service-tokens/${tokenId}`);
  if (!res.ok) await handleApiError(res);
  const data = (await res.json()) as ServiceTokenRevokeResponse;

  out.success(`Service token ${data.id} revoked at ${data.revokedAt}. Auth stops within seconds.`);
}
