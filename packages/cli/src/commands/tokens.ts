/**
 * guuey tokens -- Manage app-scoped service tokens
 * (`/v1/apps/:appId/service-tokens*`, guuey#217).
 *
 * Usage:
 *   guuey tokens create --label "ggui CI"   # Mint; prints the secret ONCE
 *   guuey tokens create --label "agent server" --scope threads-agent
 *   guuey tokens list                       # Prefix + label + scope + lifecycle, never the secret
 *   guuey tokens revoke <tokenId>           # Stamp revokedAt (idempotent)
 *
 * A service token is bound to exactly ONE app and acts on behalf of the
 * owner who minted it. It never expires: revoke is the kill switch. Each
 * scope has its own prefix and reaches exactly one door:
 *
 * - `deploy` (`guuey_svc_*`, the default): the durable headless-CI
 *   credential for agents-as-code, honored only on that app's reconcile
 *   route and deployment reads. Pass it per invocation via `GUUEY_API_KEY`
 *   (honored by every CLI command since guuey#182) or as the raw
 *   `Authorization: Bearer` on direct curl calls.
 * - `threads-agent` (`guuey_agt_*`, guuey#3006): the app's agent server
 *   writing to the hosted thread store as the agent. Set it as
 *   `GUUEY_THREADS_AGENT_TOKEN` in the agent server's environment.
 *
 * Mint/list/revoke themselves are app-OWNER operations: they require
 * your personal login (or PAT), never a service token.
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';
import { cliApiAuthHeaders } from '../cli-api-headers';

/**
 * Wire mirrors of `backend/libs/cli-wire/service-tokens.ts`. The CLI is a
 * published npm package and cannot depend on the private source package, so
 * it keeps hand-written copies pinned field-for-field by the sync guard in
 * `tokens.test.ts` (widget-keys/domains precedent).
 */
/** The scopes of the service-token family, in the wire's order (`ServiceTokenScope`). */
export const SERVICE_TOKEN_SCOPES = ['deploy', 'threads-agent'] as const;
export type ServiceTokenScope = (typeof SERVICE_TOKEN_SCOPES)[number];

/**
 * The bearer prefix each scope's secret starts with. Pinned against the
 * wire's `SERVICE_TOKEN_PREFIX_BY_SCOPE` by the sync guard in `tokens.test.ts`.
 */
export const SERVICE_TOKEN_PREFIX_BY_SCOPE: { readonly [S in ServiceTokenScope]: string } = {
  deploy: 'guuey_svc_',
  'threads-agent': 'guuey_agt_',
};

function isServiceTokenScope(value: string): value is ServiceTokenScope {
  return (SERVICE_TOKEN_SCOPES as readonly string[]).includes(value);
}

/** `POST /v1/apps/:appId/service-tokens` request body. */
export interface ServiceTokenCreateBody {
  label: string;
  /** Absent = deploy. A server that predates the field ignores it and mints deploy. */
  scope?: ServiceTokenScope;
}

