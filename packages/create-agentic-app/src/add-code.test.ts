/**
 * guuey#3276 — addCode converts a `--template agent` project in place. These
 * cases run the real scaffold and the real assembled templates
 * (`dist/templates`, like assembly.test.ts), so a converted project is
 * checked against what a fresh code scaffold ships.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseGuueyJson } from '@guuey/config';
import { AddCodeError, addCode, workspaceSettingsOnly } from './add-code.js';
import { scaffold, type Framework } from './scaffold.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist', 'templates');
const PNPM = { file: 'pnpm', prefix: [] } as const;
const FRAMEWORKS: readonly Framework[] = ['claude-agent-sdk', 'openai-agents-sdk', 'google-adk'];

/** The top-level keys of a YAML file (lines that start a mapping key at column 0). */
function topLevelYamlKeys(text: string): string[] {
  return text.split('\n').flatMap((line) => /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line)?.[1] ?? []);
}

let root: string;
let project: string;

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, 'utf8')) as T;
}

/** The console's export path: a declarative project born bound to app-1. */
async function agentProject(): Promise<string> {
  await scaffold({
    targetDir: project,
    name: 'my-agent',
    framework: 'claude-agent-sdk',
    template: 'agent',
    appId: 'app-1',
    install: false,
    git: false,
    pnpm: PNPM,
  });
  return project;
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'caa-add-code-'));
  project = join(root, 'my-agent');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('addCode (guuey#3276)', () => {
  it.each(FRAMEWORKS)('%s: the worker lands beside the definition and guuey.json reads code', async (framework) => {
    await agentProject();
    const before = await readJson<{ agent: { systemPrompt: unknown; model?: string }; appId: string }>(
      join(project, 'guuey.json'),
    );

    const result = await addCode({ projectDir: project, framework, pnpm: PNPM });

    // The worker's files are the fresh code scaffold's, byte for byte.
    const templateDir = join(dist, 'base', framework);
    for (const rel of ['tsup.config.ts', 'tsconfig.json']) {
      expect(await fs.readFile(join(project, rel), 'utf8')).toBe(await fs.readFile(join(templateDir, rel), 'utf8'));
    }
    for (const rel of await fs.readdir(join(templateDir, 'src'))) {
      expect(await fs.readFile(join(project, 'src', rel), 'utf8')).toBe(
        (await fs.readFile(join(templateDir, 'src', rel), 'utf8')).replaceAll('agentic-app-template', 'my-agent'),
      );
    }

    // guuey.json: code, the framework, the template's worker entry; the definition and binding kept.
    const raw = await readJson<{ appId: string; worker?: string; agent: { mode: string; framework: string; entry?: string; systemPrompt: unknown; model?: string } }>(
      join(project, 'guuey.json'),
    );
    expect(safeParseGuueyJson(raw).success).toBe(true);
    expect(raw.agent.mode).toBe('code');
    expect(raw.agent.framework).toBe(framework);
    expect(raw.appId).toBe('app-1');
    expect(raw.agent.systemPrompt).toEqual(before.agent.systemPrompt);
    expect(raw.agent.model).toBe(before.agent.model);
    const templateManifest = await readJson<{ worker?: string; agent: { entry?: string } }>(join(templateDir, 'guuey.json'));
    expect(raw.worker).toBe(templateManifest.worker);
    expect(raw.agent.entry).toBe(templateManifest.agent.entry);
    expect(result.changed.at(-1)).toBe('guuey.json');

    // package.json: the worker's dependencies and build; the CLI pin and the agent scripts kept.
    const pkg = await readJson<{ scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> }>(
      join(project, 'package.json'),
    );
    const templatePkg = await readJson<{ dependencies: Record<string, string>; devDependencies: Record<string, string> }>(
      join(templateDir, 'package.json'),
    );
    expect(pkg.dependencies).toMatchObject(templatePkg.dependencies);
    expect(pkg.scripts.build).toBe('tsup');
    expect(pkg.scripts.apply).toBe('guuey agent apply');
    // Every template devDependency but the web app's: a build tool the template gains reaches here too.
    for (const dep of Object.keys(templatePkg.devDependencies)) {
      if (dep === '@ggui-ai/cli' || dep === 'tsx') {
        expect(pkg.devDependencies[dep]).toBeUndefined();
      } else {
        expect({ ...pkg.dependencies, ...pkg.devDependencies }[dep]).toBeDefined();
      }
    }

    // pnpm-workspace.yaml: the template's install settings, one package (no `packages:`).
    const yaml = await fs.readFile(join(project, 'pnpm-workspace.yaml'), 'utf8');
    expect(topLevelYamlKeys(yaml)).not.toContain('packages');
    expect(topLevelYamlKeys(yaml)).toContain('ignoredBuiltDependencies');
    expect(result.keptWorkspaceFile).toBe(false);

    // .gitignore: the build output is ignored, the agent's own lines kept.
    const ignore = (await fs.readFile(join(project, '.gitignore'), 'utf8')).split('\n');
    expect(ignore).toContain('guuey.worker.js');
    expect(ignore).toContain('.guuey/');
  });

  it('a project that is already code is refused', async () => {
    await agentProject();
    await addCode({ projectDir: project, framework: 'claude-agent-sdk', pnpm: PNPM });
    await expect(addCode({ projectDir: project, framework: 'claude-agent-sdk', pnpm: PNPM })).rejects.toThrow(
      /already a code project .*run "pnpm install" there/,
    );
  });

  it("a different file where the worker goes stops it before anything is written", async () => {
    await agentProject();
    await fs.mkdir(join(project, 'src'), { recursive: true });
    await fs.writeFile(join(project, 'src', 'worker.ts'), '// mine\n');
    const pkgBefore = await fs.readFile(join(project, 'package.json'), 'utf8');

    const attempt = addCode({ projectDir: project, framework: 'claude-agent-sdk', pnpm: PNPM });
    await expect(attempt).rejects.toBeInstanceOf(AddCodeError);
    await expect(attempt).rejects.toThrow(/src\/worker\.ts already exists/);
    expect(await fs.readFile(join(project, 'package.json'), 'utf8')).toBe(pkgBefore);
    expect((await readJson<{ agent: { mode: string } }>(join(project, 'guuey.json'))).agent.mode).toBe('declarative');
    expect(await fs.readFile(join(project, 'src', 'worker.ts'), 'utf8')).toBe('// mine\n');
  });

  it('a run that died before the mode flip repeats cleanly: files it already copied match', async () => {
    await agentProject();
    const templateDir = join(dist, 'base', 'claude-agent-sdk');
    await fs.mkdir(join(project, 'src'), { recursive: true });
    await fs.copyFile(join(templateDir, 'tsup.config.ts'), join(project, 'tsup.config.ts'));

    const result = await addCode({ projectDir: project, framework: 'claude-agent-sdk', pnpm: PNPM });
    expect(result.changed).not.toContain('tsup.config.ts');
    expect((await readJson<{ agent: { mode: string } }>(join(project, 'guuey.json'))).agent.mode).toBe('code');
  });

  it("a pnpm-workspace.yaml the builder changed is kept and named", async () => {
    await agentProject();
    const custom = 'packages:\n  - "tools/*"\nallowBuilds:\n  esbuild: true\n';
    await fs.writeFile(join(project, 'pnpm-workspace.yaml'), custom);

    const result = await addCode({ projectDir: project, framework: 'claude-agent-sdk', pnpm: PNPM });
    expect(result.keptWorkspaceFile).toBe(true);
    expect(await fs.readFile(join(project, 'pnpm-workspace.yaml'), 'utf8')).toBe(custom);
  });

  it('a value edit to the agent pnpm-workspace.yaml keeps it too (same keys, different bytes)', async () => {
    await agentProject();
    const workspacePath = join(project, 'pnpm-workspace.yaml');
    const edited = (await fs.readFile(workspacePath, 'utf8')).replace('  - esbuild\n', '  - esbuild\n  - better-sqlite3\n');
    expect(edited).toContain('better-sqlite3');
    await fs.writeFile(workspacePath, edited);

    const result = await addCode({ projectDir: project, framework: 'claude-agent-sdk', pnpm: PNPM });
    expect(result.keptWorkspaceFile).toBe(true);
    expect(await fs.readFile(workspacePath, 'utf8')).toBe(edited);
  });

  it('a project with no pnpm-workspace.yaml gets the install settings', async () => {
    await agentProject();
    await fs.rm(join(project, 'pnpm-workspace.yaml'));

    const result = await addCode({ projectDir: project, framework: 'claude-agent-sdk', pnpm: PNPM });
    expect(result.keptWorkspaceFile).toBe(false);
    expect(topLevelYamlKeys(await fs.readFile(join(project, 'pnpm-workspace.yaml'), 'utf8'))).toContain('allowBuilds');
  });

  it('a guuey.json it cannot read is that error, not "no project here"', async () => {
    await agentProject();
    await fs.chmod(join(project, 'guuey.json'), 0o000);
    try {
      await expect(addCode({ projectDir: project, framework: 'claude-agent-sdk', pnpm: PNPM })).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      await fs.chmod(join(project, 'guuey.json'), 0o644);
    }
  });

  it('a directory with no guuey.json is refused, naming the template it expects', async () => {
    await fs.mkdir(project, { recursive: true });
    await expect(addCode({ projectDir: project, framework: 'claude-agent-sdk', pnpm: PNPM })).rejects.toThrow(
      /--template agent/,
    );
  });
});

describe('the workspace file helper', () => {
  it('drops the packages block and keeps every setting', () => {
    const out = workspaceSettingsOnly('packages:\n  - "mcps/*"\n  - "web"\n\n# why\nstrictDepBuilds: false\n');
    expect(topLevelYamlKeys(out)).toEqual(['strictDepBuilds']);
    expect(out).toContain('# why');
  });
});
