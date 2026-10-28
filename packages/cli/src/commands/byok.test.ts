/**
 * `guuey byok set | status | remove` (guuey#2412): the provider-key doors on
 * cliApi's `/keys/providers` routes.
 *
 * Same harness as `env.test.ts`: mock `../auth` and `../config`, spy on
 * `globalThis.fetch`. The key comes from an injected stdin stream.
 */
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  type AppProviderKeysWire,
  type RemoveProviderKeyResult,
  type SetProviderKeyResult,
  type WorkspaceProviderKeysWire,
  byokRemove,
  byokSet,
  byokStatus,
} from './byok.js';

vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return {
    ...actual,
    requireAuth: vi.fn(() => ({
      pat: 'pat-test',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })),
  };
});

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    resolveConfig: vi.fn(() => ({
      host: 'https://guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app1',
    })),
  };
});

/** Thrown by the process.exit mock so execution stops like the real thing. */
class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const KEY = 'sk-ant-api03-secret-abcd';

let fetchSpy: MockInstance<typeof fetch>;
let errorSpy: MockInstance<typeof console.error>;
let logSpy: MockInstance<typeof console.log>;
let exitSpy: MockInstance<typeof process.exit>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitSignal(typeof code === 'number' ? code : undefined);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A piped stdin carrying `text`. */
function stdin(text: string): PassThrough {
  const input = new PassThrough();
  input.end(text);
  return input;
}

/** A stdin that is never written to: reading it would hang the test, so a refusal must come first. */
function untouchedStdin(): PassThrough {
  return new PassThrough();
}

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status });
}

function apiError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

const stderrLines = (): string[] => errorSpy.mock.calls.map((call) => String(call[0]));
const stdoutLines = (): string[] => logSpy.mock.calls.map((call) => String(call[0]));