export interface ServiceTokenItem {
  id: string;
  appId: string;
  /** 14-char display tail (`guuey_svc_xxxx` / `guuey_agt_xxxx`), never enough to authenticate. */
  tokenPrefix: string;
  label: string;
  /** The token's scope; a server that predates the field omits it (absent = deploy). */
  scope?: ServiceTokenScope;
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
      ...cliApiAuthHeaders(pat),
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

const CREATE_USAGE =
  'Usage: guuey tokens create --label "<what uses this token>" [--scope deploy|threads-agent]';

export async function tokensCreate(
  flags?: Record<string, string | true>,
): Promise<void> {
  const labelFlag = flags?.['label'];
  const label = typeof labelFlag === 'string' ? labelFlag.trim() : '';
  if (!label) {
    out.error(CREATE_USAGE);
    process.exit(1);
  }

  const scopeFlag = flags?.['scope'];
  if (scopeFlag !== undefined && (typeof scopeFlag !== 'string' || !isServiceTokenScope(scopeFlag))) {
    out.error(`--scope must be one of: ${SERVICE_TOKEN_SCOPES.join(', ')}. ${CREATE_USAGE}`);
    process.exit(1);
  }
  const requested: ServiceTokenScope = scopeFlag ?? 'deploy';

  const { pat, baseUrl, appId } = requestContext(flags);

  // The flag is sent only when given, so a plain create stays the body every
  // server has always accepted.
  const body: ServiceTokenCreateBody = scopeFlag === undefined ? { label } : { label, scope: scopeFlag };
  const res = await apiRequest(pat, baseUrl, 'POST', `/apps/${appId}/service-tokens`, body);
  if (!res.ok) await handleApiError(res);
  const data = (await res.json()) as ServiceTokenCreateResponse;

  // A server that predates scopes ignores the field and mints a deploy token,
  // so success is reported only on the server's own word: the echoed scope
  // (absent = deploy) and the secret's prefix must both match what was asked.
  // Otherwise the secret is withheld and the minted token named for revoke.
  const minted = data.item.scope ?? 'deploy';
  if (minted !== requested || !data.token.startsWith(SERVICE_TOKEN_PREFIX_BY_SCOPE[requested])) {
    out.error(
      `Asked for a ${requested} token, but the server minted ${data.item.tokenPrefix}… with scope ${minted}. ` +
        'This server does not support that scope, so the token was not shown. Revoke it with:',
    );
    console.error(`    guuey tokens revoke ${data.item.id}${appFlagSuffix(flags)}`);
    process.exit(1);
  }

  console.log('');
  out.success(`Service token minted for app ${appId} (${data.item.label}, scope ${requested}).`);
  console.log('');
  if (requested === 'threads-agent') {
    console.log('  This secret is shown ONCE. Set it in your agent server\'s environment now:');
    console.log('');
    console.log(`    GUUEY_THREADS_AGENT_TOKEN=${data.token}`);
    console.log('');
    console.log('  It lets this app\'s agent server write to the hosted thread store as');
    console.log('  the agent, and nothing else. It never expires. Revoke it with:');
  } else {
    console.log('  This secret is shown ONCE. Store it as a CI secret now:');
    console.log('');
    console.log(`    ${data.token}`);
    console.log('');
    console.log('  Use it headlessly via GUUEY_API_KEY (CLI) or as the raw');
    console.log('  Authorization bearer (curl). Scope: this app\'s reconcile');
    console.log('  route + deployment reads only. It never expires. Revoke it with:');
  }
  console.log('');
  console.log(`    guuey tokens revoke ${data.item.id}${appFlagSuffix(flags)}`);
  console.log('');
}

/** ` --app-id <id>` when the caller targeted an app by flag, so a printed recipe targets the same app. */
function appFlagSuffix(flags?: Record<string, string | true>): string {
  const appId = flags?.['app-id'];
  return typeof appId === 'string' ? ` --app-id ${appId}` : '';
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
    console.log(`    id ${item.id} · scope ${item.scope ?? 'deploy'} · created ${item.createdAt} · ${state}`);
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
  if (!res.ok) {
    // This door's 404 is the uniform one in three cases the API never tells
    // apart: no such app, no such token on it, or no write access to the app.
    const body: unknown = await res.json().catch(() => undefined);
    out.error(
      res.status === 404 && out.apiErrorCode(body) === 'NOT_FOUND'
        ? `Service token ${tokenId} was not found on app ${appId}, or this account is not allowed to revoke it. ` +
            'Check the token id ("guuey tokens list"), the app id, and which account you are signed in as ("guuey whoami").'
        : out.apiErrorMessage(body, `HTTP ${res.status} ${res.statusText}`),
    );
    process.exit(1);
  }
  const data = (await res.json()) as ServiceTokenRevokeResponse;

  out.success(`Service token ${data.id} revoked at ${data.revokedAt}. Auth stops within seconds.`);
}
