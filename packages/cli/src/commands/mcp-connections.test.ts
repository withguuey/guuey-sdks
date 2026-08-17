/**
 * `guuey mcp connections|connect` (guuey#178 Slice 5) — the cores against a
 * stubbed `apiRequest`, the pure row renderer, and the default returnTo.
 * The on-disk cli-wire sync guard for these mirrors lives in
 * `wire-sync.test.ts` beside the others.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthTokens } from '../auth';
import type { ResolvedConfig } from '../config';
import {
  defaultConnectReturnTo,
  mcpConnectCore,
  mcpConnectionRow,
  mcpConnectionsListCore,
  mcpConnectionsRevokeCore,
  MCP_CONNECTIONS_COLUMNS,
  type McpConnectionWire,
} from './mcp-connections';

const auth: AuthTokens = { pat: 'guuey_user_test', expiresAt: '2099-01-01T00:00:00Z' };
const config: ResolvedConfig = { host: 'https://dev.platform.sandbox.guuey.com', apiUrl: 'https://api.dev.sandbox.guuey.com/v1' };

const CONN: McpConnectionWire = {
  connectionId: '6f1c1c9e-6d1a-4c9b-9a63-1c8ff2c8b0a1',
  serverId: 'https://platform-mcp.dev.sandbox.guuey.com/mcp',
  displayName: 'Guuey Platform',
  asIssuer: 'https://oauth.dev.sandbox.guuey.com',
  status: 'active',
  scopes: ['mcp:tools'],
  grantedAt: '2026-08-17T10:00:00.000Z',
  attachments: [
    { appId: 'app-1', appName: 'Trimly', mode: 'always', attachedAt: '2026-08-17T10:00:01.000Z' },
    { appId: 'app-2', appName: 'app-2', mode: 'denied', attachedAt: '2026-08-17T11:00:00.000Z' },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mcpConnectionRow', () => {
  it('renders id, server (display + canonical), status, per-app grants, granted time and last error', () => {
    expect(mcpConnectionRow(CONN)).toEqual({
      ID: CONN.connectionId,
      Server: 'Guuey Platform — https://platform-mcp.dev.sandbox.guuey.com/mcp',
      Status: 'active',
      Apps: 'Trimly (always), app-2 (denied)',
      Granted: '2026-08-17 10:00:00',
      'Last error': '—',
    });
    expect(Object.keys(mcpConnectionRow(CONN))).toEqual(MCP_CONNECTIONS_COLUMNS);
  });

  it('collapses a display name equal to the serverId, shows — for no apps, and formats lastError with its time', () => {
    const row = mcpConnectionRow({
      ...CONN,
      displayName: CONN.serverId,
      attachments: [],
      status: 'expired',
      lastError: 'invalid_grant',
      lastErrorAt: '2026-08-17T12:34:56.000Z',
    });
    expect(row.Server).toBe(CONN.serverId);
    expect(row.Apps).toBe('—');
    expect(row['Last error']).toBe('invalid_grant @ 2026-08-17 12:34:56');
  });
});

describe('defaultConnectReturnTo', () => {
  it("is the app's console Tools tab on the configured host (a first-party origin)", () => {
    expect(defaultConnectReturnTo('https://dev.platform.sandbox.guuey.com/', 'app 1')).toBe(
      'https://dev.platform.sandbox.guuey.com/apps/app%201/tools',
    );
  });
});

describe('mcpConnectionsListCore', () => {
  it('GETs /me/mcp-connections and prints the table (or the raw JSON)', async () => {
    const api = vi.fn(async () => jsonResponse(200, { connections: [CONN] }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await mcpConnectionsListCore({ json: false, auth, config }, { api });
    expect(api).toHaveBeenCalledWith('guuey_user_test', config, 'GET', '/me/mcp-connections');
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Guuey Platform');
    expect(output).toContain('Trimly (always)');

    logSpy.mockClear();
    await mcpConnectionsListCore({ json: true, auth, config }, { api });
    expect(JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(''))).toEqual([CONN]);
  });

  it('prints the empty-state hint with no connections, and surfaces API errors', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await mcpConnectionsListCore({ json: false, auth, config }, { api: vi.fn(async () => jsonResponse(200, { connections: [] })) });
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/No connected services yet/);
    await expect(
      mcpConnectionsListCore({ json: false, auth, config }, { api: vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'bad pat' } })) }),
    ).rejects.toThrow(/bad pat/);
  });
});

describe('mcpConnectionsRevokeCore', () => {
  it('DELETEs /me/mcp-connections/:id and treats anything but 204 as failure', async () => {
    const api = vi.fn(async () => jsonResponse(204, undefined));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await mcpConnectionsRevokeCore({ connectionId: CONN.connectionId, auth, config }, { api });
    expect(api).toHaveBeenCalledWith('guuey_user_test', config, 'DELETE', `/me/mcp-connections/${CONN.connectionId}`);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Revoked connection/);
    await expect(
      mcpConnectionsRevokeCore({ connectionId: 'nope', auth, config }, { api: vi.fn(async () => jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Connection nope not found' } })) }),
    ).rejects.toThrow(/not found/);
  });
});

describe('mcpConnectCore', () => {
  const start = { authorizeUrl: 'https://mcp.dev.sandbox.guuey.com/oauth/start?state=abc', expiresAt: '2026-08-17T10:10:00.000Z' };

  it('POSTs /me/mcp-connections/start with app, server, mode, returnTo; prints the URL and opens the browser', async () => {
    const api = vi.fn(async () => jsonResponse(201, start));
    const open = vi.fn(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await mcpConnectCore(
      { appId: 'app-1', serverName: 'platform', mode: 'always', returnTo: 'https://dev.platform.sandbox.guuey.com/apps/app-1/tools', openBrowser: true, json: false, auth, config },
      { api, open },
    );
    expect(result).toEqual(start);
    expect(api).toHaveBeenCalledWith('guuey_user_test', config, 'POST', '/me/mcp-connections/start', {
      appId: 'app-1',
      serverName: 'platform',
      mode: 'always',
      returnTo: 'https://dev.platform.sandbox.guuey.com/apps/app-1/tools',
    });
    expect(open).toHaveBeenCalledWith(start.authorizeUrl);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(start.authorizeUrl);
  });

  it("carries threadId for a once grant, honours --no-browser, and emits JSON on --json", async () => {
    const api = vi.fn(async () => jsonResponse(201, start));
    const open = vi.fn(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await mcpConnectCore(
      { appId: 'app-1', serverName: 'platform', mode: 'once', threadId: 't-1', returnTo: 'https://x.example', openBrowser: false, json: true, auth, config },
      { api, open },
    );
    expect((api.mock.calls[0] as unknown[])[4]).toMatchObject({ mode: 'once', threadId: 't-1' });
    expect(open).not.toHaveBeenCalled();
    expect(JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(''))).toEqual(start);
  });

  it("relays the API's refusal message (e.g. server_not_oauth)", async () => {
    await expect(
      mcpConnectCore(
        { appId: 'app-1', serverName: 'weather', mode: 'always', returnTo: 'https://x.example', openBrowser: false, json: false, auth, config },
        { api: vi.fn(async () => jsonResponse(400, { error: { code: 'VALIDATION', message: "server_not_oauth: That MCP server is not declared with credential: 'oauth'" } })), open: vi.fn(() => true) },
      ),
    ).rejects.toThrow(/server_not_oauth/);
  });
});
