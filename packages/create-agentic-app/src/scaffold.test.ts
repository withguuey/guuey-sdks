import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_BUILT_FOR, safeParseGuueyJson, type AppBuiltFor } from '@guuey/config';
import { scaffold, type ScaffoldBuiltFor } from './scaffold.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '__fixtures__', 'templates');

describe('scaffold', () => {
  it('copies the tree, renames, seeds .env.local, refuses non-empty without force', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-'));
    const { projectDir } = await scaffold({
      targetDir: target,
      name: 'demo',
      framework: 'claude-agent-sdk',
      git: false,
      templatesDir: fixturesDir,
    });
    const pkg = JSON.parse(await fs.readFile(join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('demo');
    await expect(fs.stat(join(projectDir, '.env.local'))).resolves.toBeTruthy();
    await expect(
      scaffold({
        targetDir: target,
        name: 'demo',
        framework: 'claude-agent-sdk',
        git: false,
        templatesDir: fixturesDir,
      })
    ).rejects.toThrow(/not empty/i);
  });

  it('rejects invalid npm names', async () => {
    await expect(
      scaffold({
        targetDir: 'x',
        name: 'Bad Name!',
        framework: 'claude-agent-sdk',
        templatesDir: fixturesDir,
      })
    ).rejects.toThrow(/name/i);
  });

  it('overwrites into a non-empty target when force is set', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-force-'));
    await fs.writeFile(join(target, 'existing.txt'), 'hi');
    const { projectDir } = await scaffold({
      targetDir: target,
      name: 'demo2',
      framework: 'claude-agent-sdk',
      git: false,
      force: true,
      templatesDir: fixturesDir,
    });
    const pkg = JSON.parse(await fs.readFile(join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('demo2');
  });

  it('throws a clear error naming available frameworks when the template dir is missing', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-missing-'));
    await expect(
      scaffold({
        targetDir: target,
        name: 'demo3',
        // fixturesDir only has a claude-agent-sdk template, so this framework is absent
        framework: 'openai-agents-sdk',
        git: false,
        templatesDir: fixturesDir,
      })
    ).rejects.toThrow(/claude-agent-sdk/);
  });

  it('initializes a git repo with an initial commit when git is enabled', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-git-'));
    const { projectDir } = await scaffold({
      targetDir: target,
      name: 'demo-git',
      framework: 'claude-agent-sdk',
      git: true,
      templatesDir: fixturesDir,
    });
    const gitDir = await fs.stat(join(projectDir, '.git'));
    expect(gitDir.isDirectory()).toBe(true);
    const { stdout } = await execFileAsync('git', ['log', '--oneline'], { cwd: projectDir });
    expect(stdout).toMatch(/chore: scaffold/);
  });

  it('scaffolds successfully when git is unavailable (git init is non-fatal)', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-nogit-'));
    const originalPath = process.env.PATH;
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Empty PATH → spawning `git` fails with ENOENT, AFTER files are written —
      // exactly the fresh-CI/container failure mode git init must survive.
      process.env.PATH = '';
      const { projectDir } = await scaffold({
        targetDir: target,
        name: 'demo-nogit',
        framework: 'claude-agent-sdk',
        git: true,
        templatesDir: fixturesDir,
      });
      const pkg = JSON.parse(await fs.readFile(join(projectDir, 'package.json'), 'utf8'));
      expect(pkg.name).toBe('demo-nogit');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/git init/));
    } finally {
      process.env.PATH = originalPath;
      warn.mockRestore();
    }
  });
});

