/**
 * Add the code worker to a declarative project, in place (guuey#3276).
 *
 * A `--template agent` project holds a declarative definition: guuey.json,
 * its prompt, and a package.json whose one dependency is the CLI. `addCode`
 * turns that same directory into a code project for one framework, with no
 * new directory and no translation of the definition: the worker reads the
 * same guuey.json the declarative runtime read (`src/agent-config.ts`).
 *
 * The worker bytes come from this package's own assembled template
 * (`dist/templates/base/<framework>/`), so a converted project and a fresh
 * code scaffold carry the same files from one home:
 *
 *  - `src/**`, `tsup.config.ts` and `tsconfig.json`, copied (a file already
 *    there with the same bytes is kept; different bytes stop the conversion
 *    before anything is written);
 *  - package.json: the template's dependencies and devDependencies are added
 *    (all but the web app's, a version the project already pins is kept),
 *    plus the `build` and `typecheck` scripts;
 *  - pnpm-workspace.yaml: the template's install settings (the build-script
 *    allow and ignore lists a worker's dependencies need), without its
 *    `packages:` list, when the project's file is still the agent template's,
 *    byte for byte (the same test as the worker files); a file the builder
 *    changed is kept and named;
 *  - .gitignore: the template's lines the project lacks (the build output);
 *  - guuey.json, LAST: `agent.mode: "code"`, the framework, and the
 *    template's worker entry (`worker` / `agent.entry`) when it names one.
 *
 * Flipping the mode last makes a run that died part-way safe to repeat: the
 * project still reads declarative, and the copies it already made match.
 */
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GuueyJsonV1Input } from '@guuey/config';
import { pnpmInvocation, pnpmRunner, type PnpmInvocation } from './pnpm.js';
import { fillPnpmRunner, isProbablyText, renameContent } from './rename.js';
import { pathExists } from './shared.js';
import { runInstall, type Framework } from './scaffold.js';

/**
 * The template devDependencies a converted project does NOT take: they serve
 * the web app and its dev loop, which the conversion does not add. Every other
 * template devDependency is taken, so a build tool the template gains reaches
 * converted projects too; a name missing here costs one unused devDependency,
 * never a broken build.
 */
const WEB_ONLY_DEV_DEPENDENCIES: ReadonlySet<string> = new Set(['@ggui-ai/cli', 'tsx']);

/** The files and directories the worker brings, relative to the project root. */
const WORKER_PATHS: readonly string[] = ['src', 'tsup.config.ts', 'tsconfig.json'];

export interface AddCodeOptions {
  /** The declarative project to convert (its guuey.json is read from here). */
  projectDir: string;
  framework: Framework;
  /** Run `pnpm install` afterwards, so the new dependencies are present for the build. Default: false. */
  install?: boolean;
  /** How this machine runs pnpm, when the caller already asked (`null`: none). Omitted, asked once here. */
  pnpm?: PnpmInvocation | null;
  /** Root holding `base/<framework>` and `agent` (the assembled templates). Default: dist/templates. */
  templatesDir?: string;
}

export interface AddCodeResult {
  projectDir: string;
  /** Project-relative paths written or changed, in order. */
  changed: string[];
  /** A pnpm-workspace.yaml the builder changed, kept as is: its install settings are theirs to merge. */
  keptWorkspaceFile: boolean;
  pnpm: PnpmInvocation | null;
}

/** Thrown for a project addCode cannot convert; the message is the whole reason, for the builder. */
export class AddCodeError extends Error {
  override readonly name = 'AddCodeError';
}

const here = dirname(fileURLToPath(import.meta.url));
const defaultTemplatesDir = join(here, '..', 'dist', 'templates');

/** The package.json fields addCode reads and writes. */
interface ProjectPackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readJson<T>(path: string, what: string): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    // Only a missing file means "not a project"; any other read error is itself the answer.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    throw new AddCodeError(`No ${what} at ${path}: run this in a project made with --template agent.`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new AddCodeError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writeJson(path: string, value: object): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Every file under `root` (or `root` itself when it is a file), as paths relative to `base`. */
async function filesUnder(base: string, root: string): Promise<string[]> {
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) return [relative(base, root)];
  const out: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    out.push(...(await filesUnder(base, join(root, entry.name))));
  }
  return out.sort();
}

/** A template file's bytes as the project gets them: names and the pnpm runner filled in, like a scaffold. */
async function renderedFile(src: string, name: string, runner: string): Promise<Buffer> {
  const buf = await fs.readFile(src);
  if (!isProbablyText(buf)) return buf;
  return Buffer.from(fillPnpmRunner(renameContent(buf.toString('utf8'), name, name), runner), 'utf8');
}

/** The template's pnpm-workspace.yaml without its `packages:` block: a converted project is one package. */
export function workspaceSettingsOnly(text: string): string {
  const out: string[] = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^packages:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && (/^\s+-/.test(line) || line.trim() === '')) {
      if (line.trim() === '') inPackages = false;
      continue;
    }
    inPackages = false;
    out.push(line);
  }
  return `# Install settings only: this repo is one package, not a workspace.\n${out.join('\n').replace(/^\n+/, '')}`;
}

