/**
 * `guuey eject` — the one-way switch from a declarative app to code mode.
 *
 * The pure helpers are pinned directly; the flow drives the real `eject()`
 * with the scaffold, `pull` and `deploy` stubbed, so each case reads which
 * steps ran, in what order, and what reached the platform.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  eject,
  ejectDirName,
  ejectDirState,
  ejectFramework,
  ejectOutcomeLine,
  ejectQuestion,
  resolveEjectConfirmation,
} from './eject.js';
import { resolveConfig } from '../config.js';

const steps = vi.hoisted(() => ({ log: [] as string[], gguiAtDeploy: [] as boolean[] }));

vi.mock('@guuey/create-agentic-app', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guuey/create-agentic-app')>();
  return {
    ...actual,
    // Like the real scaffold: the directory, bound to the app, with the
    // template's ggui block.
    scaffold: vi.fn(async (opts: { targetDir: string; framework: string; template: string; appId?: string }) => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.mkdirSync(opts.targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(opts.targetDir, 'guuey.json'),
        JSON.stringify({
          schema: '1',
          appId: opts.appId,
          agent: { mode: 'code', framework: opts.framework },
          ggui: { configFile: './ggui/ggui.json' },
        }),
      );
      steps.log.push(`scaffold ${opts.template} ${opts.framework} ${opts.appId ?? ''}`);
    }),
  };
});

vi.mock('./pull.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pull.js')>();
  return {
    ...actual,
    pull: vi.fn(async (flags: Record<string, string | true>) => {
      steps.log.push(`pull ${String(flags['app-id'])}`);
    }),
  };
});

vi.mock('./deploy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deploy.js')>();
  return {
    ...actual,
    deploy: vi.fn(async (flags: Record<string, string | true>, opts: { allowNocodeToCode?: boolean }) => {
      // What the real deploy would read: does the project still carry a ggui block?
      const fs = await import('node:fs');
      const doc = JSON.parse(fs.readFileSync('guuey.json', 'utf8')) as { ggui?: object };
      steps.gguiAtDeploy.push(doc.ggui !== undefined);
      steps.log.push(`deploy app-id=${String(flags['app-id'])} allowNocodeToCode=${String(opts.allowNocodeToCode)}`);
    }),
  };
});

vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return { ...actual, requireAuth: vi.fn(() => ({ pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' })) };
});

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, resolveConfig: vi.fn(), loadProjectConfig: vi.fn(() => null), loadConfig: vi.fn(() => ({})) };
});

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

describe('eject helpers', () => {
  it('the question names the app and why the switch cannot be undone', () => {
    const q = ejectQuestion('app-1');
    expect(q).toContain('Switch app app-1 to code mode? This cannot be undone:');
    expect(q).toContain("guuey can no longer update this app's runtime");
    expect(q).toContain('guuey agent apply, the console and Studio can no longer publish to it.');
    expect(q.endsWith('Eject? [y/N] ')).toBe(true);
  });

  it('confirmation: --yes skips, a terminal (both ends) asks, anything else refuses', () => {
    expect(resolveEjectConfirmation({ yes: true, stdinIsTTY: undefined, stdoutIsTTY: undefined })).toBe('skip');
    expect(resolveEjectConfirmation({ yes: false, stdinIsTTY: true, stdoutIsTTY: true })).toBe('prompt');
    expect(resolveEjectConfirmation({ yes: false, stdinIsTTY: true, stdoutIsTTY: undefined })).toBe('refuse');
    expect(resolveEjectConfirmation({ yes: false, stdinIsTTY: undefined, stdoutIsTTY: true })).toBe('refuse');
  });

  it('the default directory is the app name as an npm-safe slug, else my-agent', () => {
    expect(ejectDirName('Support Bot (EU)')).toBe('support-bot-eu');
    expect(ejectDirName('  --')).toBe('my-agent');
    expect(ejectDirName(null)).toBe('my-agent');
    expect(ejectDirName(undefined)).toBe('my-agent');
  });

  it('the framework: the flag, else the live one, else claude-agent-sdk; null for one with no code template', () => {
    expect(ejectFramework('google-adk', 'openai-agents-sdk')).toBe('google-adk');
    expect(ejectFramework(undefined, 'openai-agents-sdk')).toBe('openai-agents-sdk');
    expect(ejectFramework(undefined, undefined)).toBe('claude-agent-sdk');
    expect(ejectFramework('vanilla', undefined)).toBeNull();
    expect(ejectFramework(undefined, 'langgraph')).toBeNull();
  });

  it("the directory: missing or empty is fresh; this app's code project resumes; anything else is occupied", () => {
    expect(ejectDirState(false, [], null, 'app-1')).toBe('fresh');
    expect(ejectDirState(true, [], null, 'app-1')).toBe('fresh');
    expect(ejectDirState(true, ['guuey.json'], { appId: 'app-1', agent: { mode: 'code' } }, 'app-1')).toBe('resume');
    expect(ejectDirState(true, ['guuey.json'], { appId: 'app-2', agent: { mode: 'code' } }, 'app-1')).toBe('occupied');
    expect(ejectDirState(true, ['guuey.json'], { appId: 'app-1' }, 'app-1')).toBe('occupied');
    expect(ejectDirState(true, ['notes.txt'], null, 'app-1')).toBe('occupied');
  });

  it('the outcome line reads the serving build', () => {
    expect(ejectOutcomeLine('code', 'app-1', '/w/bot')).toBe(
      '  App app-1 is in code mode. Your project is /w/bot; redeploy it with guuey deploy.',
    );
    // deploy returns without Live only when its client wait ran out: the
    // build goes on, so the line says to watch it, never to run eject again.
    for (const live of ['nocode', null] as const) {
      const line = ejectOutcomeLine(live, 'app-1', '/w/bot');
      expect(line).toContain("App app-1's code build is not live yet: it is still deploying");
      expect(line).toContain('Watch "guuey deployments list"; do not run eject again.');
      expect(line).not.toMatch(/retry/);
    }
  });
});

describe('eject() — the flow', () => {
  let dir: string;
  let originalCwd: string;
  let fetchSpy: MockInstance<typeof fetch>;
  let errSpy: MockInstance<typeof console.error>;
  let logSpy: MockInstance<typeof console.log>;

  type Row = { buildNumber: number; status: string; agentMode: 'code' | 'nocode' };

  /** The platform: deployments before the deploy, then after it; the app; the snapshot's framework. */
  function mockPlatform(opts: { before: Row[]; after?: Row[]; framework?: string }): void {
    let deploymentReads = 0;
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/apps/app-1/deployments')) {
        deploymentReads += 1;
        const rows = deploymentReads === 1 ? opts.before : (opts.after ?? opts.before);
        return new Response(JSON.stringify({ deployments: rows }), { status: 200 });
      }
      if (url.endsWith('/apps/app-1')) {
        return new Response(JSON.stringify({ app: { id: 'app-1', displayName: 'Support Bot' } }), { status: 200 });
      }
      if (/\/apps\/app-1\/deployments\/\d+$/.test(url)) {
        return new Response(JSON.stringify({ snapshot: { schema: '1', agent: { framework: opts.framework } } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  const NOCODE_LIVE: Row[] = [{ buildNumber: 4, status: 'live', agentMode: 'nocode' }];
  const CODE_LIVE: Row[] = [
    { buildNumber: 5, status: 'live', agentMode: 'code' },
    { buildNumber: 4, status: 'superseded', agentMode: 'nocode' },
  ];

  function printedErr(): string {
    return errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
  }
  function printedLog(): string {
    return logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
  }

  beforeEach(() => {
    steps.log = [];
    steps.gguiAtDeploy = [];
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'eject-test-'));
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({ host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test' });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('without --app-id it refuses before any network call, even with a global default', async () => {
    vi.mocked(resolveConfig).mockReturnValue({ host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test', appId: 'app-1' });
    await expect(eject({ yes: true })).rejects.toBeInstanceOf(ExitSignal);
    expect(printedErr()).toContain('guuey eject --app-id <id>');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('★ --yes: scaffolds base for the live framework, pulls, deploys with the eject bypass, then names code mode', async () => {
    mockPlatform({ before: NOCODE_LIVE, after: CODE_LIVE, framework: 'openai-agents-sdk' });
    await eject({ 'app-id': 'app-1', yes: true });
    expect(steps.log).toEqual([
      'scaffold base openai-agents-sdk app-1',
      'pull app-1',
      'deploy app-id=app-1 allowNocodeToCode=true',
    ]);
    expect(process.cwd()).toMatch(/support-bot$/);
    expect(printedLog()).toContain('App app-1 is in code mode.');
  });

  it("★ the template's ggui block is left out, so the deploy's full-state asset push never wipes the app's assets", async () => {
    mockPlatform({ before: NOCODE_LIVE, after: CODE_LIVE, framework: 'claude-agent-sdk' });
    await eject({ 'app-id': 'app-1', yes: true });
    const written = JSON.parse(readFileSync(join(process.cwd(), 'guuey.json'), 'utf8')) as { appId?: string; ggui?: unknown };
    expect(written.appId).toBe('app-1');
    expect(written.ggui).toBeUndefined();
    expect(steps.gguiAtDeploy).toEqual([false]);
    expect(printedLog()).toContain('Took the ggui block out of guuey.json');
  });

  it('--framework overrides the live definition', async () => {
    mockPlatform({ before: NOCODE_LIVE, after: CODE_LIVE, framework: 'openai-agents-sdk' });
    await eject({ 'app-id': 'app-1', yes: true, framework: 'google-adk' });
    expect(steps.log[0]).toBe('scaffold base google-adk app-1');
  });

  it('a framework with no code template refuses before any confirmation or scaffold', async () => {
    mockPlatform({ before: NOCODE_LIVE, framework: 'langgraph' });
    await expect(eject({ 'app-id': 'app-1', yes: true })).rejects.toBeInstanceOf(ExitSignal);
    expect(printedErr()).toContain('"langgraph" has no code template');
    expect(steps.log).toEqual([]);
  });

  it('★ without a terminal and without --yes it refuses: nothing is scaffolded or deployed', async () => {
    mockPlatform({ before: NOCODE_LIVE, framework: 'claude-agent-sdk' });
    await expect(eject({ 'app-id': 'app-1' })).rejects.toBeInstanceOf(ExitSignal);
    expect(printedErr()).toContain('Refusing to switch app app-1 to code mode without confirmation');
    expect(printedErr()).toContain('pass --yes to confirm');
    expect(steps.log).toEqual([]);
  });

  it('an app already in code mode is refused', async () => {
    mockPlatform({ before: CODE_LIVE });
    await expect(eject({ 'app-id': 'app-1', yes: true })).rejects.toBeInstanceOf(ExitSignal);
    expect(printedErr()).toContain('App app-1 is already in code mode.');
    expect(steps.log).toEqual([]);
  });

  it('an app with nothing live is refused, naming the scaffold that starts it as code', async () => {
    mockPlatform({ before: [] });
    await expect(eject({ 'app-id': 'app-1', yes: true })).rejects.toBeInstanceOf(ExitSignal);
    expect(printedErr()).toContain('has no live no-code build to eject');
    expect(printedErr()).toContain('--app app-1');
    expect(steps.log).toEqual([]);
  });

  it('a non-empty directory that is not this app\'s code project is refused', async () => {
    mockPlatform({ before: NOCODE_LIVE, framework: 'claude-agent-sdk' });
    mkdirSync(join(dir, 'taken'));
    writeFileSync(join(dir, 'taken', 'notes.txt'), 'mine');
    await expect(eject({ 'app-id': 'app-1', yes: true, dir: 'taken' })).rejects.toBeInstanceOf(ExitSignal);
    expect(printedErr()).toContain('is not empty');
    expect(steps.log).toEqual([]);
  });

  // A run that died between its scaffold and its pull leaves exactly this
  // project; resuming without the pull would deploy the template's agent.
  it("★ re-running on this app's code project skips the scaffold and pulls again before the deploy", async () => {
    mockPlatform({ before: NOCODE_LIVE, after: CODE_LIVE });
    mkdirSync(join(dir, 'bot'));
    writeFileSync(join(dir, 'bot', 'guuey.json'), JSON.stringify({ schema: '1', appId: 'app-1', agent: { mode: 'code' } }));
    await eject({ 'app-id': 'app-1', yes: true, dir: 'bot' });
    expect(steps.log).toEqual(['pull app-1', 'deploy app-id=app-1 allowNocodeToCode=true']);
    expect(printedLog()).toContain('Resuming in');
  });

  // A fresh run that died between its scaffold and the ggui drop leaves the
  // template's block in a project that reads as a resume; the resumed deploy
  // must not push it over the console's assets.
  it("★ a resume whose project still carries a ggui block drops it before the deploy", async () => {
    mockPlatform({ before: NOCODE_LIVE, after: CODE_LIVE });
    mkdirSync(join(dir, 'bot'));
    writeFileSync(
      join(dir, 'bot', 'guuey.json'),
      JSON.stringify({ schema: '1', appId: 'app-1', agent: { mode: 'code' }, ggui: { configFile: './ggui/ggui.json' } }),
    );
    await eject({ 'app-id': 'app-1', yes: true, dir: 'bot' });
    expect(steps.gguiAtDeploy).toEqual([false]);
    expect(JSON.parse(readFileSync(join(dir, 'bot', 'guuey.json'), 'utf8'))).not.toHaveProperty('ggui');
    expect(printedLog()).toContain('Took the ggui block out of guuey.json');
  });

  it('a deploy whose wait ran out says it is still deploying, and not to run eject again', async () => {
    mockPlatform({ before: NOCODE_LIVE, after: NOCODE_LIVE, framework: 'claude-agent-sdk' });
    await eject({ 'app-id': 'app-1', yes: true });
    expect(printedLog()).toContain("App app-1's code build is not live yet: it is still deploying");
  });

  // GUUEY_APP_ID re-targets a bound project for a plain deploy (guuey#975); the
  // app eject switches must be the app its question named.
  it('★ the deploy names the asked app explicitly, so GUUEY_APP_ID can never re-target the switch', async () => {
    vi.stubEnv('GUUEY_APP_ID', 'app-other');
    mockPlatform({ before: NOCODE_LIVE, after: CODE_LIVE, framework: 'claude-agent-sdk' });
    await eject({ 'app-id': 'app-1', yes: true });
    expect(steps.log.at(-1)).toBe('deploy app-id=app-1 allowNocodeToCode=true');
    vi.unstubAllEnvs();
  });
});
