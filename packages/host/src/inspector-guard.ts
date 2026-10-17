/**
 * The host's own inspector/preload startup guard (guuey#2139). A
 * platform-launched host is the in-memory custodian of the turn's model
 * credential and MCP headers, so before it reads the private launch envelope
 * it checks that it was started the way the platform starts
 * it: `node --disable-sigusr1 [--max-old-space-size=<n>] <entry>`.
 *
 * This is the Router's allowlist (`nocode-runtime` `node-startup-guard.ts`)
 * with one widening the worker command needs, the per-turn heap ceiling in
 * execArgv. It is a copy, because `@guuey/host` is published to npm and cannot
 * import the private runtime; `nocode-runtime`'s `host-inspector-guard-sync`
 * test pins the shared lists and the decisions of the two copies.
 *
 *   1. `execArgv` holds `--disable-sigusr1` exactly once, and otherwise only
 *      `--max-old-space-size=<digits>`. Every other entry is refused by name:
 *      inspector and debug options, preloads, loaders, env files and options
 *      Node adds later.
 *   2. `NODE_OPTIONS` is unset, empty, or only `--max-old-space-size=<digits>`.
 *   3. `OPENSSL_CONF`, `OPENSSL_MODULES` and `OPENSSL_ENGINES` are unset or empty.
 *   4. No Node or Bun inspector variable is set.
 *
 * Zero imports on purpose: the boot runs it before anything that could act on
 * the envelope. Messages name the offending option or variable, never a value.
 * It is never exercised by starting an inspector or sending a signal.
 */

/** The guard flag every platform-launched node worker command carries. */
export const DISABLE_SIGUSR1_FLAG = "--disable-sigusr1";

/** Environment variables that must be unset or empty: each makes OpenSSL load more code. */
const FORBIDDEN_ENV: readonly string[] = ["OPENSSL_CONF", "OPENSSL_MODULES", "OPENSSL_ENGINES"];

/** The one NODE_OPTIONS token shape accepted: a heap ceiling, in megabytes. */
const ALLOWED_NODE_OPTION = /^--max-old-space-size=[0-9]+$/;

/** Inspector and preload variables that must be unset (Node's and the Bun-compiled CLI's). */
const INSPECTOR_ENV: readonly string[] = [
  "NODE_INSPECT_RESUME_ON_START",
  "NODE_REPL_EXTERNAL_MODULE",
  "BUN_INSPECT",
  "BUN_INSPECT_CONNECT_TO",
  "BUN_INSPECT_NOTIFY",
];

/** The option name of one token in dash form; a non-option token names no option. */
function describeToken(token: string): string {
  if (!token.startsWith("-")) return "a non-option token";
  const name = token.split("=", 1)[0] ?? token;
  return name.startsWith("--") ? `--${name.slice(2).replace(/_/g, "-")}` : name;
}

/** The startup inputs the guard reads: the process's own execArgv and its environment. */
export interface HostStartupInputs {
  execArgv: readonly string[];
  env: NodeJS.ProcessEnv;
}

/** Every violation of the allowlist, in a stable order. Names only, never values. Pure. */
export function reviewHostStartup(inputs: HostStartupInputs): string[] {
  const refused: string[] = [];
  for (const token of inputs.execArgv) {
    if (token !== DISABLE_SIGUSR1_FLAG && !ALLOWED_NODE_OPTION.test(token)) {
      refused.push(`execArgv carries ${describeToken(token)}`);
    }
  }
  const guardCount = inputs.execArgv.filter((token) => token === DISABLE_SIGUSR1_FLAG).length;
  if (guardCount === 0) refused.push(`execArgv lacks ${DISABLE_SIGUSR1_FLAG}`);
  if (guardCount > 1) refused.push(`execArgv repeats ${DISABLE_SIGUSR1_FLAG}`);
  for (const token of (inputs.env.NODE_OPTIONS ?? "").split(/\s+/)) {
    if (token.length > 0 && !ALLOWED_NODE_OPTION.test(token)) {
      refused.push(`NODE_OPTIONS carries ${describeToken(token)}`);
    }
  }
  for (const name of FORBIDDEN_ENV) {
    const value = inputs.env[name];
    if (value !== undefined && value.length > 0) refused.push(`${name} is set`);
  }
  for (const name of INSPECTOR_ENV) {
    if (inputs.env[name] !== undefined) refused.push(`${name} is set`);
  }
  return refused;
}

/** A refused host startup. */
export class HostInspectorGuardError extends Error {
  constructor(violations: readonly string[]) {
    super(
      `@guuey/host refuses to read its launch envelope: ${violations.join("; ")}. ` +
        `The platform starts it as \`node ${DISABLE_SIGUSR1_FLAG} [--max-old-space-size=<n>] <entry>\` ` +
        "with NODE_OPTIONS, the OpenSSL config variables and the inspector variables unset (guuey#2139).",
    );
    this.name = "HostInspectorGuardError";
  }
}

/** Throw (fail closed) when the startup is refused. */
export function assertHostInspectorGuard(inputs: HostStartupInputs): void {
  const violations = reviewHostStartup(inputs);
  if (violations.length > 0) throw new HostInspectorGuardError(violations);
}
