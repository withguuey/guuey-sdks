/**
 * `guuey mcp new <name>` -- scaffold a hosted MCP server from the shared
 * `mcp-base` template (`@guuey/create-agentic-app#scaffoldMcp`).
 *
 * Asks no questions (mcp-lifecycle design spec M6): the old co-locate /
 * external / proxied decision-tree is printed guidance in `--help` (see
 * `cli.ts`'s `printHelp`), not an interrogation — its tier-aware routing
 * depended on the deferred pricing axis.
 *
 * Two modes, chosen by whether a `guuey.json` is found (`findProjectConfig`,
 * same rule `guuey deploy`/`guuey dev` use — walks cwd + up to 5 parents):
 *
 * - **Project mode**: scaffolds `mcps/<name>/`, wires
 *   `agent.mcpServers[<name>] = { kind: 'hosted', source: './mcps/<name>',
 *   devPort: <next free ≥6782> }` into `guuey.json`, and ensures
 *   `pnpm-workspace.yaml` globs `mcps/*` (the scaffolder's own template
 *   already ships this glob — see `templates-src/base/pnpm-workspace.yaml`
 *   — this only matters for a hand-rolled or pre-existing project).
 * - **Standalone mode** (no `guuey.json` found): scaffolds a self-contained
 *   package into `./<name>/` that `guuey mcp deploy` accepts as-is.
 *
 * Both modes refuse an existing target directory.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  loadGuueyJson,
  writeGuueyJsonFile,
  type GuueyJsonV1,
} from '@guuey/config';
import { isNpmSafeName, scaffoldMcp, type ScaffoldMcpOptions } from '@guuey/create-agentic-app';
import { findProjectConfig } from '../config';
import * as out from '../output';

/**
 * Hosted-MCP dev servers start scanning for a free port from here — matches
 * the `mcp-base` template's own `PORT` env fallback
 * (`templates-src/mcp-base/src/server.ts`) and the scaffolder's `mcps/todo`
 * default.
 */
export const MIN_MCP_DEV_PORT = 6782;

/**
 * Compute the next free dev port `>= MIN_MCP_DEV_PORT` given the ports
 * already used by other `guuey.json#agent.mcpServers` entries. Pure — no
 * I/O — so it's directly unit-testable.
 */
export function nextFreeDevPort(usedPorts: readonly number[]): number {
  const used = new Set(usedPorts);
  let port = MIN_MCP_DEV_PORT;
  while (used.has(port)) port++;
  return port;
}

/** Every `devPort` already assigned across `agent.mcpServers` (any kind that carries one). */
export function collectUsedDevPorts(doc: GuueyJsonV1): number[] {
  const servers = doc.agent.mcpServers;
  if (!servers) return [];
  const ports: number[] = [];
  for (const entry of Object.values(servers)) {
    if ('devPort' in entry && typeof entry.devPort === 'number') {
      ports.push(entry.devPort);
    }
  }
  return ports;
}

/**
 * Read the project's own scope off its root `package.json` `name` — a
 * scaffolded app's root package name is UNSCOPED (`scaffold()`'s own
 * `scope ?? name` default means the project's scope IS its bare name), so
 * the common case returns that name verbatim. A scoped root name
 * (`@scope/pkg`, e.g. a hand-authored project) returns just the scope
 * segment instead — never doubles up the `@`.
 *
 * Returns `undefined` when there's no readable root `package.json` or its
 * `name` field is missing/empty — the caller falls back to the MCP's own
 * name as the scope.
 */
export function readProjectScope(root: string): string | undefined {
  const pkgJsonPath = join(root, 'package.json');
  if (!existsSync(pkgJsonPath)) return undefined;
  let pkgName: string;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { name?: unknown };
    if (typeof pkg.name !== 'string' || pkg.name.length === 0) return undefined;
    pkgName = pkg.name;
  } catch {
    return undefined;
  }
  if (pkgName.startsWith('@')) {
    const slash = pkgName.indexOf('/');
    if (slash > 1) return pkgName.slice(1, slash);
  }
  return pkgName;
}

/** Whether a `pnpm-workspace.yaml` `packages` glob already covers `mcps/<name>`. */
function globCoversMcps(glob: unknown): boolean {
  return typeof glob === 'string' && (glob === 'mcps/*' || glob.startsWith('mcps/'));
}

/**
 * The one field of `pnpm-workspace.yaml` this module reads/writes.
 * `packages` is the only field we know the shape of (and the only one we
 * ever touch); every other pnpm-workspace.yaml key (`catalogs`,
 * `overrides`, `onlyBuiltDependencies`, …) is passed through untouched and
 * genuinely unknown to us, so it keeps an index signature rather than a
 * `Record<string, unknown>` erasing the one field we DO care about.
 */
interface PnpmWorkspaceDoc {
  packages: string[];
  [key: string]: unknown;
}

/**
 * Ensure `<root>/pnpm-workspace.yaml` globs `mcps/*`. Creates the file
 * fresh (minimal `packages: [mcps/*]`) when absent; otherwise adds the
 * glob to the existing `packages` list when missing. Returns whether the
 * glob was ADDED — the caller only prints a note in that case, since the
 * scaffolder's own template already ships the glob (the common case is a
 * silent no-op).
 */
export function ensureMcpsWorkspaceGlob(root: string): boolean {
  const path = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(path)) {
    writeYamlFile(path, { packages: ['mcps/*'] });
    return true;
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed: PnpmWorkspaceDoc | undefined = parseYaml(raw) ?? undefined;
  const doc: PnpmWorkspaceDoc = parsed ?? { packages: [] };
  const packages = Array.isArray(doc.packages) ? doc.packages : [];
  if (packages.some(globCoversMcps)) return false;

  writeYamlFile(path, { ...doc, packages: [...packages, 'mcps/*'] });
  return true;
}

