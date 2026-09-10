/**
 * `templates-src/core/scripts/bootstrap.mjs` — the scaffold's configure +
 * bind orchestrator, run for real against a temp project with a fake
 * `pnpm` first on PATH. Every platform mutation the script makes goes
 * through `pnpm exec guuey …`, so the fake records each CLI call verbatim
 * and can refuse one on cue.
 *
 * Pinned (guuey#1131): `theme.json` — the app's chat theme document — follows
 * the chosen mode + accent in the local phase, and `--link` pushes it through
 * the shipped `guuey apps update --chat-theme-file` door right after the
 * brand accent. A refusal on that step names the field and the rest of the
 * run still completes; a missing document is reported, never silently
 * omitted.
 */
import { describe, it, expect, vi } from 'vitest';

// guuey#867 / #1156: every case below runs the REAL bootstrap.mjs through a
// fake `pnpm` on PATH (a `node:child_process` spawn per case) — seconds on a
// laptop, more on a 2-vCPU runner. vitest's 5 s default reds there; the
// budget guard (`@guuey/cli` test-budget-guard) requires the budget to be
// explicit.
vi.setConfig({ testTimeout: 60_000 });
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const coreDir = join(__dirname, '..', 'templates-src', 'core');

/**
 * The fake `pnpm`: appends its argv to $BOOTSTRAP_TEST_LOG, answers
 * `apps get … --json` with a dev-env app record, and refuses the
 * `--chat-theme-file` push with a field-naming error when
 * $BOOTSTRAP_TEST_REFUSE_THEME=1 (the platform validator's own wording).
 */
const FAKE_PNPM = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.BOOTSTRAP_TEST_LOG, JSON.stringify(args) + "\\n");
const cli = args.slice(2); // after "exec guuey"
if (cli[0] === "apps" && cli[1] === "get") {
  process.stdout.write(JSON.stringify({
    id: cli[2],
    endpointUrl: "https://" + cli[2] + ".agents.dev.sandbox.guuey.com/agent/invoke",
    urlSlug: null,
    pageUrl: null,
  }) + "\\n");
  process.exit(0);
}
if (cli.includes("--chat-theme-file") && process.env.BOOTSTRAP_TEST_REFUSE_THEME === "1") {
  process.stderr.write("Error: chatTheme.colors.light.accent must be a hex colour like #2f6bff / #2f6bff80, or rgb()/rgba() like rgba(47,107,255,0.5)\\n");
  process.exit(1);
}
process.exit(0);
`;

interface Project {
  projectDir: string;
  bin: string;
  log: string;
}

async function makeProject(): Promise<Project> {
  // realpath: the script resolves its own location through the main-module
  // realpath, and the pushed theme path must compare equal on macOS
  // (/var → /private/var).
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'caa-bootstrap-')));
  const projectDir = join(root, 'app');
  await fs.mkdir(join(projectDir, 'scripts'), { recursive: true });
  await fs.mkdir(join(projectDir, 'ggui'), { recursive: true });
  for (const file of ['guuey.app.json', 'theme.json', 'AGENTS.md']) {
    await fs.copyFile(join(coreDir, file), join(projectDir, file));
  }
  await fs.copyFile(join(coreDir, 'scripts', 'bootstrap.mjs'), join(projectDir, 'scripts', 'bootstrap.mjs'));
  await fs.copyFile(join(coreDir, 'ggui', 'ggui.json'), join(projectDir, 'ggui', 'ggui.json'));
  const bin = join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(join(bin, 'pnpm'), FAKE_PNPM, { mode: 0o755 });
  const log = join(root, 'cli-calls.log');
  await fs.writeFile(log, '');
  return { projectDir, bin, log };
}

interface RunResult {
  code: number | string;
  stdout: string;
  stderr: string;
}

function isExecFailure(err: unknown): err is { code?: number | string; stdout: string; stderr: string } {
  return typeof err === 'object' && err !== null && 'stdout' in err && 'stderr' in err;
}

async function runBootstrap(project: Project, args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const script = join(project.projectDir, 'scripts', 'bootstrap.mjs');
  const env = {
    ...process.env,
    PATH: `${project.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    BOOTSTRAP_TEST_LOG: project.log,
    ...extraEnv,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], { cwd: project.projectDir, env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (isExecFailure(err)) return { code: err.code ?? 1, stdout: err.stdout, stderr: err.stderr };
    throw err;
  }
}

