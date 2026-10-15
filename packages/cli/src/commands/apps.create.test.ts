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

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitSignal(typeof code === 'number' ? code : undefined);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(saveConfig).mockClear();
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
