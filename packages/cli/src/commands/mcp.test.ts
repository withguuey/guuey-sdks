import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveWorkspaceId,
  resolveServerName,
  validateMcpSize,
  isValidLabel,
  buildUploadBody,
  buildTriggerBody,
  parseSecretAssignment,
  resolveServerId,
  resolveServerRef,
  selectMcpBuild,
  renderMcpBuildLogs,
  mcpLogsCore,
  deployMcpFromSource,
  MCP_SIZES,
  formatLatestBuild,
  mcpServerListRow,
  mcpDeploymentRow,
  mcpListCore,
  mcpStatusCore,
  resolveMcpDeleteConfirmation,
  parseYesNoAnswer,
  pollMcpDeleteStatus,
  mcpDeleteCore,
  McpDeleteGrantsExistError,
  resolveMcpStateServerUrl,
  mcpStateScopeRow,
  mcpStateListCore,
  mcpStateExportCore,
  mcpStateWipeCore,
  type McpDeploymentInfo,
  type McpServerListItem,
} from './mcp.js';
import type { AuthTokens } from '../auth.js';
import type { ResolvedConfig } from '../config.js';
import type { apiRequest } from '../deploy-shared.js';

describe('resolveWorkspaceId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('flag wins over env', async () => {
    expect(
      await resolveWorkspaceId({ workspace: 'ws-flag' }, { GUUEY_WORKSPACE: 'ws-env' }),
    ).toBe('ws-flag');
  });

  it('falls back to GUUEY_WORKSPACE env when no flag', async () => {
    expect(await resolveWorkspaceId({}, { GUUEY_WORKSPACE: 'ws-env' })).toBe('ws-env');
    expect(await resolveWorkspaceId(undefined, { GUUEY_WORKSPACE: 'ws-env' })).toBe('ws-env');
  });

  it('returns null when neither is present and no opts (auth/config) given', async () => {
    expect(await resolveWorkspaceId({}, {})).toBeNull();
    expect(await resolveWorkspaceId(undefined, {})).toBeNull();
  });

  it('ignores a boolean (value-less) --workspace flag and an empty env', async () => {
    expect(await resolveWorkspaceId({ workspace: true }, {})).toBeNull();
    expect(await resolveWorkspaceId({}, { GUUEY_WORKSPACE: '' })).toBeNull();
  });

  // ── Personal-workspace fallback (front-door PNA fix) ──────────────────
  // No flag/env value + `opts.auth`/`opts.config` given → GET
  // /v1/me/personal-workspace (Task 4), the idempotent-ensure route a
  // stranger's first hosted-MCP deploy leg needs since they have no
  // workspace of their own yet.
  const auth = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config = { host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test' };

  it('falls back to GET /me/personal-workspace when opts are given and flag/env are absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ workspaceId: 'ws-personal-1' }), { status: 200 }),
    );

    const result = await resolveWorkspaceId({}, {}, { auth, config });

    expect(result).toBe('ws-personal-1');
    const [url, init] = fetchSpy.mock.calls.at(-1)!;
    expect(new URL(String(url)).pathname).toBe('/me/personal-workspace');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer pat-test' });
  });

  it('flag still wins over the personal-workspace fallback even when opts are given', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await resolveWorkspaceId({ workspace: 'ws-flag' }, {}, { auth, config });

    expect(result).toBe('ws-flag');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null (not throws) when the personal-workspace request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }), {
        status: 500,
      }),
    );

    expect(await resolveWorkspaceId({}, {}, { auth, config })).toBeNull();
  });
});

describe('resolveServerName', () => {
  it('flag wins over package.json name', () => {
    expect(resolveServerName({ name: 'from-flag' }, '@guuey/mcp-weather')).toBe('from-flag');
  });

  it('strips the npm scope from a scoped package.json name', () => {
    expect(resolveServerName({}, '@guuey/mcp-weather')).toBe('mcp-weather');
    expect(resolveServerName(undefined, '@scope/sub/deep-name')).toBe('deep-name');
  });

  it('passes an unscoped package.json name through unchanged', () => {
    expect(resolveServerName({}, 'mcp-weather')).toBe('mcp-weather');
  });

  it('returns null when neither flag nor package name is present', () => {
    expect(resolveServerName({}, undefined)).toBeNull();
    expect(resolveServerName(undefined, undefined)).toBeNull();
  });

  it('ignores a boolean (value-less) --name flag, falling back to package name', () => {
    expect(resolveServerName({ name: true }, '@guuey/mcp-weather')).toBe('mcp-weather');
  });
});

describe('validateMcpSize', () => {
  it('accepts every valid size, returning it unchanged', () => {
    for (const size of MCP_SIZES) {
      expect(validateMcpSize(size)).toBe(size);
    }
  });

  it('rejects unknown sizes and non-string inputs (returns null)', () => {
    expect(validateMcpSize('huge')).toBeNull();
    expect(validateMcpSize(true)).toBeNull();
    expect(validateMcpSize(undefined)).toBeNull();
    expect(validateMcpSize('')).toBeNull();
  });
});

describe('isValidLabel', () => {
  it('accepts git-tag-style labels', () => {
    expect(isValidLabel('v1.0')).toBe(true);
    expect(isValidLabel('release-candidate')).toBe(true);
    expect(isValidLabel('build_42')).toBe(true);
  });

  it('rejects spaces, double dots, .lock suffix, and trailing dot', () => {
    expect(isValidLabel('bad label')).toBe(false);
    expect(isValidLabel('..')).toBe(false);
    expect(isValidLabel('x.lock')).toBe(false);
    expect(isValidLabel('v1.')).toBe(false);
  });
});

