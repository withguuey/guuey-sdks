/**
 * `--example <vertical>` — pull one demo app out of the public
 * `withguuey/demos` monorepo (the create-next-app examples pattern:
 * codeload tarball + subdir extraction, no git required).
 *
 * Examples are ALREADY-BRANDED apps: they are copied as-is — no
 * placeholder rename — and the user re-brands via `pnpm bootstrap`
 * (which also turns the demo chrome off: `demoMode: false`).
 */
import { promises as fs, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { x, t } from 'tar';
import { ensureTargetDir, pathExists } from './shared.js';
import { initGit, runInstall, seedEnvLocal } from './scaffold.js';

const EXAMPLES_REPO = 'withguuey/demos';
const EXAMPLES_REF = 'main';
const TARBALL_URL = `https://codeload.github.com/${EXAMPLES_REPO}/tar.gz/${EXAMPLES_REF}`;

export interface ScaffoldExampleOptions {
  /** Absolute or cwd-relative path to create/populate the new project in. */
  targetDir: string;
  /** The example's top-level directory name in withguuey/demos (e.g. `trimly`). */
  example: string;
  /** Run `pnpm install` after extraction. Default: false. */
  install?: boolean;
  /** Run `git init` + an initial commit. Default: true. */
  git?: boolean;
  /** Extract into a non-empty targetDir anyway. Default: false. */
  force?: boolean;
  /**
   * Test seam: returns the repo tarball as a stream. Default fetches the
   * codeload URL. The tarball's first path segment (`demos-main/`) is
   * discovered, never assumed.
   */
  fetchTarball?: () => Promise<NodeJS.ReadableStream>;
}

export interface ScaffoldExampleResult {
  projectDir: string;
}

async function defaultFetchTarball(): Promise<NodeJS.ReadableStream> {
  const res = await fetch(TARBALL_URL);
  if (!res.ok) {
    throw new Error(
      `Could not download ${EXAMPLES_REPO} (${res.status} from codeload.github.com). ` +
        'Check your network; the manual alternative is: npx degit ' +
        `${EXAMPLES_REPO}/<example>`,
    );
  }
  // Buffer the (small) tarball rather than bridging web→node stream types —
  // fetch's DOM ReadableStream and node:stream/web's are structurally
  // incompatible at the type level, and a demos tarball is a few MB.
  return Readable.from(Buffer.from(await res.arrayBuffer()));
}

/** Save the tarball once so it can be listed AND extracted (streams are one-shot). */
async function saveTarball(fetchTarball: () => Promise<NodeJS.ReadableStream>): Promise<string> {
  const file = join(await fs.mkdtemp(join(tmpdir(), 'guuey-example-')), 'demos.tar.gz');
  await pipeline(await fetchTarball(), createWriteStream(file));
  return file;
}

/** The tarball's top-level entries: its root dir name + the example dirs. */
async function listTarball(file: string): Promise<{ root: string; examples: string[] }> {
  let root: string | null = null;
  const examples = new Set<string>();
  await t({
    file,
    onReadEntry: (entry) => {
      const segments = entry.path.split('/').filter(Boolean);
      const first = segments[0];
      if (first === undefined) return;
      root ??= first;
      const second = segments[1];
      // A directory qualifies as an example when it carries a guuey.json —
      // dot-dirs, CI config and repo scripts never do.
      if (second !== undefined && segments[2] === 'guuey.json') examples.add(second);
    },
  });
  if (root === null) throw new Error(`The ${EXAMPLES_REPO} tarball was empty.`);
  return { root, examples: [...examples].sort() };
}

export async function scaffoldExample(opts: ScaffoldExampleOptions): Promise<ScaffoldExampleResult> {
  const tarball = await saveTarball(opts.fetchTarball ?? defaultFetchTarball);
  const { root, examples } = await listTarball(tarball);

  if (!examples.includes(opts.example)) {
    const list = examples.length > 0 ? examples.join(', ') : '(none published yet)';
    throw new Error(`No example "${opts.example}" in ${EXAMPLES_REPO}. Available: ${list}`);
  }

  const projectDir = resolve(opts.targetDir);
  await ensureTargetDir(projectDir, opts.force);

  const prefix = `${root}/${opts.example}/`;
  await x({
    file: tarball,
    cwd: projectDir,
    strip: 2,
    filter: (path) => path.startsWith(prefix),
  });

  if (!(await pathExists(join(projectDir, 'guuey.json')))) {
    throw new Error(
      `Extraction produced no guuey.json in ${projectDir} — the "${opts.example}" example looks malformed; please report this.`,
    );
  }

  await seedEnvLocal(projectDir);
  if (opts.git !== false) await initGit(projectDir);
  if (opts.install) await runInstall(projectDir);

  return { projectDir };
}
