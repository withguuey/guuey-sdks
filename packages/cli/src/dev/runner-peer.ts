/**
 * The runner preflight for `guuey dev --serve` in host mode.
 *
 * `@guuey/host` loads each framework's runtime (`@anthropic-ai/claude-agent-sdk`,
 * `@openai/agents`, `@google/adk`) as an OPTIONAL peer, by a dynamic import
 * from its own location. When that package is missing, the dev server
 * still starts, and every turn then fails with a worker error. So the CLI
 * checks first, from the same place the host resolves, and refuses to start
 * with the install line that fixes it.
 *
 * Where the host sits decides the remedy. A host inside the project (the CLI
 * installed in the project) resolves from the project's `node_modules`, so
 * installing the runner there is enough. A host outside the project (an
 * `npx` cache or a global install) never sees the project's `node_modules`,
 * so the remedy is to install the CLI and the runner into the project and run
 * the project's own CLI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, parse } from 'node:path';

/**
 * The runtime package each framework's runner imports. Mirrors the `peer` of
 * each entry in `@guuey/host`'s runner registry (`src/index.ts` `RUNNERS`);
 * `runner-peer.sync.test.ts` holds the two, and the host manifest's
 * `peerDependencies`, equal.
 */
export const RUNNER_PEER = {
  'claude-agent-sdk': '@anthropic-ai/claude-agent-sdk',
  'openai-agents-sdk': '@openai/agents',
  'google-adk': '@google/adk',
} as const;

export type RunnerFramework = keyof typeof RUNNER_PEER;

/** The `@guuey/host` package directory: the nearest ancestor of its entry with a package.json. */
export function hostPackageDir(hostEntry: string, exists: (p: string) => boolean = existsSync): string {
  let dir = dirname(hostEntry);
  const { root } = parse(dir);
  while (!exists(join(dir, 'package.json'))) {
    if (dir === root) return dirname(hostEntry);
    dir = dirname(dir);
  }
  return dir;
}

/**
 * Is `peer` installed where Node resolves a bare import made from `fromDir`:
 * `<dir>/node_modules/<peer>` for `fromDir` and every ancestor? (ESM
 * resolution reads no NODE_PATH and no global folders.)
 */
export function peerInstalledFrom(fromDir: string, peer: string, exists: (p: string) => boolean = existsSync): boolean {
  let dir = fromDir;
  const { root } = parse(dir);
  for (;;) {
    if (exists(join(dir, 'node_modules', peer, 'package.json'))) return true;
    if (dir === root) return false;
    dir = dirname(dir);
  }
}

/** The host manifest's declared range for `peer`, if it declares one. */
export interface HostManifest {
  peerDependencies?: Readonly<Partial<Record<string, string>>>;
}

export function peerSpec(manifest: HostManifest, peer: string): string {
  const range = manifest.peerDependencies?.[peer];
  return range === undefined ? peer : `${peer}@${range}`;
}

/** Is `child` the same as, or inside, `parent`? */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The install command for this project's package manager (its lockfile decides; npm by default). */
export function addCommand(projectRoot: string, exists: (p: string) => boolean = existsSync): string {
  if (exists(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm add';
  if (exists(join(projectRoot, 'yarn.lock'))) return 'yarn add';
  return 'npm install';
}

/** The refusal printed when the runner is missing (pure). */
export function missingRunnerMessage(opts: {
  framework: RunnerFramework;
  spec: string;
  hostInsideProject: boolean;
  add: string;
  hasPackageJson: boolean;
}): string {
  const { framework, spec, hostInsideProject, add, hasPackageJson } = opts;
  const peer = RUNNER_PEER[framework];
  const head = `guuey dev --serve runs a ${framework} agent with ${peer}, and it is not installed`;
  if (hostInsideProject) {
    return `${head} in this project. Install it, then run this again:\n  ${add} "${spec}"`;
  }
  const lines = [
    `${head} where this guuey CLI can load it. This CLI runs from outside the project (an npx cache or a global install),`,
    'so it cannot load a package installed in the project. Install the CLI and the runner into the project, and run it from there:',
  ];
  if (!hasPackageJson) lines.push('  npm init -y');
  lines.push(`  ${add} @guuey/cli "${spec}"`, '  npx guuey dev --serve');
  return lines.join('\n');
}

/**
 * The preflight: `null` when the framework's runner is installed where the
 * host resolves it, else the refusal to print.
 */
export function runnerPreflight(opts: {
  framework: RunnerFramework;
  hostEntry: string;
  projectRoot: string;
  exists?: (p: string) => boolean;
  readManifest?: (path: string) => HostManifest;
}): string | null {
  const exists = opts.exists ?? existsSync;
  const readManifest = opts.readManifest ?? ((p: string): HostManifest => JSON.parse(readFileSync(p, 'utf8')) as HostManifest);
  const peer = RUNNER_PEER[opts.framework];
  const hostDir = hostPackageDir(opts.hostEntry, exists);
  if (peerInstalledFrom(hostDir, peer, exists)) return null;
  return missingRunnerMessage({
    framework: opts.framework,
    spec: peerSpec(readManifest(join(hostDir, 'package.json')), peer),
    hostInsideProject: isInside(opts.projectRoot, hostDir),
    add: addCommand(opts.projectRoot, exists),
    hasPackageJson: exists(join(opts.projectRoot, 'package.json')),
  });
}
