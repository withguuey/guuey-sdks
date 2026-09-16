/**
 * How this machine can run pnpm — the one decision, shared (guuey#1441).
 *
 * The scaffold and `guuey deploy` both used to hardcode `corepack pnpm`, on the
 * strength of two sentences that were not true: that our templates pin a
 * `packageManager` (none of them do) and that corepack ships with Node (not on
 * 25, not on Homebrew's). The founder's own machine has no corepack, and his
 * `npx @guuey/create-agentic-app@latest` could not install: "my env does not
 * have corepack. other people will have the same issue."
 *
 * So neither caller decides any more; they ask here. The ladder is things a
 * machine either HAS or CAN GET:
 *
 *   1. `pnpm` on PATH — the common case for anyone who has used pnpm.
 *   2. `npx --yes pnpm@<pinned>` — npx is present wherever npm is, which is
 *      everywhere Node is.
 *   3. neither — the caller says so in its own words and does not pretend.
 *
 * There is deliberately no `npm` rung. A scaffolded project is a pnpm WORKSPACE
 * and declares no npm `workspaces`, so `npm install` would link nothing and hand
 * the user a tree that looks installed and is not. A missing install the user
 * can see beats a broken one they cannot.
 *
 * Detection is a probe, not a guess: each rung is offered only if its `--version`
 * exits 0 on this machine, right now.
 */
import { spawnSync } from 'node:child_process';

/** The pnpm fetched when this machine has none of its own. */
export const SCAFFOLD_PNPM = 'pnpm@11.2.2';

/** A runnable pnpm: the executable and the arguments that must precede pnpm's own. */
export interface PnpmInvocation {
  readonly file: string;
  readonly prefix: readonly string[];
}

function runs(file: string, args: string[]): boolean {
  try {
    return spawnSync(file, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** The pnpm this machine can run, or `null` when it can run none. */
export function pnpmInvocation(): PnpmInvocation | null {
  if (runs('pnpm', ['--version'])) return { file: 'pnpm', prefix: [] };
  if (runs('npx', ['--version'])) return { file: 'npx', prefix: ['--yes', SCAFFOLD_PNPM] };
  return null;
}

/**
 * The same invocation as one shell string, for callers that shell out rather
 * than spawn — `pnpm install`, or `npx --yes pnpm@<pinned> install`. `null` when
 * this machine can run no pnpm at all. No argument here ever needs quoting: the
 * pieces are a fixed executable name, fixed flags, a `pnpm@<semver>` specifier
 * and the caller's own literal subcommands.
 */
export function pnpmCommandLine(args: readonly string[]): string | null {
  const inv = pnpmInvocation();
  return inv === null ? null : [inv.file, ...inv.prefix, ...args].join(' ');
}

/** What to tell a user whose machine can run no pnpm. Never says `corepack`. */
export function noPnpmMessage(what: string, cwd: string): string {
  return `Could not run pnpm (not on PATH, and \`npx ${SCAFFOLD_PNPM}\` did not run). ${what} manually:\n  cd ${cwd}\n  pnpm install`;
}