describe('buildUploadBody', () => {
  it('produces the exact wire shape', () => {
    const body = buildUploadBody({
      workspaceId: 'ws-1',
      name: 'mcp-weather',
      size: 'sm',
      contentLength: 4096,
      sourceHash: 'abc123',
    });
    expect(body).toEqual({
      workspaceId: 'ws-1',
      name: 'mcp-weather',
      size: 'sm',
      contentLength: 4096,
      sourceHash: 'abc123',
    });
    expect(Object.keys(body).sort()).toEqual(
      ['contentLength', 'name', 'size', 'sourceHash', 'workspaceId'].sort(),
    );
  });
});

describe('buildTriggerBody', () => {
  it('uses the passed s3Key as sourceTarballKey and omits versionLabel when no label', () => {
    const body = buildTriggerBody({
      workspaceId: 'ws-1',
      serverId: 'mcp-weather-abc',
      buildNumber: 3,
      size: 'md',
      sourceTarballKey: 'workspaces/ws-1/mcp/mcp-weather-abc/uuid.tar.gz',
      sourceHash: 'deadbeef',
    });
    expect(body.sourceTarballKey).toBe(
      'workspaces/ws-1/mcp/mcp-weather-abc/uuid.tar.gz',
    );
    expect('versionLabel' in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(
      ['buildNumber', 'serverId', 'size', 'sourceHash', 'sourceTarballKey', 'workspaceId'].sort(),
    );
  });

  it('includes versionLabel when a label is given', () => {
    const body = buildTriggerBody({
      workspaceId: 'ws-1',
      serverId: 'mcp-weather-abc',
      buildNumber: 3,
      size: 'md',
      sourceTarballKey: 's3-key',
      sourceHash: 'deadbeef',
      label: 'v1.0',
    });
    expect(body.versionLabel).toBe('v1.0');
  });
});

describe('parseSecretAssignment', () => {
  it('parses a simple NAME=VALUE', () => {
    expect(parseSecretAssignment('WEATHER_API_KEY=sk-1')).toEqual({
      name: 'WEATHER_API_KEY',
      value: 'sk-1',
    });
  });

  it('splits on the FIRST = so the value may contain =', () => {
    expect(parseSecretAssignment('X=a=b')).toEqual({ name: 'X', value: 'a=b' });
  });

  it('returns null when there is no =', () => {
    expect(parseSecretAssignment('FOO')).toBeNull();
  });

  it('returns null for an empty name', () => {
    expect(parseSecretAssignment('=v')).toBeNull();
  });

  it('returns null for an empty value (backend rejects empty)', () => {
    expect(parseSecretAssignment('FOO=')).toBeNull();
  });

  it('returns null for an env-var-invalid name', () => {
    expect(parseSecretAssignment('bad-name=v')).toBeNull();
    expect(parseSecretAssignment('1FOO=v')).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseSecretAssignment(undefined)).toBeNull();
  });
});

describe('resolveServerId', () => {
  it('flag wins over env', () => {
    expect(
      resolveServerId({ server: 'srv-flag' }, { GUUEY_MCP_SERVER: 'srv-env' }),
    ).toBe('srv-flag');
  });

  it('falls back to GUUEY_MCP_SERVER env when no flag', () => {
    expect(resolveServerId({}, { GUUEY_MCP_SERVER: 'srv-env' })).toBe('srv-env');
    expect(resolveServerId(undefined, { GUUEY_MCP_SERVER: 'srv-env' })).toBe('srv-env');
  });

  it('returns null when neither is present', () => {
    expect(resolveServerId({}, {})).toBeNull();
    expect(resolveServerId(undefined, {})).toBeNull();
  });

  it('ignores a boolean (value-less) --server flag and an empty env', () => {
    expect(resolveServerId({ server: true }, {})).toBeNull();
    expect(resolveServerId({}, { GUUEY_MCP_SERVER: '' })).toBeNull();
  });
});

describe('resolveServerRef', () => {
  it('--server flag wins over the positional and env', () => {
    expect(
      resolveServerRef('srv-pos', { server: 'srv-flag' }, { GUUEY_MCP_SERVER: 'srv-env' }),
    ).toBe('srv-flag');
  });

  it('positional wins over env when no flag', () => {
    expect(resolveServerRef('srv-pos', {}, { GUUEY_MCP_SERVER: 'srv-env' })).toBe('srv-pos');
  });

  it('falls back to GUUEY_MCP_SERVER when neither flag nor positional', () => {
    expect(resolveServerRef(undefined, {}, { GUUEY_MCP_SERVER: 'srv-env' })).toBe('srv-env');
    expect(resolveServerRef('', undefined, { GUUEY_MCP_SERVER: 'srv-env' })).toBe('srv-env');
  });

  it('returns null when nothing yields a value', () => {
    expect(resolveServerRef(undefined, undefined, {})).toBeNull();
    expect(resolveServerRef('', { server: true }, {})).toBeNull();
  });
});

