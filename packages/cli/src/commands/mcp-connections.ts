/**
 * `guuey mcp connections [list|revoke]` + `guuey mcp connect <serverName>`
 * — the CLI half of the OAuth credential broker's management surface
 * (guuey#178 Slice 5, spec §8 "CLI").
 *
 * These are END-USER commands, not workspace ones: a connection is the
 * signed-in user's authorization of a third-party MCP server ("authorize
 * once per server"), reusable across the user's apps through per-app
 * grants. The PAT's user is the user whose rows are listed / revoked — the
 * SAME Cognito sub the agent pod dials the broker as, so a builder testing
 * their own app sees exactly the connections their turns created.
 *
 *   mcp connections               list my connections + per-app grants
 *   mcp connections revoke <id>   revoke one (RFC 7009 at the AS best-effort,
 *                                 sealed tokens deleted, every app grant dropped)
 *   mcp connect <serverName>      dev-time connect for MY identity: mints
 *                                 the dance for (--app, serverName), prints
 *                                 the authorize URL, opens the browser
 *
 * Wire shapes are hand-mirrored from `@guuey-private/cli-wire`
 * (`mcp-connections.ts`) and pinned by `wire-sync.test.ts` — see
 * `../wire-mirror-parse.ts` for why the CLI mirrors instead of importing.
 */
import { execFile } from 'node:child_process';
import { requireAuth, type AuthTokens } from '../auth';
import { resolveConfig, type ResolvedConfig } from '../config';
import { apiRequest, parseApiError } from '../deploy-shared';
import * as out from '../output';

// ─── Wire mirrors (SYNC: backend/libs/cli-wire/mcp-connections.ts) ────

/** Mirror of `McpAttachmentWire`. */
export interface McpAttachmentWire {
  appId: string;
  appName: string;
  mode: string;
  threadId?: string;
  attachedAt: string;
}

/** Mirror of `McpConnectionWire` (statuses widened to string so a future one prints verbatim). */
export interface McpConnectionWire {
  connectionId: string;
  serverId: string;
  displayName: string;
  asIssuer?: string;
  status: string;
  scopes: string[];
  grantedAt: string;
  revokedAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  attachments: McpAttachmentWire[];
}

/** Mirror of `McpConnectionsWire`. */
export interface McpConnectionsWire {
  connections: McpConnectionWire[];
}

/** Mirror of `McpConnectStartWire`. */
export interface McpConnectStartWire {
  authorizeUrl: string;
  expiresAt: string;
}

// ─── Rendering (pure, unit-pinned) ────────────────────────────────────

export const MCP_CONNECTIONS_COLUMNS = ['ID', 'Server', 'Status', 'Apps', 'Granted', 'Last error'];

/** One `guuey mcp connections` table row. */
export function mcpConnectionRow(c: McpConnectionWire): Record<string, string> {
  const apps = c.attachments.map((a) => `${a.appName} (${a.mode})`).join(', ');
  return {
    ID: c.connectionId,
    Server: c.displayName === c.serverId ? c.serverId : `${c.displayName} — ${c.serverId}`,
    Status: c.status,
    Apps: apps.length > 0 ? apps : '—',
    Granted: c.grantedAt ? c.grantedAt.slice(0, 19).replace('T', ' ') : '—',
    'Last error': c.lastError ? `${c.lastError}${c.lastErrorAt ? ` @ ${c.lastErrorAt.slice(0, 19).replace('T', ' ')}` : ''}` : '—',
  };
}

/**
 * The default `returnTo` for a CLI-initiated connect: the console's Tools
 * tab of the app (a first-party origin the broker's allowlist always
 * carries), which shows the connection in its OAuth-servers panel and reads
 * the callback's `?connected=` / `?error=` off the URL.
 */
export function defaultConnectReturnTo(consoleHost: string, appId: string): string {
  return `${consoleHost.replace(/\/+$/, '')}/apps/${encodeURIComponent(appId)}/tools`;
}

/** Open a URL in the default browser (best-effort; false when nothing opened). */
function openBrowser(url: string): boolean {
  try {
    if (process.platform === 'darwin') execFile('open', [url], () => {});
    else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else execFile('xdg-open', [url], () => {});
    return true;
  } catch {
    return false;
  }
}

// ─── Cores (testable; `deps.api` is the injection seam) ────────────────

export async function mcpConnectionsListCore(
  opts: { json: boolean; auth: AuthTokens; config: ResolvedConfig },
  deps?: { api?: typeof apiRequest },
): Promise<void> {
  const api = deps?.api ?? apiRequest;
  const res = await api(opts.auth.pat, opts.config, 'GET', '/me/mcp-connections');
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }
  const data = (await res.json()) as McpConnectionsWire;
  if (opts.json) {
    out.json(data.connections);
    return;
  }
  if (data.connections.length === 0) {
    console.log('  No connected services yet. An agent turn (or "guuey mcp connect <server> --app <id>") starts one.');
    return;
  }
  out.table(data.connections.map(mcpConnectionRow), MCP_CONNECTIONS_COLUMNS);
}