/** The one request made: its path (below the API base), method and parsed body. */
function onlyRequest(): { path: string; method: string | undefined; body: unknown } {
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0] ?? [];
  return {
    path: new URL(String(url)).pathname,
    method: init?.method,
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

/** Nothing the command printed carries the key, whole or in part beyond its last 4. */
function expectKeyNeverPrinted(key: string): void {
  const printed = [...stderrLines(), ...stdoutLines()].join('\n');
  expect(printed).not.toContain(key);
  expect(printed).not.toContain(key.slice(0, -4));
}

const setResult = (over: Partial<SetProviderKeyResult> = {}): SetProviderKeyResult => ({
  provider: 'anthropic',
  tier: 'app',
  keyLast4: 'abcd',
  rotated: false,
  message: 'Saved ••••abcd. Takes effect on the next deploy.',
  ...over,
});

// ─── set ────────────────────────────────────────────────────────────

describe('guuey byok set — the key never comes from the command line', () => {
  const refusal =
    '✗ Keys are never read from the command line (shell history). ' +
    'Pipe it: guuey byok set --provider anthropic --app-id <id> < key.txt';

  it.each([
    ['--key <value>', { key: KEY }],
    ['--key=<value>', { [`key=${KEY}`]: true }],
    ['--api-key <value>', { 'api-key': KEY }],
    ['--apiKey <value>', { apiKey: KEY }],
    ['--KEY <value>', { KEY: KEY }],
    ['a bare --key', { key: true }],
  ] as const)('refuses %s before any request or stdin read', async (_label, keyFlag) => {
    await expect(
      byokSet({ provider: 'anthropic', 'app-id': 'app1', ...keyFlag }, [], untouchedStdin()),
    ).rejects.toThrow(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrLines()).toEqual([refusal]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('refuses a key given as a positional argument', async () => {
    await expect(byokSet({ provider: 'anthropic' }, [KEY], untouchedStdin())).rejects.toThrow(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrLines()).toEqual([refusal]);
  });
});

describe('guuey byok set — flags', () => {
  it('requires --provider (it never defaults to anthropic)', async () => {
    await expect(byokSet({ 'app-id': 'app1' }, [], untouchedStdin())).rejects.toThrow(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrLines()).toEqual([
      '✗ Missing --provider. One of: anthropic, openai, google, openrouter. ' +
        'Use: guuey byok set --provider anthropic --app-id <id> < key.txt',
    ]);
  });

  it('refuses --provider bedrock locally: only the four can be set', async () => {
    await expect(byokSet({ provider: 'bedrock', 'app-id': 'app1' }, [], untouchedStdin())).rejects.toThrow(
      ExitSignal,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrLines()).toEqual([
      '✗ Invalid provider "bedrock". Must be one of: anthropic, openai, google, openrouter',
    ]);
  });

  it('refuses --app-id together with --workspace', async () => {
    await expect(
      byokSet({ provider: 'anthropic', 'app-id': 'app1', workspace: 'acme' }, [], untouchedStdin()),
    ).rejects.toThrow(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrLines()).toEqual(['✗ Pass --app-id or --workspace, not both.']);
  });

  it('refuses a --workspace with no value', async () => {
    await expect(byokSet({ provider: 'anthropic', workspace: true }, [], untouchedStdin())).rejects.toThrow(
      ExitSignal,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrLines()).toEqual(['✗ --workspace needs a workspace id or slug.']);
  });
});

describe('guuey byok set — stdin', () => {
  it('a piped key is PUT to the bound app, one trailing newline stripped, and the line names the app', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, setResult()));

    await byokSet({ provider: 'anthropic' }, [], stdin(`${KEY}\n`));

    expect(onlyRequest()).toEqual({
      path: '/apps/app1/keys/providers/anthropic',
      method: 'PUT',
      body: { apiKey: KEY },
    });
    expect(stdoutLines()).toEqual(['✓ Saved anthropic key ••••abcd on app app1. Takes effect on the next deploy.']);
    expectKeyNeverPrinted(KEY);
  });

  it('a set the server recorded no last 4 for (a key under 16 characters) names no last 4', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, setResult({ keyLast4: null, message: 'Saved the key. Takes effect on the next deploy.' })));

    await byokSet({ provider: 'anthropic' }, [], stdin(`${KEY}\n`));

    expect(stdoutLines()).toEqual(['✓ Saved anthropic key on app app1. Takes effect on the next deploy.']);
  });

  it('--app-id targets that app; a \\r\\n ending is stripped too', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, setResult()));

    await byokSet({ provider: 'anthropic', 'app-id': 'app-other' }, [], stdin(`${KEY}\r\n`));

    expect(onlyRequest()).toMatchObject({ path: '/apps/app-other/keys/providers/anthropic', body: { apiKey: KEY } });
    expect(stdoutLines()).toEqual([
      '✓ Saved anthropic key ••••abcd on app app-other. Takes effect on the next deploy.',
    ]);
  });

  it('a replaced key says so', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, setResult({ rotated: true })));

    await byokSet({ provider: 'anthropic' }, [], stdin(`${KEY}\n`));

    expect(stdoutLines()).toEqual([
      '✓ Saved anthropic key ••••abcd on app app1, replacing the previous one. Takes effect on the next deploy.',
    ]);
  });

  it('--workspace PUTs to the workspace and names it', async () => {
    fetchSpy.mockResolvedValueOnce(
      json(200, setResult({ provider: 'openai', tier: 'workspace', keyLast4: 'wxyz' })),
    );

    await byokSet({ provider: 'openai', workspace: 'acme' }, [], stdin('sk-proj-1234wxyz\n'));

    expect(onlyRequest()).toEqual({
      path: '/workspaces/acme/keys/providers/openai',
      method: 'PUT',
      body: { apiKey: 'sk-proj-1234wxyz' },
    });
    expect(stdoutLines()).toEqual([
      "✓ Saved openai key ••••wxyz on workspace acme. Takes effect on each app's next deploy.",
    ]);
  });

  it.each([
    ['empty input', '', '✗ No key on stdin. Pipe it: guuey byok set --provider anthropic --app-id <id> < key.txt'],
    ['a lone newline', '\n', '✗ No key on stdin. Pipe it: guuey byok set --provider anthropic --app-id <id> < key.txt'],
    ['multi-line input', 'sk-a\nsk-b\n', '✗ The key on stdin spans more than one line. Pipe exactly one key.'],
  ])('refuses %s with no request', async (_label, text, line) => {
    await expect(byokSet({ provider: 'anthropic' }, [], stdin(text))).rejects.toThrow(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrLines()).toEqual([line]);
  });

  it('a TTY gets one muted prompt and the key is sent, never echoed', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, setResult()));
    const input = Object.assign(new PassThrough(), { isTTY: true as const });

    const done = byokSet({ provider: 'anthropic' }, [], input);
    input.write(`${KEY}\r`);
    await done;

    expect(onlyRequest()).toMatchObject({ body: { apiKey: KEY } });
    expectKeyNeverPrinted(KEY);
  });
});