describe('selectMcpBuild', () => {
  const deployments: McpDeploymentInfo[] = [
    { buildNumber: 3, status: 'failed', errorMessage: 'boom', updatedAt: '2026-07-04T10:00:00Z' },
    { buildNumber: 2, status: 'superseded', updatedAt: '2026-07-03T10:00:00Z' },
    { buildNumber: 1, status: 'superseded', updatedAt: '2026-07-02T10:00:00Z' },
  ];

  it('defaults to the latest (first, newest-first) build', () => {
    const res = selectMcpBuild(deployments, undefined);
    expect(res).toEqual({ ok: true, deployment: deployments[0] });
  });

  it('selects a specific build via --build N', () => {
    const res = selectMcpBuild(deployments, '2');
    expect(res).toEqual({ ok: true, deployment: deployments[1] });
  });

  it('unknown build N → actionable error naming "guuey mcp status"', () => {
    const res = selectMcpBuild(deployments, '9');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('Build #9');
      expect(res.error).toContain('guuey mcp status');
    }
  });

  it('no builds at all → actionable error naming "guuey mcp status"', () => {
    const res = selectMcpBuild([], undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('guuey mcp status');
  });

  it('rejects a non-numeric or value-less --build', () => {
    for (const bad of ['abc', '-1', '0', '1.5', true as const]) {
      const res = selectMcpBuild(deployments, bad);
      expect(res.ok).toBe(false);
    }
  });
});

describe('renderMcpBuildLogs', () => {
  const honestNote = 'future observability slice';

  it('renders header + errorMessage verbatim for a failed build', () => {
    const lines = renderMcpBuildLogs({
      buildNumber: 3,
      status: 'failed',
      errorMessage: 'step 4/9 RUN pnpm build\nERROR: exit code 1',
      updatedAt: '2026-07-04T10:00:00Z',
    });
    const text = lines.join('\n');
    expect(lines[0]).toContain('Build #3');
    expect(lines[0]).toContain('failed');
    expect(lines[0]).toContain('2026-07-04T10:00:00Z');
    // errorMessage content verbatim, split into lines.
    expect(lines).toContain('step 4/9 RUN pnpm build');
    expect(lines).toContain('ERROR: exit code 1');
    // ALWAYS ends with the honest streaming one-liner.
    expect(lines[lines.length - 1]).toContain(honestNote);
    expect(text).not.toContain('No captured output');
  });

  it('renders the no-capture message + only-failure note for a live build', () => {
    const lines = renderMcpBuildLogs({
      buildNumber: 4,
      status: 'live',
      updatedAt: '2026-07-04T11:00:00Z',
    });
    const text = lines.join('\n');
    expect(text).toContain('No captured output for this build');
    // Non-failed builds get the honesty note that only failure output is captured.
    expect(text.toLowerCase()).toContain('failed builds');
    expect(lines[lines.length - 1]).toContain(honestNote);
  });

  it('omits the only-failure note for a failed build with no capture', () => {
    const lines = renderMcpBuildLogs({
      buildNumber: 5,
      status: 'failed',
      updatedAt: '2026-07-04T12:00:00Z',
    });
    const text = lines.join('\n');
    expect(text).toContain('No captured output for this build');
    expect(text.toLowerCase()).not.toContain('only failed builds');
    expect(lines[lines.length - 1]).toContain(honestNote);
  });
});

describe('mcpLogsCore', () => {
  const auth: AuthTokens = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config: ResolvedConfig = { host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' };

  const statusPayload = {
    server: {
      serverId: 'srv-1',
      name: 'mcp-weather',
      hostingStatus: 'live',
      size: 'sm',
      updatedAt: '2026-07-01T00:00:00Z',
    },
    deployments: [
      {
        buildNumber: 3,
        status: 'failed',
        errorMessage: 'kaniko tail line 1\nkaniko tail line 2',
        updatedAt: '2026-07-04T10:00:00Z',
      },
      { buildNumber: 2, status: 'live', updatedAt: '2026-07-03T10:00:00Z' },
    ],
    grantCount: 0,
  };

  function okApi(calls?: { method: string; path: string }[]): typeof apiRequest {
    return vi.fn(async (_pat, _cfg, method, path) => {
      calls?.push({ method, path });
      return new Response(JSON.stringify(statusPayload), { status: 200 });
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to the latest build and hits the Task-1 status route', async () => {
    const calls: { method: string; path: string }[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpLogsCore(
      { serverId: 'srv-1', workspaceId: 'ws-1', buildFlag: undefined, json: false, auth, config },
      { api: okApi(calls) },
    );

    expect(calls).toEqual([
      { method: 'GET', path: '/mcp/servers/srv-1?workspaceId=ws-1' },
    ]);
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Build #3');
    expect(output).toContain('kaniko tail line 1');
    expect(output).toContain('kaniko tail line 2');
  });

  it('--build selects an older build (no-capture path for a live build)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpLogsCore(
      { serverId: 'srv-1', workspaceId: 'ws-1', buildFlag: '2', json: false, auth, config },
      { api: okApi() },
    );

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Build #2');
    expect(output).toContain('No captured output for this build');
    expect(output).not.toContain('kaniko tail line 1');
  });

  it('--json emits the selected deployment row', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpLogsCore(
      { serverId: 'srv-1', workspaceId: 'ws-1', buildFlag: undefined, json: true, auth, config },
      { api: okApi() },
    );

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual(statusPayload.deployments[0]);
  });

  it('unknown build → throws the actionable error (naming guuey mcp status)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      mcpLogsCore(
        { serverId: 'srv-1', workspaceId: 'ws-1', buildFlag: '9', json: false, auth, config },
        { api: okApi() },
      ),
    ).rejects.toThrow(/guuey mcp status/);
  });

  it('API failure → throws the parseApiError message', async () => {
    const api: typeof apiRequest = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'MCP server srv-1 not found' }), {
        status: 404,
      });
    });
    await expect(
      mcpLogsCore(
        { serverId: 'srv-1', workspaceId: 'ws-1', buildFlag: undefined, json: false, auth, config },
        { api },
      ),
    ).rejects.toThrow('MCP server srv-1 not found');
  });
});