export async function mcpConnectionsRevokeCore(
  opts: { connectionId: string; auth: AuthTokens; config: ResolvedConfig },
  deps?: { api?: typeof apiRequest },
): Promise<void> {
  const api = deps?.api ?? apiRequest;
  const res = await api(
    opts.auth.pat,
    opts.config,
    'DELETE',
    `/me/mcp-connections/${encodeURIComponent(opts.connectionId)}`,
  );
  if (res.status !== 204) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }
  out.success(`Revoked connection ${opts.connectionId} — tokens deleted, every app grant dropped.`);
}

export async function mcpConnectCore(
  opts: {
    appId: string;
    serverName: string;
    mode: 'always' | 'once';
    threadId?: string;
    returnTo: string;
    openBrowser: boolean;
    json: boolean;
    auth: AuthTokens;
    config: ResolvedConfig;
  },
  deps?: { api?: typeof apiRequest; open?: (url: string) => boolean },
): Promise<McpConnectStartWire> {
  const api = deps?.api ?? apiRequest;
  const open = deps?.open ?? openBrowser;
  const res = await api(opts.auth.pat, opts.config, 'POST', '/me/mcp-connections/start', {
    appId: opts.appId,
    serverName: opts.serverName,
    mode: opts.mode,
    returnTo: opts.returnTo,
    ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
  });
  if (res.status !== 201) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }
  const data = (await res.json()) as McpConnectStartWire;
  if (opts.json) {
    out.json(data);
    return data;
  }
  console.log(`Authorize "${opts.serverName}" for app ${opts.appId} (mode: ${opts.mode}) — link valid until ${data.expiresAt}:`);
  console.log(`  ${data.authorizeUrl}`);
  if (opts.openBrowser) {
    const opened = open(data.authorizeUrl);
    console.log(opened ? 'Opening your browser…' : "Couldn't open a browser — copy the URL above.");
  }
  console.log(`After you approve, the browser lands on ${opts.returnTo}; "guuey mcp connections" shows the new row.`);
  return data;
}

// ─── Command entrypoints ───────────────────────────────────────────────

/** `guuey mcp connections [list] [--json]` */
export async function mcpConnectionsList(flags?: Record<string, string | true>): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  try {
    await mcpConnectionsListCore({ json: flags?.json === true, auth, config });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** `guuey mcp connections revoke <connectionId>` */
export async function mcpConnectionsRevoke(connectionId?: string): Promise<void> {
  if (!connectionId) {
    out.error('Usage: guuey mcp connections revoke <connectionId>  ("guuey mcp connections" lists the ids)');
    process.exit(1);
  }
  const auth = requireAuth();
  const config = resolveConfig();
  try {
    await mcpConnectionsRevokeCore({ connectionId, auth, config });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * `guuey mcp connect <serverName> [--app <id>] [--mode always|once --thread <id>]
 *   [--return-to <url>] [--no-browser] [--json]`
 *
 * Dev-loop convenience for the builder's OWN identity: the app must be
 * DEPLOYED with `serverName` declared `credential: 'oauth'` (the broker
 * resolves it against the live snapshot — `guuey dev` has no lowered
 * snapshot, spec §11 risk 4). `--app` defaults to the linked app
 * (`guuey.json` / global config).
 */
export async function mcpConnect(
  serverName?: string,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (!serverName) {
    out.error('Usage: guuey mcp connect <serverName> [--app <appId>] [--mode always|once] [--return-to <url>] [--no-browser]');
    process.exit(1);
  }
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = typeof flags?.app === 'string' ? flags.app : config.appId;
  if (!appId) {
    out.error('No app linked. Pass --app <appId> or set "appId" in guuey.json.');
    process.exit(1);
  }
  const mode = flags?.mode === undefined ? 'always' : flags.mode;
  if (mode !== 'always' && mode !== 'once') {
    out.error("--mode must be 'always' or 'once'");
    process.exit(1);
  }
  const threadId = typeof flags?.thread === 'string' ? flags.thread : undefined;
  if (mode === 'once' && !threadId) {
    out.error("--mode once needs --thread <threadId> (a this-chat grant binds to a thread)");
    process.exit(1);
  }
  const returnTo =
    typeof flags?.['return-to'] === 'string' ? flags['return-to'] : defaultConnectReturnTo(config.host, appId);
  try {
    await mcpConnectCore({
      appId,
      serverName,
      mode,
      ...(threadId !== undefined ? { threadId } : {}),
      returnTo,
      openBrowser: flags?.['no-browser'] !== true,
      json: flags?.json === true,
      auth,
      config,
    });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
