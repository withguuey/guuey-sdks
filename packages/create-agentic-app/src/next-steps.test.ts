/**
 * guuey#1741 — every command the scaffold shows a user starts with the pnpm
 * the scaffold itself found. The install ladder (guuey#1441) runs a machine
 * without pnpm through `npx --yes pnpm@<pinned>`; the next steps used to tell
 * that same user to type `pnpm bootstrap`, which is not on their PATH.
 *
 * The assembly cases run the BUILT `dist/cli.js` with a PATH holding only stub
 * executables (the technique run-install.test.ts uses), so the ladder probes
 * what a user's shell would resolve. Each one reads back BOTH halves: the
 * printed next steps, and the scaffolded project's own command lines (the web
 * app's gate and errors, the scripts' messages, the README), which must use the
 * same words. The `pnpm`-on-PATH case is the control: its output is the
 * next-steps block exactly as it was printed before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { nextSteps } from './next-steps.js';
import { PNPM_PLACEHOLDER, SCAFFOLD_PNPM } from './pnpm.js';

// every assembly case spawns the built CLI, which scaffolds a whole template: an explicit budget (guuey#867)
vi.setConfig({ testTimeout: 60_000 });

const cliJs = join(__dirname, '..', 'dist', 'cli.js');
const NPX_RUNNER = `npx --yes ${SCAFFOLD_PNPM}`;

describe('nextSteps', () => {
  const projectDir = '/work/my-app';

  it('with pnpm on PATH, the web-app block is the one printed before, line for line (the control)', () => {
    expect(nextSteps({ projectDir, pnpm: { file: 'pnpm', prefix: [] }, installed: false, kind: 'app' })).toEqual([
      'Next steps:',
      '  cd /work/my-app',
      '  pnpm install',
      '  pnpm bootstrap        # brand, theme, copy — the web app is gated on this',
      '  pnpm dev',
      '  npx guuey login && npx guuey deploy',
      '  pnpm bootstrap -- --link   # bind the deployed app into the frontend',
    ]);
  });

  it('through npx, every pnpm command is the npx line', () => {
    const lines = nextSteps({ projectDir, pnpm: { file: 'npx', prefix: ['--yes', SCAFFOLD_PNPM] }, installed: true, kind: 'app', guuey: 'guuey' });
    expect(lines).toEqual([
      'Next steps:',
      '  cd /work/my-app',
      `  ${NPX_RUNNER} bootstrap        # brand, theme, copy — the web app is gated on this`,
      `  ${NPX_RUNNER} dev`,
      '  guuey login && guuey deploy',
      `  ${NPX_RUNNER} bootstrap -- --link   # bind the deployed app into the frontend`,
    ]);
  });

  it('an example re-brands and runs; the manage-only agent template logs in and applies (it has no bootstrap script)', () => {
    const npx = { file: 'npx', prefix: ['--yes', SCAFFOLD_PNPM] };
    expect(nextSteps({ projectDir, pnpm: npx, installed: true, kind: 'example' }).slice(2)).toEqual([
      `  ${NPX_RUNNER} bootstrap        # re-brand it as yours (also turns the demo chrome off)`,
      `  ${NPX_RUNNER} dev`,
    ]);
    const agent = nextSteps({ projectDir, pnpm: npx, installed: true, kind: 'agent' }).slice(2);
    expect(agent).toEqual([
      `  ${NPX_RUNNER} login          # once — opens the guuey console`,
      `  ${NPX_RUNNER} apply          # push prompts/system.md and guuey.json to your live agent`,
    ]);
    expect(agent.join('\n')).not.toContain('bootstrap');
  });

  it('a machine that runs no pnpm is told to install it first', () => {
    const lines = nextSteps({ projectDir, pnpm: null, installed: false, kind: 'app' });
    expect(lines[2]).toBe(`  # pnpm is not on your PATH and \`npx ${SCAFFOLD_PNPM}\` did not run: install pnpm first (https://pnpm.io/installation)`);
    expect(lines[3]).toBe('  pnpm install');
  });
});

// ---- the assembly: the built CLI on a controlled PATH ----

let work: string;
let bin: string;

/** A stub that appends its argv to `<work>/<name>.calls` and exits 0: it answers the ladder's `--version` probe. */
function stub(name: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(work, `${name}.calls`))}\nexit 0\n`);
  chmodSync(file, 0o755);
}
const calls = (name: string): string[] => {
  const f = join(work, `${name}.calls`);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};

/** Run the built CLI with ONLY the stubs reachable on PATH, stdin not a terminal. */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliJs, ...args], {
    cwd: work,
    env: { PATH: bin, HOME: work },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function walk(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/** A pnpm command a person reads; comment lines in code are not shown to anyone. */
const BARE_COMMAND = /\bpnpm (bootstrap|dev|status|build|install|apply|login|open)\b/;
function isCodeComment(file: string, line: string): boolean {
  const t = line.trim();
  const ext = extname(file);
  if (['.ts', '.tsx', '.mjs', '.js', '.cjs'].includes(ext)) return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
  if (['.yaml', '.yml'].includes(ext) || file.endsWith('.gitignore') || file.endsWith('.env.example') || file.endsWith('.env.local')) return t.startsWith('#');
  return false; // markdown, JSON (schema descriptions), HTML: every line is read by a person
}

/** Every text file of the scaffolded project, with the lines a person reads that name a bare `pnpm <script>`. */
function scanProject(projectDir: string): { placeholders: string[]; bare: string[]; text: Map<string, string> } {
  const placeholders: string[] = [];
  const bare: string[] = [];
  const text = new Map<string, string>();
  for (const file of walk(projectDir)) {
    const buf = readFileSync(file);
    if (buf.subarray(0, 8192).includes(0)) continue;
    const content = buf.toString('utf8');
    const rel = relative(projectDir, file);
    text.set(rel, content);
    if (content.includes(PNPM_PLACEHOLDER)) placeholders.push(rel);
    content.split('\n').forEach((line, i) => {
      if (BARE_COMMAND.test(line) && !isCodeComment(file, line)) bare.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return { placeholders, bare, text };
}

beforeEach(() => {
  // the real path: the CLI resolves the target from its cwd, and macOS's tmpdir is a symlink
  work = realpathSync(mkdtempSync(join(tmpdir(), 'caa-1741-')));
  bin = join(work, 'bin');
  mkdirSync(bin);
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('create-agentic-app on a machine without pnpm (the built CLI)', () => {
  it('precondition: the CLI is built', () => {
    expect(existsSync(cliJs)).toBe(true);
  });

  it('npx only: the next steps and the project both say the npx line; the ladder was probed once', () => {
    stub('npx');
    const r = runCli(['my-app', '--framework', 'claude-agent-sdk', '--no-install', '--no-git']);
    expect(r.status, r.stderr).toBe(0);
    const projectDir = join(work, 'my-app');
    expect(r.stdout).toContain(
      [
        'Next steps:',
        `  cd ${projectDir}`,
        `  ${NPX_RUNNER} install`,
        `  ${NPX_RUNNER} bootstrap        # brand, theme, copy — the web app is gated on this`,
        `  ${NPX_RUNNER} dev`,
        '  npx guuey login && npx guuey deploy',
        `  ${NPX_RUNNER} bootstrap -- --link   # bind the deployed app into the frontend`,
        '  Need help? https://guuey.com/discord',
      ].join('\n'),
    );
    expect(r.stdout).not.toMatch(/^\s+pnpm /m);
    // one probe of the ladder for the whole run (there is no pnpm to probe: npx answered)
    expect(calls('npx')).toEqual(['--version']);

    const scan = scanProject(projectDir);
    expect(scan.placeholders).toEqual([]);
    expect(scan.bare).toEqual([]);
    // the app's own dev-time UI and messages use the words the terminal printed
    expect(scan.text.get('web/src/components/BootstrapGate.tsx')).toContain(`<code>${NPX_RUNNER} bootstrap</code>`);
    expect(scan.text.get('web/src/components/BootstrapGate.tsx')).toContain(`<code>${NPX_RUNNER} dev</code>`);
    expect(scan.text.get('web/src/lib/status.ts')).toContain(`start it with \`${NPX_RUNNER} dev\``);
    expect(scan.text.get('web/vite.config.ts')).toContain(`run \`${NPX_RUNNER} bootstrap\` at the project root first`);
    expect(scan.text.get('scripts/bootstrap.mjs')).toContain(`"Next: ${NPX_RUNNER} dev (local stack) · ${NPX_RUNNER} bootstrap -- --link (bind a deployed app)"`);
    expect(scan.text.get('scripts/dev.mjs')).toContain(`re-run ${NPX_RUNNER} dev`);
    expect(scan.text.get('README.md')).toContain(`\n${NPX_RUNNER} install\n`);
  });

  it('the agentic-app template: its own pages carry the npx line too', () => {
    stub('npx');
    const r = runCli(['shell-app', '--template', 'agentic-app', '--framework', 'openai-agents-sdk', '--no-install', '--no-git']);
    expect(r.status, r.stderr).toBe(0);
    const scan = scanProject(join(work, 'shell-app'));
    expect(scan.placeholders).toEqual([]);
    expect(scan.bare).toEqual([]);
    expect(scan.text.get('web/src/pages/TalkOnMobile.tsx')).toContain(`<code>${NPX_RUNNER} bootstrap -- --link</code>`);
  });

  it('the google-adk template: its README quick start carries the npx line', () => {
    stub('npx');
    const r = runCli(['adk-app', '--framework', 'google-adk', '--no-install', '--no-git']);
    expect(r.status, r.stderr).toBe(0);
    const scan = scanProject(join(work, 'adk-app'));
    expect(scan.placeholders).toEqual([]);
    expect(scan.bare).toEqual([]);
    expect(scan.text.get('README.md')).toContain(`\n${NPX_RUNNER} dev `);
  });

  it('the manage-only agent template: log in and apply through npx, and no bootstrap step it does not have', () => {
    stub('npx');
    const r = runCli(['my-agent', '--template', 'agent', '--no-install', '--no-git']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`  ${NPX_RUNNER} login `);
    expect(r.stdout).toContain(`  ${NPX_RUNNER} apply `);
    expect(r.stdout).not.toContain('bootstrap');
    const scan = scanProject(join(work, 'my-agent'));
    expect(scan.placeholders).toEqual([]);
    expect(scan.bare).toEqual([]);
    expect(scan.text.get('README.md')).toContain(`${NPX_RUNNER} apply`);
    const scripts = (JSON.parse(scan.text.get('package.json') ?? '{}') as { scripts?: Record<string, string> }).scripts ?? {};
    // every script the next steps name exists in the project
    for (const script of ['login', 'apply']) expect(scripts[script], script).toBeDefined();
  });

  it('--help names the command this machine runs', () => {
    stub('npx');
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`re-brand via ${NPX_RUNNER} bootstrap)`);
    expect(r.stdout).toContain(`"${NPX_RUNNER} bootstrap -- --link" runs`);
  });

  it('control — pnpm on PATH: the plain pnpm lines, in stdout and in the project, and npx never probed', () => {
    stub('pnpm');
    stub('npx');
    const r = runCli(['my-app', '--framework', 'claude-agent-sdk', '--no-install', '--no-git']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      [
        '  pnpm install',
        '  pnpm bootstrap        # brand, theme, copy — the web app is gated on this',
        '  pnpm dev',
        '  npx guuey login && npx guuey deploy',
        '  pnpm bootstrap -- --link   # bind the deployed app into the frontend',
      ].join('\n'),
    );
    expect(calls('pnpm')).toEqual(['--version']);
    expect(calls('npx')).toEqual([]);
    const scan = scanProject(join(work, 'my-app'));
    expect(scan.placeholders).toEqual([]);
    expect(scan.text.get('web/src/components/BootstrapGate.tsx')).toContain('<code>pnpm bootstrap</code>');
  });

  it('neither pnpm nor npx: says to install pnpm first, and the project is still filled', () => {
    const r = runCli(['my-app', '--framework', 'claude-agent-sdk', '--no-install', '--no-git']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('install pnpm first (https://pnpm.io/installation)');
    expect(r.stdout).toContain('  pnpm bootstrap        # brand, theme, copy');
    expect(scanProject(join(work, 'my-app')).placeholders).toEqual([]);
  });
});