describe('deployMcpFromSource', () => {
  const auth: AuthTokens = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config: ResolvedConfig = { host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' };

  let dir: string;

  beforeEach(() => {
    // A minimal committed git repo with a Dockerfile + package.json, matching
    // what `packSource`'s git-archive fast path expects.
    dir = mkdtempSync(join(tmpdir(), 'mcp-deploy-test-'));
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20-slim\n');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'mcp-fixture', version: '0.0.1' }),
    );
    execSync('git init -q', { cwd: dir });
    execSync('git -c user.email=test@test.com -c user.name=test add -A', { cwd: dir });
    execSync(
      'git -c user.email=test@test.com -c user.name=test commit -q -m init',
      { cwd: dir },
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    'packs, uploads, triggers, and polls to a live result (happy path)',
    async () => {
      const calls: { method: string; path: string; body?: unknown }[] = [];
      const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path, body) => {
        calls.push({ method, path, body });
        if (path === '/mcp/deploy/upload') {
          return new Response(
            JSON.stringify({
              uploadUrl: 'https://s3.example.com/put',
              uploadId: 'up-1',
              serverId: 'srv-1',
              buildNumber: 4,
              s3Key: 'workspaces/ws-1/mcp/srv-1/build.tar.gz',
            }),
            { status: 200 },
          );
        }
        if (path === '/mcp/deploy/trigger') {
          return new Response(null, { status: 202 });
        }
        if (path === '/mcp/deployments/srv-1/4/status') {
          return new Response(
            JSON.stringify({ status: 'live', runtimeUrl: 'https://srv-1.mcp.guuey.com' }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected apiRequest call: ${method} ${path}`);
      });
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));

      const result = await deployMcpFromSource(
        { dir, name: 'mcp-weather', workspaceId: 'ws-1', size: 'sm', auth, config },
        { api },
      );

      expect(result).toEqual({
        serverId: 'srv-1',
        runtimeUrl: 'https://srv-1.mcp.guuey.com',
        buildNumber: 4,
      });
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /mcp/deploy/upload',
        'POST /mcp/deploy/trigger',
        'GET /mcp/deployments/srv-1/4/status',
      ]);
      // The trigger body carries the s3Key the upload response returned, NOT
      // a recomputed key.
      expect((calls[1]!.body as { sourceTarballKey: string }).sourceTarballKey).toBe(
        'workspaces/ws-1/mcp/srv-1/build.tar.gz',
      );

      fetchSpy.mockRestore();
    },
    10_000,
  );

  it(
    'throws with the status payload errorMessage when the deploy fails',
    async () => {
      const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path) => {
        if (path === '/mcp/deploy/upload') {
          return new Response(
            JSON.stringify({
              uploadUrl: 'https://s3.example.com/put',
              uploadId: 'up-1',
              serverId: 'srv-2',
              buildNumber: 1,
              s3Key: 'workspaces/ws-1/mcp/srv-2/build.tar.gz',
            }),
            { status: 200 },
          );
        }
        if (path === '/mcp/deploy/trigger') {
          return new Response(null, { status: 202 });
        }
        if (path === '/mcp/deployments/srv-2/1/status') {
          return new Response(
            JSON.stringify({ status: 'failed', errorMessage: 'Docker build failed: exit 1' }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected apiRequest call: ${method} ${path}`);
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

      await expect(
        deployMcpFromSource(
          { dir, name: 'mcp-weather', workspaceId: 'ws-1', size: 'sm', auth, config },
          { api },
        ),
      ).rejects.toThrow('Docker build failed: exit 1');

      vi.restoreAllMocks();
    },
    10_000,
  );
});

describe('formatLatestBuild', () => {
  it('renders "#<n> <status>" when present', () => {
    expect(formatLatestBuild({ buildNumber: 5, status: 'live' })).toBe('#5 live');
  });

  it('renders an em dash when absent', () => {
    expect(formatLatestBuild(undefined)).toBe('—');
  });
});

describe('mcpServerListRow', () => {
  const server: McpServerListItem = {
    serverId: 'srv-1',
    name: 'mcp-weather',
    hostingStatus: 'live',
    size: 'sm',
    runtimeUrl: 'https://srv-1.mcp.guuey.com',
    updatedAt: '2026-07-01T00:00:00Z',
    latestBuild: { buildNumber: 4, status: 'live' },
  };

  it('produces the exact NAME/SERVER ID/STATUS/SIZE/URL/LAST BUILD columns', () => {
    expect(mcpServerListRow(server)).toEqual({
      NAME: 'mcp-weather',
      'SERVER ID': 'srv-1',
      STATUS: 'live',
      SIZE: 'sm',
      URL: 'https://srv-1.mcp.guuey.com',
      'LAST BUILD': '#4 live',
    });
  });

  it('renders an em dash URL and last-build when both are absent', () => {
    const { runtimeUrl: _runtimeUrl, latestBuild: _latestBuild, ...rest } = server;
    expect(mcpServerListRow(rest)).toEqual({
      NAME: 'mcp-weather',
      'SERVER ID': 'srv-1',
      STATUS: 'live',
      SIZE: 'sm',
      URL: '—',
      'LAST BUILD': '—',
    });
  });
});

describe('mcpDeploymentRow', () => {
  it('renders BUILD/STATUS/UPDATED/NOTE with no note when errorMessage is absent', () => {
    expect(
      mcpDeploymentRow({ buildNumber: 2, status: 'live', updatedAt: '2026-07-03T10:00:00Z' }),
    ).toEqual({
      BUILD: '#2',
      STATUS: 'live',
      UPDATED: '2026-07-03T10:00:00Z',
      NOTE: '',
    });
  });

  it('flags a note when errorMessage is present (without leaking its content)', () => {
    const row = mcpDeploymentRow({
      buildNumber: 3,
      status: 'failed',
      errorMessage: 'kaniko tail...',
      updatedAt: '2026-07-04T10:00:00Z',
    });
    expect(row.NOTE).not.toBe('');
    expect(String(row.NOTE)).not.toContain('kaniko tail');
    expect(String(row.NOTE).toLowerCase()).toContain('mcp logs');
  });
});

describe('mcpListCore', () => {
  const auth: AuthTokens = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config: ResolvedConfig = { host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hits the servers-list route and renders a table', async () => {
    const calls: { method: string; path: string }[] = [];
    const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path) => {
      calls.push({ method, path });
      return new Response(
        JSON.stringify({
          servers: [
            {
              serverId: 'srv-1',
              name: 'mcp-weather',
              hostingStatus: 'live',
              size: 'sm',
              runtimeUrl: 'https://srv-1.mcp.guuey.com',
              updatedAt: '2026-07-01T00:00:00Z',
              latestBuild: { buildNumber: 4, status: 'live' },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpListCore({ workspaceId: 'ws-1', json: false, auth, config }, { api });

    expect(calls).toEqual([{ method: 'GET', path: '/mcp/servers?workspaceId=ws-1' }]);
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('mcp-weather');
    expect(output).toContain('srv-1');
    expect(output).toContain('#4 live');
  });

  it('--json passes the raw servers array through', async () => {
    const servers = [
      {
        serverId: 'srv-1',
        name: 'mcp-weather',
        hostingStatus: 'live',
        size: 'sm',
        updatedAt: '2026-07-01T00:00:00Z',
      },
    ];
    const api: typeof apiRequest = vi.fn(async () => {
      return new Response(JSON.stringify({ servers }), { status: 200 });
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpListCore({ workspaceId: 'ws-1', json: true, auth, config }, { api });

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual(servers);
  });

  it('empty workspace prints a friendly "no hosted MCP servers" line, not an error', async () => {
    const api: typeof apiRequest = vi.fn(async () => {
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpListCore({ workspaceId: 'ws-1', json: false, auth, config }, { api });

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output.toLowerCase()).toContain('no hosted mcp servers');
  });

  it('API failure throws the parseApiError message', async () => {
    const api: typeof apiRequest = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    });
    await expect(
      mcpListCore({ workspaceId: 'ws-1', json: false, auth, config }, { api }),
    ).rejects.toThrow('forbidden');
  });
});

describe('mcpStatusCore', () => {
  const auth: AuthTokens = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config: ResolvedConfig = { host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' };

  const statusPayload = {
    server: {
      serverId: 'srv-1',
      name: 'mcp-weather',
      hostingStatus: 'live',
      size: 'sm',
      runtimeUrl: 'https://srv-1.mcp.guuey.com',
      updatedAt: '2026-07-01T00:00:00Z',
    },
    deployments: [
      { buildNumber: 3, status: 'failed', errorMessage: 'boom', updatedAt: '2026-07-04T10:00:00Z' },
      { buildNumber: 2, status: 'live', updatedAt: '2026-07-03T10:00:00Z' },
    ],
    grantCount: 2,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hits the server-get route and renders a summary + deployments table + grant count', async () => {
    const calls: { method: string; path: string }[] = [];
    const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path) => {
      calls.push({ method, path });
      return new Response(JSON.stringify(statusPayload), { status: 200 });
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpStatusCore(
      { serverId: 'srv-1', workspaceId: 'ws-1', json: false, auth, config },
      { api },
    );

    expect(calls).toEqual([
      { method: 'GET', path: '/mcp/servers/srv-1?workspaceId=ws-1' },
    ]);
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('mcp-weather');
    expect(output).toContain('srv-1');
    expect(output).toContain('live');
    expect(output).toContain('https://srv-1.mcp.guuey.com');
    expect(output).toContain('#3');
    expect(output).toContain('#2');
    expect(output).toContain('Grants: 2');
  });

  it('--json emits the whole response', async () => {
    const api: typeof apiRequest = vi.fn(async () => {
      return new Response(JSON.stringify(statusPayload), { status: 200 });
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpStatusCore(
      { serverId: 'srv-1', workspaceId: 'ws-1', json: true, auth, config },
      { api },
    );

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual(statusPayload);
  });

  it('API failure (e.g. 404 unknown server) throws the parseApiError message', async () => {
    const api: typeof apiRequest = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'MCP server srv-1 not found' }), {
        status: 404,
      });
    });
    await expect(
      mcpStatusCore(
        { serverId: 'srv-1', workspaceId: 'ws-1', json: false, auth, config },
        { api },
      ),
    ).rejects.toThrow('MCP server srv-1 not found');
  });
});

describe('resolveMcpDeleteConfirmation', () => {
  it('--yes always skips the prompt, even non-TTY', () => {
    expect(
      resolveMcpDeleteConfirmation({ yes: true, stdinIsTTY: undefined, stdoutIsTTY: undefined }),
    ).toBe('skip');
    expect(
      resolveMcpDeleteConfirmation({ yes: true, stdinIsTTY: true, stdoutIsTTY: true }),
    ).toBe('skip');
  });

  it('interactive session (both stdin and stdout TTY) without --yes prompts', () => {
    expect(
      resolveMcpDeleteConfirmation({ yes: false, stdinIsTTY: true, stdoutIsTTY: true }),
    ).toBe('prompt');
  });

  it('non-interactive session (either side not a TTY) without --yes refuses', () => {
    expect(
      resolveMcpDeleteConfirmation({ yes: false, stdinIsTTY: undefined, stdoutIsTTY: undefined }),
    ).toBe('refuse');
    expect(
      resolveMcpDeleteConfirmation({ yes: false, stdinIsTTY: true, stdoutIsTTY: undefined }),
    ).toBe('refuse');
    expect(
      resolveMcpDeleteConfirmation({ yes: false, stdinIsTTY: undefined, stdoutIsTTY: true }),
    ).toBe('refuse');
  });
});

describe('parseYesNoAnswer', () => {
  it('accepts y/yes case-insensitively, with surrounding whitespace', () => {
    expect(parseYesNoAnswer('y')).toBe(true);
    expect(parseYesNoAnswer('Y')).toBe(true);
    expect(parseYesNoAnswer('yes')).toBe(true);
    expect(parseYesNoAnswer('YES')).toBe(true);
    expect(parseYesNoAnswer('  y  ')).toBe(true);
  });

  it('rejects everything else, including empty input', () => {
    expect(parseYesNoAnswer('')).toBe(false);
    expect(parseYesNoAnswer('n')).toBe(false);
    expect(parseYesNoAnswer('no')).toBe(false);
    expect(parseYesNoAnswer('sure')).toBe(false);
  });
});

describe('pollMcpDeleteStatus', () => {
  const auth = { pat: 'pat-test' };
  const config = { apiUrl: 'https://api.guuey.test' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'polls delete-status and treats a registry 404 as terminal success',
    async () => {
      const responses = [
        () => new Response(JSON.stringify({ status: 'deleting' }), { status: 200 }),
        () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'gone' } }), { status: 404 }),
      ];
      let call = 0;
      const api: typeof apiRequest = vi.fn(async () => {
        const make = responses[Math.min(call, responses.length - 1)]!;
        call += 1;
        return make();
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await pollMcpDeleteStatus(
        { auth, config, serverId: 'srv-1', workspaceId: 'ws-1', timeoutMs: 60_000, intervalMs: 1 },
        { api },
      );

      expect(result).toBe('deleted');
      expect(logSpy.mock.calls.flat()).toContain('  deleting...');
    },
    10_000,
  );

  it('surfaces a non-404 poll failure (e.g. 409 not-deleting) via parseApiError', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: 'CONFLICT', message: "server 'srv-1' is not being deleted (status: live)" } }),
        { status: 409 },
      ),
    );

    await expect(
      pollMcpDeleteStatus(
        { auth, config, serverId: 'srv-1', workspaceId: 'ws-1', timeoutMs: 60_000, intervalMs: 1 },
        { api },
      ),
    ).rejects.toThrow('is not being deleted');
  });

  it('times out with an actionable message when the row never reaches deleted', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'deleting' }), { status: 200 }),
    );

    await expect(
      pollMcpDeleteStatus(
        { auth, config, serverId: 'srv-1', workspaceId: 'ws-1', timeoutMs: 5, intervalMs: 10 },
        { api },
      ),
    ).rejects.toThrow(/timed out/i);
  });
});

