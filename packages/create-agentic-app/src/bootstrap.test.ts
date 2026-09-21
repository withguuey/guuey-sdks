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
import { execFile, spawn } from 'node:child_process';
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

/**
 * The headless shape (guuey#1546): stdin CLOSED, not piped. `execFile` keeps a
 * pipe open, so an unanswered readline prompt would wait forever there; with
 * stdin at EOF the interface closes at once, a pending `question()` stays
 * unsettled, and Node exits 13 — the failure the fix is for. This helper is
 * therefore the only one that can go red without the fix.
 */
function runHeadless(project: Project, args: string[]): Promise<RunResult> {
  const script = join(project.projectDir, 'scripts', 'bootstrap.mjs');
  const env = {
    ...process.env,
    PATH: `${project.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    BOOTSTRAP_TEST_LOG: project.log,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: project.projectDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
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
      ['exec', 'guuey', 'apps', 'update', 'app_test1', '--brand-accent', '#8b7cf6'],
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

describe('bootstrap.mjs — a headless run accepts defaults loudly (guuey#1546)', () => {
  it('with stdin closed and no --yes: says so once, applies the defaults, honours an explicit flag, exits 0 (used to exit 13 on the first prompt)', async () => {
    const project = await makeProject();
    const shipped = await readJson(join(coreDir, 'theme.json'));
    const run = await runHeadless(project, ['--mode', 'light']);
    expect(run.code).toBe(0);
    const lines = run.stdout.split('\n').filter((line) => line.startsWith('Non-interactive run: accepting defaults for every prompt'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('same as --yes; pass explicit flags to override');
    const theme = await readJson(join(project.projectDir, 'theme.json'));
    expect(theme.mode).toBe('light'); // the explicit flag still wins
    expect(theme.colors.light.accent).toBe(String(shipped.colors.light.accent).toLowerCase()); // the default, as Enter would have given
  });

  it('with --yes the line does not print — the negative control', async () => {
    const project = await makeProject();
    const run = await runHeadless(project, ['--yes']);
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain('Non-interactive run');
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

  // guuey#1155 — the default pair is legible on BOTH surfaces, and the site's
  // own CSS follows the theme's on-accent instead of a hard-coded white.
  const ON_ACCENT_HEX = '#0e1014'; // the platform's fixed brand on-accent (cli-wire/apps.ts)
  const ACCENT_CONTRAST_FLOOR = 4.5; // WCAG AA, normal text — the floor validateBrandAccent holds
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const webSrc = join(__dirname, '..', 'templates-src', 'apps', 'base', 'web', 'src');

  it("the default accent clears the platform's brand-accent floor against the fixed on-accent (guuey#1155)", () => {
    // #6c5ce7 sat at 3.92:1 and every default scaffold's --brand-accent push was refused since 08-10.
    expect(contrast(appConfig.theme.accent, ON_ACCENT_HEX)).toBeGreaterThanOrEqual(ACCENT_CONTRAST_FLOOR);
  });

  it("each palette's onAccent is the legible choice for the default accent, and legible by the same floor", () => {
    for (const mode of ['light', 'dark'] as const) {
      const { accent, onAccent } = theme.colors[mode];
      // The chooser bootstrap.mjs applies on every accent change: ink beats white when it contrasts more.
      const expected = contrast(accent, '#0e1014') >= contrast(accent, '#ffffff') ? '#0e1014' : '#ffffff';
      expect(onAccent, `colors.${mode}.onAccent`).toBe(expected);
      expect(contrast(accent, onAccent), `colors.${mode} accent/onAccent`).toBeGreaterThanOrEqual(ACCENT_CONTRAST_FLOOR);
    }
  });

  it("the site's stylesheet fallbacks equal the theme's pair, and nothing on the accent is painted a hard-coded white", () => {
    const css = readFileSync(join(webSrc, 'styles.css'), 'utf8');
    expect(css).toContain(`--app-accent: ${appConfig.theme.accent};`);
    expect(css).toContain(`--app-on-accent: ${theme.colors.light.onAccent};`);
    // Every `color: #fff` used to sit on an accent-painted element (the logo badge, .btn-accent).
    expect(css).not.toMatch(/color:\s*(#fff\b|#ffffff\b|white\b)/);
    expect(css.match(/color: var\(--app-on-accent\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('main.tsx sets --app-on-accent from the chat theme for the current mode, beside --app-accent', () => {
    const main = readFileSync(join(webSrc, 'main.tsx'), 'utf8');
    expect(main).toContain('setProperty("--app-accent", appConfig.theme.accent)');
    expect(main).toContain('"--app-on-accent"');
    expect(main).toContain('chatTheme.colors[appConfig.theme.mode].onAccent');
  });

  it('carries the scaffold name token, so create-agentic-app renames the theme after the project', () => {
    expect(theme.name).toBe('agentic-app-template');
  });
});