describe('scaffold --app binding (guuey#580 point 4)', () => {
  it('stamps top-level appId into guuey.json — the key bootstrap --link defaults from', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-app-'));
    const { projectDir } = await scaffold({
      targetDir: target,
      name: 'bound',
      framework: 'claude-agent-sdk',
      git: false,
      templatesDir: fixturesDir,
      appId: 'app_tada123',
    });
    const guuey = JSON.parse(await fs.readFile(join(projectDir, 'guuey.json'), 'utf8'));
    expect(guuey.appId).toBe('app_tada123');
    // The rest of the manifest survives the read-modify-write untouched.
    expect(guuey.agent.framework).toBe('claude-agent-sdk');
  });

  it('without --app the manifest carries NO appId key (absent, not empty)', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-noapp-'));
    const { projectDir } = await scaffold({
      targetDir: target,
      name: 'unbound',
      framework: 'claude-agent-sdk',
      git: false,
      templatesDir: fixturesDir,
    });
    const guuey = JSON.parse(await fs.readFile(join(projectDir, 'guuey.json'), 'utf8'));
    expect('appId' in guuey).toBe(false);
  });
});

describe('scaffold builtFor — who the agent is for (guuey#1670)', () => {
  it('stamps app.builtFor into guuey.json and keeps the rest of the manifest', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-for-'));
    const { projectDir } = await scaffold({
      targetDir: target,
      name: 'mine',
      framework: 'claude-agent-sdk',
      git: false,
      templatesDir: fixturesDir,
      builtFor: 'personal',
    });
    const raw: unknown = JSON.parse(await fs.readFile(join(projectDir, 'guuey.json'), 'utf8'));
    const parsed = safeParseGuueyJson(raw);
    // The stamped manifest is one the CLI's own loader accepts.
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.app?.builtFor).toBe('personal');
    expect(parsed.data.agent.framework).toBe('claude-agent-sdk');
    expect(parsed.data.appId).toBeUndefined();
  });

  it('composes with --app: both stamps land in one write', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-for-app-'));
    const { projectDir } = await scaffold({
      targetDir: target,
      name: 'theirs',
      framework: 'claude-agent-sdk',
      template: 'agent',
      git: false,
      templatesDir: fixturesDir,
      appId: 'app_for1',
      builtFor: 'customers',
    });
    const guuey = JSON.parse(await fs.readFile(join(projectDir, 'guuey.json'), 'utf8'));
    expect(guuey.appId).toBe('app_for1');
    expect(guuey.app).toEqual({ builtFor: 'customers' });
  });

  it('without builtFor the manifest carries NO app key: absent, never a guessed default', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-nofor-'));
    const { projectDir } = await scaffold({
      targetDir: target,
      name: 'unasked',
      framework: 'claude-agent-sdk',
      git: false,
      templatesDir: fixturesDir,
    });
    const guuey = JSON.parse(await fs.readFile(join(projectDir, 'guuey.json'), 'utf8'));
    expect('app' in guuey).toBe(false);
  });

  it("ScaffoldBuiltFor is exactly @guuey/config's APP_BUILT_FOR (the restated list cannot drift)", () => {
    const restated: readonly ScaffoldBuiltFor[] = ['personal', 'customers'];
    expect([...restated].sort()).toEqual([...APP_BUILT_FOR].sort());
    // And type-level, both directions: each list's members are assignable to the other.
    const toConfig: readonly AppBuiltFor[] = restated;
    const fromConfig: readonly ScaffoldBuiltFor[] = APP_BUILT_FOR;
    expect(toConfig.length).toBe(fromConfig.length);
  });
});

describe('manage-only template (guuey#581 point 5)', () => {
  it('--template agent resolves the FLAT frameworkless layout and scaffolds prompt + manifest', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-agent-'));
    const { projectDir } = await scaffold({
      targetDir: target,
      name: 'my-agent',
      framework: 'claude-agent-sdk', // irrelevant for agent — resolver never consults it
      template: 'agent',
      git: false,
      templatesDir: fixturesDir,
      appId: 'app_manage1',
    });
    const guuey = JSON.parse(await fs.readFile(join(projectDir, 'guuey.json'), 'utf8'));
    expect(guuey.agent.mode).toBe('declarative');
    expect(guuey.appId).toBe('app_manage1'); // --app composes with the persona split
    const pkg = JSON.parse(await fs.readFile(join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('my-agent'); // the rename token resolves here too
    await expect(fs.stat(join(projectDir, 'prompts', 'system.md'))).resolves.toBeTruthy();
  });
});
