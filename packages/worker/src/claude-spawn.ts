/**
 * A Claude Code CLI spawner that delivers the model credential privately
 * (guuey#2139), for the Claude Agent SDK's `spawnClaudeCodeProcess` option.
 *
 * The SDK's default spawn puts whatever credential its `env` option holds into
 * the CLI's initial environment, and from there into every Bash, tool and stdio
 * MCP child the CLI starts. This spawner instead:
 *
 *  - refuses an environment that names a credential, an auth-path switch, an
 *    inherited-descriptor credential name or a Node/Bun inspector or preload
 *    variable, and refuses any argument or environment value that contains the
 *    key or another registered secret (an MCP header value, say), and an
 *    argument list that already carries `--mcp-config`;
 *  - spawns with plain pipes only (no `'ipc'` channel, so the CLI's
 *    `process.send` is undefined) and `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=3`;
 *  - writes `key\n` to fd 3 (a socketpair end) and closes its own end. On that
 *    branch the pinned CLI reads to the newline, closes the descriptor and
 *    removes the variable from its own environment, and never writes the key
 *    to disk;
 *  - drains stderr through a redactor: the key and every registered secret are
 *    replaced before a line reaches the sink.
 *
 * Each spawn gets a fresh socketpair, so a retry or resume never reuses a
 * consumed descriptor.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Writable, type Readable } from "node:stream";

/** The descriptor the CLI reads its API key from (stdio index 3 of the spawn). */
export const CLAUDE_KEY_FD = 3;
/** The CLI's descriptor-input variable for an API key. */
export const CLAUDE_KEY_FD_ENV = "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR";

/** Credential variables: a credential is never an environment value of the CLI. */
export const CLAUDE_CREDENTIAL_ENV: readonly string[] = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/**
 * Variables that move the CLI's credential path: `CLAUDE_CODE_REMOTE` makes it
 * persist the key to a well-known file, `CLAUDE_CODE_SIMPLE` makes it ignore
 * the descriptor, the snapshot/socket names hand it another credential source,
 * and the descriptor family names another inherited descriptor.
 */
export const CLAUDE_AUTH_PATH_ENV: readonly string[] = [
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
];

/** Inspector and preload variables (Node and the Bun-compiled CLI). */
export const INSPECTOR_ENV: readonly string[] = [
  "NODE_OPTIONS",
  "NODE_INSPECT_RESUME_ON_START",
  "NODE_REPL_EXTERNAL_MODULE",
  "BUN_INSPECT",
  "BUN_INSPECT_CONNECT_TO",
  "BUN_INSPECT_NOTIFY",
];

/** Every variable the CLI environment must not carry from its caller. */
export const CLAUDE_FORBIDDEN_ENV: readonly string[] = [
  ...CLAUDE_CREDENTIAL_ENV,
  ...CLAUDE_AUTH_PATH_ENV,
  ...INSPECTOR_ENV,
];

/** The forbidden names `env` sets (to a defined value), in a stable order. */
export function forbiddenClaudeEnvNames(env: { readonly [name: string]: string | undefined }): string[] {
  return CLAUDE_FORBIDDEN_ENV.filter((name) => env[name] !== undefined);
}

/** The SDK's spawn request, structurally (the SDK's `SpawnOptions`). */
export interface ClaudeSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: { [name: string]: string | undefined };
  signal: AbortSignal;
}

/** The SDK's `SpawnedProcess`, structurally: a child whose stdin and stdout are pipes. */
export type ClaudeSpawnedProcess = ChildProcess & { stdin: Writable; stdout: Readable };

/** A refused spawn. Its message names the reason, never a value. */
export class ClaudeSpawnRefusedError extends Error {
  constructor(reason: string) {
    super(`Claude CLI spawn refused: ${reason}`);
    this.name = "ClaudeSpawnRefusedError";
  }
}

export interface ClaudeSpawnerOptions {
  /** The model credential, delivered on fd 3 only. */
  key: string;
  /** Further values that must appear in no argument and no environment value (MCP header values). */
  secrets?: readonly string[];
  /** Receives each redacted stderr line. Defaults to the host's stderr. */
  stderr?: (line: string) => void;
  /** Injectable for tests; production uses `node:child_process` spawn. */
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Called with the spawned child (tests record its pid). */
  onSpawn?: (child: ChildProcess) => void;
}

/** Replace every occurrence of each secret in `line`. */
export function redactSecrets(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Build the `spawnClaudeCodeProcess` implementation for one query. */
export function makeClaudeSpawner(options: ClaudeSpawnerOptions): (request: ClaudeSpawnRequest) => ClaudeSpawnedProcess {
  if (options.key.length === 0 || /[\r\n]/.test(options.key)) {
    throw new ClaudeSpawnRefusedError("the key is empty or contains a line break");
  }
  const secrets = [options.key, ...(options.secrets ?? []).filter((s) => s.length > 0)];
  const sink = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const spawnImpl = options.spawnFn ?? ((command: string, args: readonly string[], spawnOptions: SpawnOptions) => spawn(command, args, spawnOptions));

  return (request) => {
    const forbidden = forbiddenClaudeEnvNames(request.env);
    if (forbidden.length > 0) throw new ClaudeSpawnRefusedError(`environment names ${forbidden.join(", ")}`);
    for (const [name, value] of Object.entries(request.env)) {
      if (value !== undefined && secrets.some((secret) => value.includes(secret))) {
        throw new ClaudeSpawnRefusedError(`environment value of ${name} contains a secret`);
      }
    }
    if (request.args.some((arg) => secrets.some((secret) => arg.includes(secret)))) {
      throw new ClaudeSpawnRefusedError("an argument contains a secret");
    }
    if (request.args.some((arg) => arg === "--mcp-config" || arg.startsWith("--mcp-config="))) {
      throw new ClaudeSpawnRefusedError("the arguments already carry --mcp-config");
    }
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(request.env)) {
      if (value !== undefined) env[name] = value;
    }
    env[CLAUDE_KEY_FD_ENV] = String(CLAUDE_KEY_FD);

    const child = spawnImpl(request.command, request.args, {
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      env,
      // Plain pipes only: no 'ipc' entry, so the CLI has no process.send and
      // takes the socket branch of its descriptor input.
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      signal: request.signal,
    });
    options.onSpawn?.(child);
    const stdin = child.stdin;
    const stdout = child.stdout;
    const keyChannel = child.stdio[CLAUDE_KEY_FD];
    if (stdin === null || stdout === null || !(keyChannel instanceof Writable)) {
      child.kill("SIGKILL");
      throw new ClaudeSpawnRefusedError("the spawned CLI has no stdin, stdout or key pipe");
    }
    keyChannel.on("error", () => {
      // A CLI that dies before reading leaves the write failing; the SDK sees
      // the exit. Kill so nothing keeps running on a half-delivered key.
      child.kill("SIGKILL");
    });
    keyChannel.end(`${options.key}\n`, () => keyChannel.destroy());

    const stderr = child.stderr;
    if (stderr !== null) {
      let pending = "";
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => {
        pending += chunk;
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          sink(redactSecrets(pending.slice(0, newline), secrets));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      });
      stderr.on("end", () => {
        if (pending.length > 0) sink(redactSecrets(pending, secrets));
        pending = "";
      });
    }
    return Object.assign(child, { stdin, stdout });
  };
}
