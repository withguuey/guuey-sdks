import { ENV_APP_DIR, ENV_HOME_DIR } from "./contract.js";

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