describe('mcpDeleteCore', () => {
  const auth: AuthTokens = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config: ResolvedConfig = { host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no-force grants-exist 409 throws McpDeleteGrantsExistError carrying the app ids', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 'grants-exist',
          apps: ['app-1', 'app-2'],
          message: "MCP server 'srv-1' is attached to 2 app(s): app-1, app-2. Re-run with --force to delete anyway.",
        }),
        { status: 409 },
      ),
    );

    const err = await mcpDeleteCore(
      { serverId: 'srv-1', workspaceId: 'ws-1', force: false, auth, config },
      { api },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpDeleteGrantsExistError);
    expect((err as McpDeleteGrantsExistError).apps).toEqual(['app-1', 'app-2']);
    expect((err as Error).message).toContain('--force');
  });

  it('deployment-in-progress 409 throws a plain Error with the backend message', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 'deployment-in-progress',
          message: "MCP server 'srv-1' has a deployment in progress. Wait for it to finish (or fail) before deleting.",
        }),
        { status: 409 },
      ),
    );

    await expect(
      mcpDeleteCore({ serverId: 'srv-1', workspaceId: 'ws-1', force: false, auth, config }, { api }),
    ).rejects.toThrow('deployment in progress');
  });

  it('202 -> polls delete-status -> 404-as-success, sending force=1 in the DELETE query when --force', async () => {
    const calls: { method: string; path: string }[] = [];
    let deleteStatusCalls = 0;
    const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path) => {
      calls.push({ method, path });
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ status: 'deleting' }), { status: 202 });
      }
      // GET delete-status
      deleteStatusCalls += 1;
      if (deleteStatusCalls === 1) {
        return new Response(JSON.stringify({ status: 'deleting' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'gone' } }), {
        status: 404,
      });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpDeleteCore(
      { serverId: 'srv-1', workspaceId: 'ws-1', force: true, auth, config, pollIntervalMs: 1 },
      { api },
    );

    expect(calls[0]).toEqual({
      method: 'DELETE',
      path: '/mcp/servers/srv-1?workspaceId=ws-1&force=1',
    });
    expect(calls.slice(1).every((c) => c.path === '/mcp/servers/srv-1/delete-status?workspaceId=ws-1')).toBe(
      true,
    );
  });

  it('other DELETE failures (e.g. 404 unknown server) throw the parseApiError message', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'MCP server srv-1 not found' } }),
        { status: 404 },
      ),
    );

    await expect(
      mcpDeleteCore({ serverId: 'srv-1', workspaceId: 'ws-1', force: false, auth, config }, { api }),
    ).rejects.toThrow('MCP server srv-1 not found');
  });
});

