/**
 * Env-var names the Router injects so agent code reaches the home/app layers
 * portably. This package's OWN copy (trivial string literals — not imported,
 * so the published `@guuey/fs` package has zero non-devDependency deps and
 * cannot depend on the platform-private contract package). Sync sites if
 * these ever change: `backend/libs/fs-contract/src/contract.ts` (the
 * platform-internal source of truth) and `oss/packages/host/src/frameworks/
 * claude-options.ts:41-45` (same OSS-legality constraint, same literals).
 */
export const ENV_HOME_DIR = "GUUEY_HOME_DIR";
export const ENV_APP_DIR = "GUUEY_APP_DIR";

/** The user's durable memory layer root (reads GUUEY_HOME_DIR, Router-injected). */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return requireRoot(env, ENV_HOME_DIR);
}

/** The app's shared read-only layer root (reads GUUEY_APP_DIR, Router-injected). */
export function appDir(env: NodeJS.ProcessEnv = process.env): string {
  return requireRoot(env, ENV_APP_DIR);
}

/** The per-session working dir = the process cwd (the Router sets cwd = sessionDir). */
export function sessionDir(cwd: () => string = process.cwd): string {
  return cwd();
}

function requireRoot(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `${name} is not set — the guuey agent runtime injects it. Run via \`guuey dev\` or the hosted runtime.`
    );
  }
  return value;
}