describe('guuey byok set — server answers', () => {
  it("400 PERSONAL_WORKSPACE_PROVIDER_KEY prints the server's message and the --app-id line", async () => {
    const message = "Personal apps don't use a workspace key. Set the key on the app instead.";
    fetchSpy.mockResolvedValueOnce(apiError(400, 'PERSONAL_WORKSPACE_PROVIDER_KEY', message));

    await expect(byokSet({ provider: 'anthropic', workspace: 'me' }, [], stdin(`${KEY}\n`))).rejects.toThrow(
      ExitSignal,
    );

    expect(stderrLines()).toEqual([
      `✗ PERSONAL_WORKSPACE_PROVIDER_KEY: ${message}`,
      'Use: guuey byok set --provider anthropic --app-id <id>',
    ]);
    expectKeyNeverPrinted(KEY);
  });

  it("409 on the app PUT prints the server's message and the apps recover line", async () => {
    const message =
      'This app has a pending deletion request. Cancel the deletion before setting a provider key.';
    fetchSpy.mockResolvedValueOnce(apiError(409, 'CONFLICT', message));

    await expect(byokSet({ provider: 'anthropic' }, [], stdin(`${KEY}\n`))).rejects.toThrow(ExitSignal);

    expect(stderrLines()).toEqual([`✗ CONFLICT: ${message}`, 'Use: guuey apps recover app1']);
  });

  it('a 400 VALIDATION prints the server message alone', async () => {
    fetchSpy.mockResolvedValueOnce(apiError(400, 'VALIDATION', 'The key must be at most 4096 bytes.'));

    await expect(byokSet({ provider: 'anthropic' }, [], stdin(`${KEY}\n`))).rejects.toThrow(ExitSignal);

    expect(stderrLines()).toEqual(['✗ VALIDATION: The key must be at most 4096 bytes.']);
  });
});

// ─── the old-server and refusal faces, every subcommand ─────────────

const OLD_SERVER_APP =
  "✗ This Guuey server doesn't support provider keys from the CLI yet. Use the console: https://guuey.test/apps/app1/behavior";
const OLD_SERVER_WORKSPACE =
  "✗ This Guuey server doesn't support provider keys from the CLI yet. Use the console: https://guuey.test/settings/workspaces";

const runs = {
  'set --app-id': () => byokSet({ provider: 'anthropic', 'app-id': 'app1' }, [], stdin(`${KEY}\n`)),
  'set --workspace': () => byokSet({ provider: 'anthropic', workspace: 'acme' }, [], stdin(`${KEY}\n`)),
  'status --app-id': () => byokStatus({ 'app-id': 'app1' }),
  'status --workspace': () => byokStatus({ workspace: 'acme' }),
  'remove --app-id': () => byokRemove({ provider: 'anthropic', 'app-id': 'app1' }),
  'remove --workspace': () => byokRemove({ provider: 'anthropic', workspace: 'acme' }),
} as const;