// ─── guuey mcp state list|export|wipe (walls2 T6) ──────────────────────

describe('resolveMcpStateServerUrl', () => {
  const auth: AuthTokens = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config: ResolvedConfig = { host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--colocated composes colocatedResourceUrl(appId, name) with no API call', async () => {
    const api: typeof apiRequest = vi.fn(async () => {
      throw new Error('should not be called for --colocated');
    });

    const result = await resolveMcpStateServerUrl(
      { colocated: 'app_abc123/notes' },
      { workspaceId: '', auth, config },
      { api },
    );

    expect(result).toEqual({
      ok: true,
      serverUrl: 'https://colocated.guuey.com/app_abc123/notes/',
      label: 'app_abc123/notes',
    });
    expect(api).not.toHaveBeenCalled();
  });

  it('--colocated without a slash returns an error', async () => {
    const result = await resolveMcpStateServerUrl(
      { colocated: 'no-slash-here' },
      { workspaceId: '', auth, config },
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Invalid --colocated') });
  });

  it('--server resolves via GET /mcp/servers/:serverId to runtimeUrl', async () => {
    const calls: { method: string; path: string }[] = [];
    const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path) => {
      calls.push({ method, path });
      return new Response(
        JSON.stringify({
          server: {
            serverId: 'srv-1',
            name: 'mcp-weather',
            hostingStatus: 'live',
            size: 'sm',
            runtimeUrl: 'https://srv-1.mcp.guuey.com',
            updatedAt: '2026-07-01T00:00:00Z',
          },
          deployments: [],
          grantCount: 0,
        }),
        { status: 200 },
      );
    });

    const result = await resolveMcpStateServerUrl(
      { server: 'srv-1' },
      { workspaceId: 'ws-1', auth, config },
      { api },
    );

    expect(calls).toEqual([{ method: 'GET', path: '/mcp/servers/srv-1?workspaceId=ws-1' }]);
    expect(result).toEqual({ ok: true, serverUrl: 'https://srv-1.mcp.guuey.com', label: 'srv-1' });
  });

  it('--server with no runtimeUrl yet returns an actionable error', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({
          server: {
            serverId: 'srv-1',
            name: 'mcp-weather',
            hostingStatus: 'building',
            size: 'sm',
            updatedAt: '2026-07-01T00:00:00Z',
          },
          deployments: [],
          grantCount: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await resolveMcpStateServerUrl(
      { server: 'srv-1' },
      { workspaceId: 'ws-1', auth, config },
      { api },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('no runtime URL yet'),
    });
  });

  it('--server API failure surfaces the parseApiError message', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'MCP server srv-1 not found' }), { status: 404 }),
    );

    const result = await resolveMcpStateServerUrl(
      { server: 'srv-1' },
      { workspaceId: 'ws-1', auth, config },
      { api },
    );

    expect(result).toEqual({ ok: false, error: 'MCP server srv-1 not found' });
  });

  it('neither --server nor --colocated returns an error', async () => {
    const result = await resolveMcpStateServerUrl(undefined, { workspaceId: '', auth, config });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('No MCP server specified') });
  });

  it('both --server and --colocated returns an error', async () => {
    const result = await resolveMcpStateServerUrl(
      { server: 'srv-1', colocated: 'app1/notes' },
      { workspaceId: 'ws-1', auth, config },
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining('not both') });
  });
});

