/**
 * `guuey apps create --for personal|customers` (guuey#1670): who the agent is
 * for rides `POST /v1/apps` as `builtFor`, and the stored value is echoed back
 * in the console's words.
 *
 * Mocking mirrors `apps.test.ts` (`requireAuth` + `resolveConfig` mocked,
 * `globalThis.fetch` spied), plus two mocks that file never needed:
 * `isLoggedIn` answers true so `login()` (a browser) is never reached, and
 * `saveConfig` is a spy, so a test run never writes the operator's real
 * `~/.guuey/config.json`.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { appsCreate } from './apps.js';
import { saveConfig } from '../config.js';

vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return {
    ...actual,
    isLoggedIn: vi.fn(() => true),
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
    })),
    loadConfig: vi.fn(() => ({})),
    saveConfig: vi.fn(),
  };
});

vi.mock('./login.js', () => ({
  login: vi.fn(() => {
    throw new Error('login() must not run in this test');
  }),
}));

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let fetchSpy: MockInstance<typeof fetch>;
let logSpy: MockInstance<typeof console.log>;
let errSpy: MockInstance<typeof console.error>;

function created(app: { id: string; displayName: string; builtFor?: string }): Response {
  return new Response(JSON.stringify({ app }), { status: 201 });
}

function sentBody(): unknown {
  const [, init] = fetchSpy.mock.calls.at(-1)!;
  return JSON.parse(String(init?.body));
}

function printed(spy: MockInstance<typeof console.log>): string {
  return spy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
}

// Every test runs in a fresh empty directory, so no guuey.json up the real
// tree decides where the app id goes (guuey#3263 binds into one when present).
let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'guuey-apps-create-')));
  process.chdir(workDir);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitSignal(typeof code === 'number' ? code : undefined);
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.mocked(saveConfig).mockClear();
});

describe('guuey apps create binds the new app into the project guuey.json (guuey#3263)', () => {
  const guueyJson = (): string => join(workDir, 'guuey.json');
  const readGuueyJson = (): { appId?: string; app?: { builtFor?: string }; agent?: { framework?: string } } =>
    JSON.parse(readFileSync(guueyJson(), 'utf-8'));

  it('inside a project with no appId: the id is written to guuey.json, the global default is untouched, and the line says so', async () => {
    writeFileSync(guueyJson(), JSON.stringify({ schema: '1', agent: { framework: 'claude-agent-sdk' } }));
    fetchSpy.mockResolvedValue(created({ id: 'app-b', displayName: 'Bound' }));

    await appsCreate({ name: 'Bound' });

    expect(readGuueyJson()).toMatchObject({ appId: 'app-b', agent: { framework: 'claude-agent-sdk' } });
    expect(saveConfig).not.toHaveBeenCalled();
    const out = printed(logSpy);
    expect(out).toContain(`appId saved to ${guueyJson()}`);
    expect(out).toContain('guuey agent apply and guuey deploy read it');
    expect(out).not.toContain('~/.guuey/config.json');
  });

  it('--for is bound into the project too, beside the appId', async () => {
    writeFileSync(guueyJson(), JSON.stringify({ schema: '1', agent: {} }));
    fetchSpy.mockResolvedValue(created({ id: 'app-f', displayName: 'Mine', builtFor: 'personal' }));

    await appsCreate({ name: 'Mine', for: 'personal' });

    expect(readGuueyJson()).toMatchObject({ appId: 'app-f', app: { builtFor: 'personal' } });
  });

  it('a project already bound to another app keeps its binding, nothing is saved, and the line names both ids', async () => {
    const before = JSON.stringify({ schema: '1', appId: 'app-old', agent: {} });
    writeFileSync(guueyJson(), before);
    fetchSpy.mockResolvedValue(created({ id: 'app-new', displayName: 'Second' }));

    await appsCreate({ name: 'Second' });

    expect(readFileSync(guueyJson(), 'utf-8')).toBe(before);
    expect(saveConfig).not.toHaveBeenCalled();
    const out = printed(logSpy);
    expect(out).toContain('stays bound to app app-old');
    expect(out).toContain('--app-id app-new');
  });

  it('a guuey.json that does not parse is left alone; the id goes to the global default and the line names the file', async () => {
    writeFileSync(guueyJson(), '{ not json');
    fetchSpy.mockResolvedValue(created({ id: 'app-u', displayName: 'Broken' }));

    await appsCreate({ name: 'Broken' });

    expect(readFileSync(guueyJson(), 'utf-8')).toBe('{ not json');
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-u' }));
    expect(printed(logSpy)).toContain(`${guueyJson()} could not be read as a guuey.json`);
  });

  it('outside a project the global default is set, as before', async () => {
    fetchSpy.mockResolvedValue(created({ id: 'app-g', displayName: 'Loose' }));

    await appsCreate({ name: 'Loose' });

    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-g' }));
    expect(printed(logSpy)).toContain('Auto-configured: app-id saved to ~/.guuey/config.json');
  });

  it('--json carries savedTo: the guuey.json path when bound, null when a bound project kept its app', async () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    writeFileSync(guueyJson(), JSON.stringify({ schema: '1', agent: {} }));
    fetchSpy.mockResolvedValue(created({ id: 'app-j', displayName: 'J' }));

    await appsCreate({ name: 'J', json: true });

    const text = (): string =>
      [...outSpy.mock.calls.map((c) => String(c[0])), ...logSpy.mock.calls.map((c) => String(c[0]))].join('');
    expect(JSON.parse(text())).toMatchObject({ appId: 'app-j', savedTo: guueyJson() });

    outSpy.mockClear();
    logSpy.mockClear();
    fetchSpy.mockResolvedValue(created({ id: 'app-k', displayName: 'K' }));
    await appsCreate({ name: 'K', json: true });
    expect(JSON.parse(text())).toMatchObject({ appId: 'app-k', savedTo: null });
  });
});

describe('guuey apps create --for (guuey#1670)', () => {
  it('--for personal sends builtFor and prints the stored answer in the console words', async () => {
    fetchSpy.mockResolvedValue(created({ id: 'app-p', displayName: 'Mine', builtFor: 'personal' }));

    await appsCreate({ name: 'Mine', for: 'personal' });

    const [url, init] = fetchSpy.mock.calls.at(-1)!;
    expect(new URL(String(url)).pathname).toBe('/apps');
    expect(init?.method).toBe('POST');
    expect(sentBody()).toEqual({ displayName: 'Mine', builtFor: 'personal' });
    expect(printed(logSpy)).toContain('Built for: Just for me');
  });

  it('--for customers sends builtFor: customers', async () => {
    fetchSpy.mockResolvedValue(created({ id: 'app-c', displayName: 'Rep', builtFor: 'customers' }));

    await appsCreate({ name: 'Rep', for: 'customers' });

    expect(sentBody()).toEqual({ displayName: 'Rep', builtFor: 'customers' });
    expect(printed(logSpy)).toContain('Built for: For my customers');
  });

  it('without --for the create sends NO builtFor key (N-1: the server reads customers)', async () => {
    fetchSpy.mockResolvedValue(created({ id: 'app-n', displayName: 'Plain' }));

    await appsCreate({ name: 'Plain' });

    expect(sentBody()).toEqual({ displayName: 'Plain' });
    // A server from before the field echoes none: no line, never a guessed one.
    expect(printed(logSpy)).not.toContain('Built for');
  });

  it('an unknown --for exits 1 naming both values, before any request', async () => {
    await expect(appsCreate({ name: 'X', for: 'team' })).rejects.toBeInstanceOf(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    const err = printed(errSpy);
    expect(err).toContain('Unknown --for "team"');
    expect(err).toContain('--for personal');
    expect(err).toContain('--for customers');
  });

  it('a valueless --for exits 1, before any request', async () => {
    await expect(appsCreate({ name: 'X', for: true })).rejects.toBeInstanceOf(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(printed(errSpy)).toContain('--for needs a value');
  });
});

describe('guuey apps create --workspace / --personal (guuey#2306)', () => {
  const team = { kind: 'workspace', workspaceId: 'ws-team', name: 'Team', slug: 'team' } as const;

  function createdWith(body: object): Response {
    return new Response(JSON.stringify(body), { status: 201 });
  }

  beforeEach(() => {
    vi.stubEnv('GUUEY_WORKSPACE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('--workspace sends `workspace` and prints the owning workspace by name and id', async () => {
    fetchSpy.mockResolvedValue(
      createdWith({ app: { id: 'app-w', displayName: 'team-dev', ownerKind: 'workspace', workspaceId: 'ws-team' }, owner: team }),
    );

    await appsCreate({ name: 'team-dev', workspace: 'team' });

    expect(sentBody()).toEqual({ displayName: 'team-dev', workspace: 'team' });
    expect(printed(logSpy)).toContain('Workspace: Team (ws-team)');
    expect(saveConfig).toHaveBeenCalled();
  });

  it('$GUUEY_WORKSPACE is the default when no flag is given, and the line says where it came from', async () => {
    vi.stubEnv('GUUEY_WORKSPACE', 'ws-team');
    fetchSpy.mockResolvedValue(
      createdWith({ app: { id: 'app-w', displayName: 'team-dev', ownerKind: 'workspace', workspaceId: 'ws-team' }, owner: team }),
    );

    await appsCreate({ name: 'team-dev' });

    expect(sentBody()).toEqual({ displayName: 'team-dev', workspace: 'ws-team' });
    expect(printed(logSpy)).toContain('Workspace: Team (ws-team), from $GUUEY_WORKSPACE');
  });

  it('--personal wins over $GUUEY_WORKSPACE and sends no workspace', async () => {
    vi.stubEnv('GUUEY_WORKSPACE', 'ws-team');
    fetchSpy.mockResolvedValue(
      createdWith({ app: { id: 'app-p', displayName: 'Mine', ownerKind: 'user' }, owner: { kind: 'personal', workspaceId: 'pw-1' } }),
    );

    await appsCreate({ name: 'Mine', personal: true });

    expect(sentBody()).toEqual({ displayName: 'Mine' });
    expect(printed(logSpy)).toContain('Workspace: personal (pw-1)');
  });

  it('with neither, the success line still names the owner (personal)', async () => {
    fetchSpy.mockResolvedValue(
      createdWith({ app: { id: 'app-p', displayName: 'Mine', ownerKind: 'user' }, owner: { kind: 'personal', workspaceId: 'pw-1' } }),
    );

    await appsCreate({ name: 'Mine' });

    expect(sentBody()).toEqual({ displayName: 'Mine' });
    expect(printed(logSpy)).toContain('Workspace: personal (pw-1)');
  });

  it('--json carries the owner', async () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    fetchSpy.mockResolvedValue(
      createdWith({ app: { id: 'app-w', displayName: 'team-dev', ownerKind: 'workspace', workspaceId: 'ws-team' }, owner: team }),
    );

    await appsCreate({ name: 'team-dev', workspace: 'ws-team', json: true });

    const json = [...outSpy.mock.calls.map((c) => String(c[0])), ...logSpy.mock.calls.map((c) => String(c[0]))].join('');
    expect(JSON.parse(json)).toMatchObject({ appId: 'app-w', owner: team });
  });

  it('N-1: a server that IGNORED --workspace (no `owner` in its answer) is a loud exit 1, never a success line, and the app id is not saved', async () => {
    fetchSpy.mockResolvedValue(createdWith({ app: { id: 'app-x', displayName: 'team-dev', ownerKind: 'user' } }));

    await expect(appsCreate({ name: 'team-dev', workspace: 'team' })).rejects.toBeInstanceOf(ExitSignal);

    const err = printed(errSpy);
    expect(err).toContain('app-x');
    expect(err).toContain('PERSONAL');
    expect(err).toContain('guuey apps delete app-x');
    expect(printed(logSpy)).not.toContain('Created app');
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('N-1: an old server answering a plain create with no `owner` still names the owner from the app (personal)', async () => {
    fetchSpy.mockResolvedValue(createdWith({ app: { id: 'app-p', displayName: 'Mine', ownerKind: 'user' } }));

    await appsCreate({ name: 'Mine' });

    expect(printed(logSpy)).toContain('Workspace: personal');
  });

  it('--workspace with --personal exits 1 before any request', async () => {
    await expect(appsCreate({ name: 'X', workspace: 'team', personal: true })).rejects.toBeInstanceOf(ExitSignal);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(printed(errSpy)).toContain('--workspace and --personal');
  });

  it('a valueless --workspace exits 1 before any request', async () => {
    await expect(appsCreate({ name: 'X', workspace: true })).rejects.toBeInstanceOf(ExitSignal);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(printed(errSpy)).toContain('--workspace needs a value');
  });
});