describe('guuey byok — an old server (404 NOT_FOUND on /keys/providers)', () => {
  it.each([
    ['set --app-id', OLD_SERVER_APP],
    ['set --workspace', OLD_SERVER_WORKSPACE],
    ['status --app-id', OLD_SERVER_APP],
    ['status --workspace', OLD_SERVER_WORKSPACE],
    ['remove --app-id', OLD_SERVER_APP],
    ['remove --workspace', OLD_SERVER_WORKSPACE],
  ] as const)('%s prints the console pointer after exactly one request', async (name, line) => {
    fetchSpy.mockResolvedValueOnce(apiError(404, 'NOT_FOUND', 'Not found'));

    await expect(runs[name]()).rejects.toThrow(ExitSignal);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(stderrLines()).toEqual([line]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('guuey byok — 404 PROVIDER_KEYS_NOT_FOUND', () => {
  it.each([
    ['set --app-id', 'admin'],
    ['set --workspace', 'admin'],
    ['remove --app-id', 'admin'],
    ['remove --workspace', 'admin'],
    ['status --app-id', 'member'],
    ['status --workspace', 'member'],
  ] as const)('%s prints the not-found / not-%s line, not the old-server line', async (name, role) => {
    fetchSpy.mockResolvedValueOnce(apiError(404, 'PROVIDER_KEYS_NOT_FOUND', 'App app1 not found'));

    await expect(runs[name]()).rejects.toThrow(ExitSignal);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(stderrLines()).toEqual([`✗ No such app or workspace, or you aren't ${role === 'admin' ? 'an admin' : 'a member'} of it.`]);
  });
});

describe('guuey byok — a scope-gate 403 (old or new server)', () => {
  const readOnly =
    'This API key is read-only (platform:read). The requested operation requires the platform:manage scope — use a key authorized with management access.';
  const adminOnly =
    'This API key is limited to the admin status doors (admin:status-draft). The requested operation needs a platform scope — use a key authorized with platform access.';

  it.each([
    ['set --app-id', readOnly],
    ['status --app-id', readOnly],
    ['status --workspace', readOnly],
    ['remove --workspace', adminOnly],
    ['status --app-id', adminOnly],
  ] as const)("%s prints the server's message, never the old-server or not-admin line", async (name, message) => {
    fetchSpy.mockResolvedValueOnce(apiError(403, 'FORBIDDEN', message));

    await expect(runs[name]()).rejects.toThrow(ExitSignal);

    expect(stderrLines()).toEqual([`✗ FORBIDDEN: ${message}`]);
  });
});

// ─── status ─────────────────────────────────────────────────────────

const face = (keyLast4: string | null, setAt: string | null = '2026-10-20T09:00:00.000Z') => ({
  keyLast4,
  status: 'active' as const,
  setAt,
});

function appWire(over: Partial<AppProviderKeysWire> = {}): AppProviderKeysWire {
  return {
    appId: 'app1',
    owner: { kind: 'workspace', workspaceId: 'ws-1', slug: 'acme' },
    providers: [
      {
        provider: 'anthropic',
        configured: { source: 'app', keyLast4: 'abcd' },
        app: face('abcd'),
        workspace: face('wxyz'),
      },
      {
        provider: 'openai',
        configured: { source: 'workspace', keyLast4: null },
        app: null,
        workspace: face(null, null),
      },
      {
        provider: 'google',
        configured: { source: 'managed', keyLast4: null },
        app: null,
        workspace: null,
      },
      { provider: 'openrouter', configured: { source: 'managed', keyLast4: null }, app: null, workspace: null },
    ],
    unsupported: [
      { provider: 'bedrock', tier: 'app' },
      { provider: 'bedrock', tier: 'workspace' },
    ],
    appliesOn: 'next-deploy',
    ...over,
  };
}

describe('guuey byok status — an app', () => {
  it('GETs the app keys and prints each provider, the unsupported remove lines and the closing line', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, appWire()));

    await byokStatus({});

    expect(onlyRequest()).toEqual({ path: '/apps/app1/keys/providers', method: 'GET', body: undefined });
    expect(stdoutLines()).toEqual([
      'Provider keys for app app1 (workspace acme)',
      '',
      '  anthropic',
      '    Configured:    app key ••••abcd',
      '    App key:       ••••abcd · active · set 2026-10-20T09:00:00.000Z',
      '    Workspace key: ••••wxyz · active · set 2026-10-20T09:00:00.000Z',
      '  openai',
      '    Configured:    workspace key (last 4 not recorded)',
      '    App key:       none',
      '    Workspace key: last 4 not recorded · active · set unknown',
      '  google',
      "    Configured:    managed (the platform's key)",
      '    App key:       none',
      '    Workspace key: none',
      '  openrouter',
      "    Configured:    managed (the platform's key)",
      '    App key:       none',
      '    Workspace key: none',
      '',
      'bedrock (app): no runtime reads this key. Remove it: guuey byok remove --provider bedrock --app-id app1',
      'bedrock (workspace): no runtime reads this key. Remove it: guuey byok remove --provider bedrock --workspace acme',
      '',
      'Keys apply on the next deploy.',
    ]);
  });

  it('a personal app has no workspace lines', async () => {
    fetchSpy.mockResolvedValueOnce(
      json(
        200,
        appWire({
          owner: { kind: 'personal' },
          providers: [
            { provider: 'anthropic', configured: { source: 'managed', keyLast4: null }, app: null, workspace: null },
          ],
          unsupported: [],
        }),
      ),
    );

    await byokStatus({ 'app-id': 'app1' });

    expect(stdoutLines()).toEqual([
      'Provider keys for app app1 (personal)',
      '',
      '  anthropic',
      "    Configured:    managed (the platform's key)",
      '    App key:       none',
      '',
      'Keys apply on the next deploy.',
    ]);
  });

  it('plainSlotEnvNames: each name prints under its heading with its env unset line', async () => {
    fetchSpy.mockResolvedValueOnce(
      json(200, appWire({ unsupported: [], plainSlotEnvNames: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] })),
    );

    await byokStatus({});

    const lines = stdoutLines();
    const heading = lines.indexOf(
      "Plain variables named like a provider key (they don't switch the app to your key):",
    );
    expect(heading).toBeGreaterThan(-1);
    expect(lines.slice(heading + 1, heading + 3)).toEqual([
      '  ANTHROPIC_API_KEY. Remove it: guuey env unset ANTHROPIC_API_KEY --app-id app1',
      '  OPENAI_API_KEY. Remove it: guuey env unset OPENAI_API_KEY --app-id app1',
    ]);
  });

  it('plainSlotEnvNames: an empty array prints nothing', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, appWire({ plainSlotEnvNames: [] })));

    await byokStatus({});

    expect(stdoutLines().join('\n')).not.toMatch(/plain variables/i);
  });

  it('plainSlotEnvNames: an absent field prints nothing and makes no second request', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, appWire()));

    await byokStatus({});

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(stdoutLines().join('\n')).not.toMatch(/plain variables/i);
  });

  it('--json prints the wire unchanged', async () => {
    const wire = appWire({ plainSlotEnvNames: ['ANTHROPIC_API_KEY'] });
    fetchSpy.mockResolvedValueOnce(json(200, wire));

    await byokStatus({ json: true });

    expect(stdoutLines()).toEqual([JSON.stringify(wire, null, 2)]);
  });

  it('refuses --app-id together with --workspace before any request', async () => {
    await expect(byokStatus({ 'app-id': 'app1', workspace: 'acme' })).rejects.toThrow(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('guuey byok status — a workspace', () => {
  const wire: WorkspaceProviderKeysWire = {
    workspaceId: 'ws-1',
    slug: 'acme',
    providers: [
      { provider: 'anthropic', key: face('wxyz') },
      { provider: 'openai', key: null },
      { provider: 'google', key: { keyLast4: '9f2e', status: 'revoked', setAt: '2026-09-01T00:00:00.000Z' } },
      { provider: 'openrouter', key: null },
    ],
    unsupported: [{ provider: 'bedrock' }],
    appliesOn: 'next-deploy',
  };

  it('GETs the workspace keys by the given ref and prints its rows', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, wire));

    await byokStatus({ workspace: 'acme' });

    expect(onlyRequest()).toEqual({ path: '/workspaces/acme/keys/providers', method: 'GET', body: undefined });
    expect(stdoutLines()).toEqual([
      'Provider keys for workspace acme (ws-1)',
      '',
      '  anthropic   ••••wxyz · active · set 2026-10-20T09:00:00.000Z',
      '  openai      none',
      '  google      ••••9f2e · revoked · set 2026-09-01T00:00:00.000Z',
      '  openrouter  none',
      '',
      'bedrock (workspace): no runtime reads this key. Remove it: guuey byok remove --provider bedrock --workspace acme',
      '',
      "Apps in this workspace use these keys unless they set their own. Keys apply on each app's next deploy.",
    ]);
  });

  it('--json prints the wire unchanged', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, wire));

    await byokStatus({ workspace: 'acme', json: true });

    expect(stdoutLines()).toEqual([JSON.stringify(wire, null, 2)]);
  });
});