describe('mcpStateScopeRow', () => {
  it('maps a scope-usage row to table columns', () => {
    expect(mcpStateScopeRow({ userId: 'u-1', usedBytes: 512, keyCount: 3 })).toEqual({
      'USER ID': 'u-1',
      'USED BYTES': '512',
      'KEY COUNT': '3',
    });
  });
});

describe('mcpStateListCore', () => {
  const auth: AuthTokens = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config: ResolvedConfig = { host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs /state/admin.list with {serverUrl} and renders a table', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path, body) => {
      calls.push({ method, path, body });
      return new Response(
        JSON.stringify({ result: { scopes: [{ userId: 'u-1', usedBytes: 512, keyCount: 3 }] } }),
        { status: 200 },
      );
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpStateListCore(
      { serverUrl: 'https://srv-1.mcp.guuey.com', json: false, auth, config },
      { api },
    );

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/state/admin.list',
        body: { serverUrl: 'https://srv-1.mcp.guuey.com' },
      },
    ]);
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('u-1');
  });

  it('--json emits the raw scopes array', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({ result: { scopes: [{ userId: 'u-1', usedBytes: 512, keyCount: 3 }] } }),
        { status: 200 },
      ),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpStateListCore(
      { serverUrl: 'https://srv-1.mcp.guuey.com', json: true, auth, config },
      { api },
    );

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual([{ userId: 'u-1', usedBytes: 512, keyCount: 3 }]);
  });

  it('empty scopes prints a friendly line, not an empty table', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(JSON.stringify({ result: { scopes: [] } }), { status: 200 }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpStateListCore(
      { serverUrl: 'https://srv-1.mcp.guuey.com', json: false, auth, config },
      { api },
    );

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('No stored state');
  });

  it('stateApi flat {code,message} error envelope surfaces via the thrown message', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(JSON.stringify({ code: 'FORBIDDEN', message: "caller's workspace does not own this server" }), {
        status: 403,
      }),
    );

    await expect(
      mcpStateListCore({ serverUrl: 'https://srv-1.mcp.guuey.com', json: false, auth, config }, { api }),
    ).rejects.toThrow("caller's workspace does not own this server");
  });
});