async function cliCalls(project: Project): Promise<string[][]> {
  const raw = await fs.readFile(project.log, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

async function readJson(path: string) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

describe('bootstrap.mjs — the chat theme document (guuey#1131)', () => {
  it('local phase: theme.json follows the chosen mode + accent (accent lowercased, onAccent re-picked for legibility)', async () => {
    const project = await makeProject();
    const run = await runBootstrap(project, ['--yes', '--mode', 'dark', '--accent', '#B8FF3A']);
    expect(run.code, run.stderr).toBe(0);

    const theme = await readJson(join(project.projectDir, 'theme.json'));
    expect(theme.mode).toBe('dark');
    expect(theme.colors.light.accent).toBe('#b8ff3a');
    expect(theme.colors.dark.accent).toBe('#b8ff3a');
    // A bright accent gets dark ink painted on it — white would be 1.2:1.
    expect(theme.colors.light.onAccent).toBe('#0e1014');
    expect(theme.colors.dark.onAccent).toBe('#0e1014');
    // Every other token is the author's — untouched.
    const shipped = JSON.parse(readFileSync(join(coreDir, 'theme.json'), 'utf8'));
    expect(theme.colors.light.canvas).toBe(shipped.colors.light.canvas);
    expect(theme.colors.dark.surface).toBe(shipped.colors.dark.surface);
    expect(theme.shape).toEqual(shipped.shape);
    expect(theme.name).toBe(shipped.name);
    expect(run.stdout).toContain('theme.json → mode dark, accent #b8ff3a');
  });

  it('local phase keeps a white onAccent for a mid-dark accent, and is idempotent on re-run', async () => {
    const project = await makeProject();
    const first = await runBootstrap(project, ['--yes', '--mode', 'light', '--accent', '#6c5ce7']);
    expect(first.code, first.stderr).toBe(0);
    const themePath = join(project.projectDir, 'theme.json');
    const theme = await readJson(themePath);
    expect(theme.colors.light.onAccent).toBe('#ffffff');
    // Same inputs again: byte-identical document, no sync line printed.
    const before = await fs.readFile(themePath, 'utf8');
    const second = await runBootstrap(project, ['--yes', '--mode', 'light', '--accent', '#6c5ce7']);
    expect(second.code, second.stderr).toBe(0);
    expect(await fs.readFile(themePath, 'utf8')).toBe(before);
    expect(second.stdout).not.toContain('theme.json →');
  });

  it('--link pushes theme.json through `guuey apps update --chat-theme-file` right after the brand accent', async () => {
    const project = await makeProject();
    const local = await runBootstrap(project, ['--yes', '--mode', 'dark']);
    expect(local.code, local.stderr).toBe(0);
    const run = await runBootstrap(project, ['--yes', '--link', '--app-id', 'app_test1']);
    expect(run.code, run.stderr).toBe(0);

    const themePath = join(project.projectDir, 'theme.json');
    expect(await cliCalls(project)).toEqual([
      ['exec', 'guuey', 'apps', 'get', 'app_test1', '--json'],
      ['exec', 'guuey', 'apps', 'update', 'app_test1', '--brand-accent', '#6c5ce7'],
      ['exec', 'guuey', 'apps', 'update', 'app_test1', '--chat-theme-file', themePath],
    ]);
    expect(run.stdout).toContain('✓ brand-accent');
    expect(run.stdout).toContain('✓ chat-theme');
    expect(run.stdout).not.toContain('skipped');
    // The pushed document is the synced one — the hosted app renders dark
    // exactly like the local scaffold does.
    const pushed = await readJson(themePath);
    expect(pushed.mode).toBe('dark');
  });

  it('a chat-theme refusal names the field and the rest of the run still completes', async () => {
    const project = await makeProject();
    const local = await runBootstrap(project, ['--yes']);
    expect(local.code, local.stderr).toBe(0);
    const run = await runBootstrap(project, ['--yes', '--link', '--app-id', 'app_test1'], {
      BOOTSTRAP_TEST_REFUSE_THEME: '1',
    });
    expect(run.code, run.stderr).toBe(0);

    expect(run.stdout).toContain('✓ brand-accent');
    expect(run.stdout).toContain('– chat-theme: Error: chatTheme.colors.light.accent must be a hex colour');
    // Everything after the push still ran: the guidance, the link record,
    // the regenerated AGENTS.md block.
    expect(run.stdout).toContain('Next steps');
    const config = await readJson(join(project.projectDir, 'guuey.app.json'));
    expect(config.link.appId).toBe('app_test1');
    expect(config.link.env).toBe('dev');
    expect(await fs.readFile(join(project.projectDir, 'AGENTS.md'), 'utf8')).toContain('`app_test1` (dev)');
    expect((await cliCalls(project)).map((call) => call.slice(2, 4).join(' '))).toEqual([
      'apps get',
      'apps update',
      'apps update',
    ]);
  });

  it('a missing theme.json is reported as skipped on --link, never silently omitted', async () => {
    const project = await makeProject();
    const local = await runBootstrap(project, ['--yes']);
    expect(local.code, local.stderr).toBe(0);
    await fs.rm(join(project.projectDir, 'theme.json'));
    const run = await runBootstrap(project, ['--yes', '--link', '--app-id', 'app_test1']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('– chat-theme: skipped:');
    expect(run.stdout).toContain('theme.json not found');
    expect((await cliCalls(project)).some((call) => call.includes('--chat-theme-file'))).toBe(false);
  });
});

describe('templates-src/core/theme.json — the platform grammar (guuey#1131)', () => {
  const theme = JSON.parse(readFileSync(join(coreDir, 'theme.json'), 'utf8'));
  const appConfig = JSON.parse(readFileSync(join(coreDir, 'guuey.app.json'), 'utf8'));
  const REQUIRED_TOKENS = ['accent', 'onAccent', 'ink', 'inkMuted', 'surface', 'canvas', 'canvasMuted', 'error'];
  const LOWER_HEX = /^#[0-9a-f]{6}$/;

  it('is a complete GuueyChatTheme document: name, mode, both palettes, typography, shape', () => {
    expect(typeof theme.name).toBe('string');
    expect(theme.name.trim().length).toBeGreaterThan(0);
    expect(theme.name.length).toBeLessThanOrEqual(64);
    expect(['light', 'dark']).toContain(theme.mode);
    for (const mode of ['light', 'dark']) {
      for (const token of REQUIRED_TOKENS) {
        expect(theme.colors[mode][token], `colors.${mode}.${token}`).toMatch(LOWER_HEX);
      }
    }
    expect(theme.typography).toEqual({});
    expect(['none', 'soft', 'round']).toContain(theme.shape.radius);
    expect(['compact', 'comfortable']).toContain(theme.shape.density);
    expect(theme.courts).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(theme), 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });

  it('states the same mode + accent guuey.app.json ships, so a fresh scaffold is consistent before bootstrap runs', () => {
    expect(theme.mode).toBe(appConfig.theme.mode);
    expect(theme.colors.light.accent).toBe(appConfig.theme.accent);
    expect(theme.colors.dark.accent).toBe(appConfig.theme.accent);
  });

  it('carries the scaffold name token, so create-agentic-app renames the theme after the project', () => {
    expect(theme.name).toBe('agentic-app-template');
  });
});
