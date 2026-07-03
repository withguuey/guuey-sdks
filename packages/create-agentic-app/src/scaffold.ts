import { promises as fs } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renameContent, isProbablyText } from './rename.js';

const execFileAsync = promisify(execFile);

/** Frameworks the scaffolder ships templates for. */
export type Framework = 'claude-agent-sdk' | 'openai-agents-sdk';

export interface ScaffoldOptions {
  /** Absolute or cwd-relative path to create/populate the new project in. */
  targetDir: string;
  /** npm-safe project name (also used as the default scope). */
  name: string;
  framework: Framework;
  /** Package scope for `@<scope>/*` packages. Default: `name`. */
  scope?: string;
  /** Run `pnpm install` in the new project after scaffolding. Default: false. */
  install?: boolean;
  /** Run `git init` + an initial commit in the new project. Default: true. */
  git?: boolean;
  /** Scaffold into a non-empty targetDir anyway. Default: false. */
  force?: boolean;
  /** Root directory holding one subdirectory per framework. Default: dist/templates. */
  templatesDir?: string;
}

export interface ScaffoldResult {
  projectDir: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const here = dirname(fileURLToPath(import.meta.url));
/** Package root: this module lives at `<packageRoot>/dist/*.js` once built. */
const packageRoot = join(here, '..');
const defaultTemplatesDir = join(packageRoot, 'dist', 'templates');

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function listAvailableFrameworks(templatesDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(templatesDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function resolveTemplateDir(templatesDir: string, framework: string): Promise<string> {
  const dir = join(templatesDir, framework);
  if (await pathExists(dir)) return dir;
  const available = await listAvailableFrameworks(templatesDir);
  const list = available.length > 0 ? available.join(', ') : `(none found under ${templatesDir})`;
  throw new Error(`No template for framework "${framework}". Available frameworks: ${list}`);
}

async function ensureTargetDir(targetDir: string, force: boolean | undefined): Promise<void> {
  if (!(await pathExists(targetDir))) {
    await fs.mkdir(targetDir, { recursive: true });
    return;
  }
  const entries = await fs.readdir(targetDir);
  if (entries.length > 0 && !force) {
    throw new Error(
      `Target directory "${targetDir}" is not empty. Pass force: true (or --force) to scaffold into it anyway.`
    );
  }
}

async function copyTree(src: string, dest: string, name: string, scope: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const destName = renameContent(entry.name, name, scope);
    const srcPath = join(src, entry.name);
    const destPath = join(dest, destName);
    if (entry.isDirectory()) {
      await copyTree(srcPath, destPath, name, scope);
    } else {
      const buf = await fs.readFile(srcPath);
      if (isProbablyText(buf)) {
        await fs.writeFile(destPath, renameContent(buf.toString('utf8'), name, scope), 'utf8');
      } else {
        await fs.writeFile(destPath, buf);
      }
    }
  }
}

async function seedEnvLocal(projectDir: string): Promise<void> {
  const envExample = join(projectDir, '.env.example');
  const envLocal = join(projectDir, '.env.local');
  if (!(await pathExists(envExample))) return;
  if (await pathExists(envLocal)) return;
  await fs.copyFile(envExample, envLocal);
}

/**
 * `git init` + initial commit in the new project. Non-fatal: the scaffolded
 * files are already on disk, so a broken/missing git must not reject the
 * whole scaffold(). The commit pins an inline identity via `-c` so fresh
 * machines/CI containers without a global git identity succeed instead of
 * falling into the warning path.
 */
async function initGit(projectDir: string): Promise<void> {
  try {
    await execFileAsync('git', ['init'], { cwd: projectDir });
    await execFileAsync('git', ['add', '-A'], { cwd: projectDir });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=guuey',
        '-c',
        'user.email=scaffold@guuey.com',
        'commit',
        '-m',
        'chore: scaffold',
      ],
      { cwd: projectDir }
    );
  } catch {
    console.error(
      `Warning: git init failed; the project was scaffolded without a repo. Initialize it manually:\n  cd ${projectDir}\n  git init && git add -A && git commit -m "chore: scaffold"`
    );
  }
}

async function runInstall(projectDir: string): Promise<void> {
  try {
    await execFileAsync('pnpm', ['install'], { cwd: projectDir });
  } catch {
    console.error(
      `Warning: "pnpm install" failed to run automatically. Run it manually:\n  cd ${projectDir}\n  pnpm install`
    );
  }
}

/**
 * Scaffold a new agentic-app project from a bundled template.
 *
 * Copies the template tree for `opts.framework`, rewrites the
 * `agentic-app-template` / `@agentic-app-template` placeholder tokens to the
 * requested project name/scope (in file contents and in file/dir names),
 * seeds `.env.local` from `.env.example` when absent, and optionally runs
 * `git init` + an initial commit and/or `pnpm install` in the new project.
 */
export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  if (!NAME_PATTERN.test(opts.name)) {
    throw new Error(
      `Invalid project name "${opts.name}": must be npm-safe (match ${NAME_PATTERN.toString()}).`
    );
  }

  const scope = opts.scope ?? opts.name;
  const templatesDir = opts.templatesDir ?? defaultTemplatesDir;
  const templateDir = await resolveTemplateDir(templatesDir, opts.framework);

  const projectDir = resolve(opts.targetDir);
  await ensureTargetDir(projectDir, opts.force);

  await copyTree(templateDir, projectDir, opts.name, scope);
  await seedEnvLocal(projectDir);

  if (opts.git !== false) {
    await initGit(projectDir);
  }

  if (opts.install) {
    await runInstall(projectDir);
  }

  return { projectDir };
}