describe('mcpStateExportCore', () => {
  const auth: AuthTokens = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config: ResolvedConfig = { host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guuey-state-export-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('POSTs /state/admin.export with {serverUrl, userId} and prints pretty JSON to stdout by default', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path, body) => {
      calls.push({ method, path, body });
      return new Response(JSON.stringify({ result: { entries: { foo: 'bar' } } }), { status: 200 });
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpStateExportCore(
      { serverUrl: 'https://srv-1.mcp.guuey.com', userId: 'u-1', auth, config },
      { api },
    );

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/state/admin.export',
        body: { serverUrl: 'https://srv-1.mcp.guuey.com', userId: 'u-1' },
      },
    ]);
    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(JSON.parse(printed)).toEqual({ foo: 'bar' });
  });

  it('-o writes the export to a file instead of stdout', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(JSON.stringify({ result: { entries: { foo: 'bar' } } }), { status: 200 }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outFile = join(dir, 'export.json');

    await mcpStateExportCore(
      { serverUrl: 'https://srv-1.mcp.guuey.com', userId: 'u-1', outFile, auth, config },
      { api },
    );

    const written = JSON.parse(readFileSync(outFile, 'utf-8')) as unknown;
    expect(written).toEqual({ foo: 'bar' });
    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).not.toContain('"foo"');
  });

  it('stateApi flat error envelope surfaces via the thrown message', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'invalid PAT' }), { status: 401 }),
    );

    await expect(
      mcpStateExportCore({ serverUrl: 'https://srv-1.mcp.guuey.com', userId: 'u-1', auth, config }, { api }),
    ).rejects.toThrow('invalid PAT');
  });
});

describe('mcpStateWipeCore', () => {
  const auth: AuthTokens = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config: ResolvedConfig = { host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--yes skips confirmation and POSTs /state/admin.wipe with {serverUrl, userId}', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path, body) => {
      calls.push({ method, path, body });
      return new Response(JSON.stringify({ result: { deleted: 5 } }), { status: 200 });
    });

    const result = await mcpStateWipeCore(
      {
        serverUrl: 'https://srv-1.mcp.guuey.com',
        userId: 'u-1',
        label: 'srv-1',
        yes: true,
        stdinIsTTY: false,
        stdoutIsTTY: false,
        auth,
        config,
      },
      { api },
    );

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/state/admin.wipe',
        body: { serverUrl: 'https://srv-1.mcp.guuey.com', userId: 'u-1' },
      },
    ]);
    expect(result).toEqual({ status: 'wiped', deleted: 5 });
  });

  it('non-TTY without --yes refuses without ever calling the API', async () => {
    const api: typeof apiRequest = vi.fn(async () => {
      throw new Error('should not be called');
    });

    const result = await mcpStateWipeCore(
      {
        serverUrl: 'https://srv-1.mcp.guuey.com',
        userId: 'u-1',
        label: 'srv-1',
        yes: false,
        stdinIsTTY: false,
        stdoutIsTTY: false,
        auth,
        config,
      },
      { api },
    );

    expect(result.status).toBe('refused');
    expect(api).not.toHaveBeenCalled();
  });

  it('interactive session prompts and aborts on "n" without calling the API', async () => {
    const api: typeof apiRequest = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const confirm = vi.fn(async (question: string) => {
      expect(question).toContain("Wipe stored state for 'u-1' on 'srv-1'");
      return 'n';
    });

    const result = await mcpStateWipeCore(
      {
        serverUrl: 'https://srv-1.mcp.guuey.com',
        userId: 'u-1',
        label: 'srv-1',
        yes: false,
        stdinIsTTY: true,
        stdoutIsTTY: true,
        auth,
        config,
      },
      { api, confirm },
    );

    expect(result.status).toBe('aborted');
    expect(api).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('interactive session prompts and proceeds on "y"', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(JSON.stringify({ result: { deleted: 2 } }), { status: 200 }),
    );
    const confirm = vi.fn(async () => 'y');

    const result = await mcpStateWipeCore(
      {
        serverUrl: 'https://srv-1.mcp.guuey.com',
        userId: 'u-1',
        label: 'srv-1',
        yes: false,
        stdinIsTTY: true,
        stdoutIsTTY: true,
        auth,
        config,
      },
      { api, confirm },
    );

    expect(result).toEqual({ status: 'wiped', deleted: 2 });
  });

  it('stateApi flat error envelope surfaces via the thrown message', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(JSON.stringify({ code: 'FORBIDDEN', message: 'admin op requires admin role' }), {
        status: 403,
      }),
    );

    await expect(
      mcpStateWipeCore(
        {
          serverUrl: 'https://srv-1.mcp.guuey.com',
          userId: 'u-1',
          label: 'srv-1',
          yes: true,
          stdinIsTTY: false,
          stdoutIsTTY: false,
          auth,
          config,
        },
        { api },
      ),
    ).rejects.toThrow('admin op requires admin role');
  });
});