function writeYamlFile(path: string, doc: PnpmWorkspaceDoc): void {
  writeFileSync(path, stringifyYaml(doc), 'utf-8');
}

/** `guuey mcp new`'s resolved inputs — the name to scaffold + an optional explicit `--scope`. */
export interface McpNewOptions {
  name: string;
  scope?: string;
  /** Directory `findProjectConfig` searches from. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * The reusable core of `guuey mcp new`: resolves project vs standalone
 * mode and scaffolds accordingly. Throws on any of: an npm-unsafe name, an
 * already-existing target directory, or a `guuey.json` load failure — the
 * command wrapper prints + exits (mirrors every other `*Core` in
 * `mcp.ts`).
 *
 * `deps.scaffoldMcp`/`deps.findProjectConfig` default to the real
 * implementations and exist purely for test injection (a fixture
 * `templatesDir` bound via a closure, or a fake project-config path) —
 * mirrors `deps.api` on `mcp.ts`'s `*Core` functions.
 */
export async function mcpNewCore(
  opts: McpNewOptions,
  deps?: {
    scaffoldMcp?: (o: ScaffoldMcpOptions) => ReturnType<typeof scaffoldMcp>;
    findProjectConfig?: () => string | null;
  },
): Promise<void> {
  if (!isNpmSafeName(opts.name)) {
    throw new Error(
      `Invalid MCP name "${opts.name}": must be npm-safe (lowercase letters, digits, dots, hyphens, ` +
        'underscores; must start with a letter or digit) — the same rule `guuey create-agentic-app` scaffolds use.',
    );
  }

  const doScaffold = deps?.scaffoldMcp ?? scaffoldMcp;
  const configPath = (deps?.findProjectConfig ?? findProjectConfig)();

  if (configPath) {
    await mcpNewProjectMode(opts, configPath, doScaffold);
  } else {
    await mcpNewStandaloneMode(opts, doScaffold);
  }
}

async function mcpNewProjectMode(
  opts: McpNewOptions,
  configPath: string,
  doScaffold: (o: ScaffoldMcpOptions) => ReturnType<typeof scaffoldMcp>,
): Promise<void> {
  const root = dirname(configPath);
  const relativeSource = `./mcps/${opts.name}`;
  const mcpDir = join(root, 'mcps', opts.name);

  if (existsSync(mcpDir)) {
    throw new Error(`"mcps/${opts.name}" already exists.`);
  }

  const loaded = loadGuueyJson(configPath);
  const doc = loaded.doc;

  const scope = opts.scope ?? readProjectScope(root) ?? opts.name;
  await doScaffold({ targetDir: mcpDir, name: opts.name, scope });

  const usedPorts = collectUsedDevPorts(doc);
  const devPort = nextFreeDevPort(usedPorts);
  const portCollided = devPort !== MIN_MCP_DEV_PORT;

  const nextDoc: GuueyJsonV1 = {
    ...doc,
    agent: {
      ...doc.agent,
      mcpServers: {
        ...doc.agent.mcpServers,
        [opts.name]: { kind: 'hosted', source: relativeSource, devPort },
      },
    },
  };
  writeGuueyJsonFile(configPath, nextDoc);

  const globAdded = ensureMcpsWorkspaceGlob(root);

  out.success(`Scaffolded mcps/${opts.name} (hosted, dev port ${devPort}).`);
  if (portCollided) {
    console.log(
      `  Port ${MIN_MCP_DEV_PORT} was already taken by another mcpServers entry — picked ${devPort} instead.`,
    );
  }
  if (globAdded) {
    console.log('  Added "mcps/*" to pnpm-workspace.yaml (it was missing).');
  }
  console.log('');
  console.log('  Next steps:');
  console.log(`    cd mcps/${opts.name} && pnpm install   # first time only`);
  console.log('    guuey dev                             # local dev loop (agent + this MCP)');
  console.log('    guuey deploy                          # deploy the whole project (MCP legs included)');
}

async function mcpNewStandaloneMode(
  opts: McpNewOptions,
  doScaffold: (o: ScaffoldMcpOptions) => ReturnType<typeof scaffoldMcp>,
): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const targetDir = join(cwd, opts.name);

  if (existsSync(targetDir)) {
    throw new Error(`"${opts.name}" already exists.`);
  }

  const scope = opts.scope ?? opts.name;
  await doScaffold({ targetDir, name: opts.name, scope });

  out.success(`Scaffolded ${opts.name}/ (standalone hosted MCP).`);
  console.log('');
  console.log('  Next steps:');
  console.log(`    cd ${opts.name} && pnpm install`);
  console.log(`    pnpm dev              # run locally on :${MIN_MCP_DEV_PORT} (see src/server.ts)`);
  console.log('    guuey mcp deploy      # deploy to guuey cloud');
}

/**
 * `guuey mcp new <name> [--scope <scope>]`
 *
 * Project mode (a `guuey.json` found via `findProjectConfig`): scaffolds
 * `mcps/<name>/`, wires it into `guuey.json#agent.mcpServers`. Standalone
 * mode: scaffolds a self-contained `./<name>/` package.
 */
export async function mcpNew(
  nameArg: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (typeof nameArg !== 'string' || nameArg.length === 0) {
    out.error('Usage: guuey mcp new <name> [--scope <scope>]');
    process.exit(1);
  }

  const scope = typeof flags?.scope === 'string' ? flags.scope : undefined;

  try {
    await mcpNewCore({ name: nameArg, scope });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