// ─── remove ─────────────────────────────────────────────────────────

const removeResult = (over: Partial<RemoveProviderKeyResult> = {}): RemoveProviderKeyResult => ({
  provider: 'anthropic',
  tier: 'app',
  removed: true,
  message: 'Removed the anthropic key from this app.',
  ...over,
});

describe('guuey byok remove', () => {
  it('--provider bedrock is sent: the server decides which stored ids can be removed', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, removeResult({ provider: 'bedrock' })));

    await byokRemove({ provider: 'bedrock', 'app-id': 'app1' });

    expect(onlyRequest()).toEqual({ path: '/apps/app1/keys/providers/bedrock', method: 'DELETE', body: undefined });
    expect(stdoutLines()).toEqual(['✓ Removed bedrock key from app app1.']);
  });

  it('names what the next deploy falls to', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, removeResult({ next: { source: 'workspace', keyLast4: 'wxyz' } })));

    await byokRemove({ provider: 'anthropic' });

    expect(stdoutLines()).toEqual([
      '✓ Removed anthropic key from app app1. The next deploy uses the workspace key ••••wxyz.',
    ]);
  });

  it("names the platform's managed key as the fallback", async () => {
    fetchSpy.mockResolvedValueOnce(json(200, removeResult({ next: { source: 'managed', keyLast4: null } })));

    await byokRemove({ provider: 'anthropic' });

    expect(stdoutLines()).toEqual([
      "✓ Removed anthropic key from app app1. The next deploy uses the platform's managed key.",
    ]);
  });

  it('says so when nothing was stored', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, removeResult({ removed: false })));

    await byokRemove({ provider: 'anthropic' });

    expect(stdoutLines()).toEqual(['✓ No anthropic key was stored on app app1. Nothing to remove.']);
  });

  it('--workspace DELETEs on the workspace and names it', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, removeResult({ provider: 'openai', tier: 'workspace' })));

    await byokRemove({ provider: 'openai', workspace: 'acme' });

    expect(onlyRequest()).toEqual({
      path: '/workspaces/acme/keys/providers/openai',
      method: 'DELETE',
      body: undefined,
    });
    expect(stdoutLines()).toEqual([
      "✓ Removed openai key from workspace acme. Its apps fall back on their next deploy.",
    ]);
  });

  it('requires --provider', async () => {
    await expect(byokRemove({ 'app-id': 'app1' })).rejects.toThrow(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrLines()).toEqual(['✗ Missing --provider. Use: guuey byok remove --provider <id> --app-id <id>']);
  });

  it('refuses --app-id together with --workspace', async () => {
    await expect(byokRemove({ provider: 'anthropic', 'app-id': 'app1', workspace: 'acme' })).rejects.toThrow(
      ExitSignal,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('encodes a provider id that is not a path segment as is', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, removeResult({ provider: 'a/b' })));

    await byokRemove({ provider: 'a/b', 'app-id': 'app1' });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://api.guuey.test/apps/app1/keys/providers/a%2Fb');
  });
});