export async function addCode(opts: AddCodeOptions): Promise<AddCodeResult> {
  const projectDir = resolve(opts.projectDir);
  const templatesDir = opts.templatesDir ?? defaultTemplatesDir;
  const templateDir = join(templatesDir, 'base', opts.framework);
  if (!(await pathExists(templateDir))) {
    throw new AddCodeError(`No code template for framework "${opts.framework}" under ${templateDir}.`);
  }

  const guueyJsonPath = join(projectDir, 'guuey.json');
  const manifest = await readJson<GuueyJsonV1Input>(guueyJsonPath, 'guuey.json');
  if (manifest.agent === undefined) {
    throw new AddCodeError(`${guueyJsonPath} declares no agent: run this in a project made with --template agent.`);
  }
  if (manifest.agent.mode === 'code') {
    throw new AddCodeError(
      `${guueyJsonPath} is already a code project (agent.mode is "code"). If its dependencies are not installed yet, run "pnpm install" there.`,
    );
  }
  const packageJsonPath = join(projectDir, 'package.json');
  const pkg = await readJson<ProjectPackageJson>(packageJsonPath, 'package.json');
  const name = pkg.name ?? 'agentic-app';
  const pnpm = opts.pnpm !== undefined ? opts.pnpm : pnpmInvocation();
  const runner = pnpmRunner(pnpm);

  // Every worker file first, as bytes: a different file already there stops
  // the conversion before anything is written.
  const copies: { rel: string; bytes: Buffer; present: boolean }[] = [];
  for (const top of WORKER_PATHS) {
    const src = join(templateDir, top);
    if (!(await pathExists(src))) continue;
    for (const rel of await filesUnder(templateDir, src)) {
      const bytes = await renderedFile(join(templateDir, rel), name, runner);
      const dest = join(projectDir, rel);
      let present = false;
      if (await pathExists(dest)) {
        if (!(await fs.readFile(dest)).equals(bytes)) {
          throw new AddCodeError(
            `${rel} already exists and is not the ${opts.framework} worker's. Move it aside, then run this again.`,
          );
        }
        present = true;
      }
      copies.push({ rel, bytes, present });
    }
  }

  const changed: string[] = [];
  for (const copy of copies) {
    if (copy.present) continue;
    const dest = join(projectDir, copy.rel);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.writeFile(dest, copy.bytes);
    changed.push(copy.rel);
  }

  // package.json: the worker's dependencies and build scripts; a version the
  // project already pins wins.
  const templatePkg = await readJson<ProjectPackageJson>(join(templateDir, 'package.json'), 'template package.json');
  const dependencies = { ...(pkg.dependencies ?? {}) };
  for (const [dep, version] of Object.entries(templatePkg.dependencies ?? {})) {
    dependencies[dep] ??= version;
  }
  const devDependencies = { ...(pkg.devDependencies ?? {}) };
  for (const [dep, version] of Object.entries(templatePkg.devDependencies ?? {})) {
    if (WEB_ONLY_DEV_DEPENDENCIES.has(dep) || dependencies[dep] !== undefined) continue;
    devDependencies[dep] ??= version;
  }
  const scripts = { ...(pkg.scripts ?? {}) };
  for (const script of ['build', 'typecheck']) {
    const command = templatePkg.scripts?.[script];
    if (command !== undefined) scripts[script] ??= command;
  }
  await writeJson(packageJsonPath, { ...pkg, scripts, dependencies, devDependencies });
  changed.push('package.json');

  // pnpm-workspace.yaml: the worker dependencies' install settings. The
  // project's file is ours to replace only while it is still the agent
  // template's, byte for byte; a builder's edit (a key or a value) keeps it.
  let keptWorkspaceFile = false;
  const templateWorkspace = join(templateDir, 'pnpm-workspace.yaml');
  if (await pathExists(templateWorkspace)) {
    const projectWorkspace = join(projectDir, 'pnpm-workspace.yaml');
    const agentWorkspace = join(templatesDir, 'agent', 'pnpm-workspace.yaml');
    const ours =
      !(await pathExists(projectWorkspace)) ||
      ((await pathExists(agentWorkspace)) &&
        (await fs.readFile(projectWorkspace)).equals(await renderedFile(agentWorkspace, name, runner)));
    if (ours) {
      await fs.writeFile(projectWorkspace, workspaceSettingsOnly(await fs.readFile(templateWorkspace, 'utf8')), 'utf8');
      changed.push('pnpm-workspace.yaml');
    } else {
      keptWorkspaceFile = true;
    }
  }

  // .gitignore: the template's lines the project lacks (the build output).
  const templateIgnore = join(templateDir, 'gitignore');
  if (await pathExists(templateIgnore)) {
    const ignorePath = join(projectDir, '.gitignore');
    const current = (await pathExists(ignorePath)) ? await fs.readFile(ignorePath, 'utf8') : '';
    const have = new Set(current.split('\n').map((line) => line.trim()));
    const missing = (await fs.readFile(templateIgnore, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !have.has(line));
    if (missing.length > 0) {
      const sep = current === '' || current.endsWith('\n') ? '' : '\n';
      await fs.writeFile(ignorePath, `${current}${sep}${missing.join('\n')}\n`, 'utf8');
      changed.push('.gitignore');
    }
  }

  // guuey.json, LAST: the mode flips only once every file it needs is there.
  const templateManifest = await readJson<GuueyJsonV1Input>(join(templateDir, 'guuey.json'), 'template guuey.json');
  const agent = { ...manifest.agent, mode: 'code' as const, framework: opts.framework };
  if (templateManifest.agent?.entry !== undefined) agent.entry = templateManifest.agent.entry;
  const next: GuueyJsonV1Input = { ...manifest, agent };
  if (templateManifest.worker !== undefined) next.worker = templateManifest.worker;
  await writeJson(guueyJsonPath, next);
  changed.push('guuey.json');

  if (opts.install === true) {
    await runInstall(projectDir, pnpm);
  }
  return { projectDir, changed, keptWorkspaceFile, pnpm };
}
