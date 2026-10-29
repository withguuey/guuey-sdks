#!/usr/bin/env node
/**
 * `@guuey/host` — the universal config-driven Guuey worker.
 *
 * Reads the resolved agent.json snapshot (`GUUEY_AGENT_SNAPSHOT`), lazily
 * loads the runner for `snapshot.framework`, and drives one turn per
 * `invoke`, emitting each framework-native event to fd-3 as a `native`
 * WorkerEvent. The Router dispatches those to the matching
 * `@silverprotocol/<framework>` normalizer. On the runner's result it emits
 * `done`; on a throw it emits `error`; on `shutdown` (or stdin EOF) it exits.
 *
 * **Thin-wrapper contract:** the agent runtimes
 * (`@anthropic-ai/claude-agent-sdk`, `@openai/agents`, `@google/adk`) are
 * OPTIONAL PEER dependencies — the host is orchestration; the runtime is the
 * installer's declaration (the platform pins them in
 * `@guuey-private/host-shared`, the `/shared` composition package). Runners
 * are loaded via dynamic `import()` so a pod only ever loads the one SDK its
 * framework needs; a missing peer fails with an actionable install hint, not
 * a bare module-resolution stack.
 *
 * Runs inside bubblewrap with NO IRSA — it never mints federation tokens. Every
 * MCP server's entry comes from what the Router-side credential broker wrote,
 * read by `@guuey/worker`'s `listCredentials`: the servers file named by
 * `GUUEY_MCP_SERVERS_FILE` when the platform sets it (the session directory is
 * then never read), else `<sessionDir>/.guuey/credentials/<srv>.json`.
 *
 * Protocol wiring (per `@guuey/worker`): Router→Worker control on fd 0 (stdin),
 * Worker→Router events on fd 3. We use the raw emitter (NOT the text-only
 * `serve(handler)`) because the host emits `native`.
 */
import { createWriteStream, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LAUNCH_ENVELOPE_FD_ENV,
  createEmitter,
  isInvoke,
  isShutdown,
  parseControl,
  readLaunchEnvelope,
  type Emitter,
  type Invoke,
  type LaunchEnvelope,
} from "@guuey/worker";
import type { GuueyAgent } from "@guuey/config";
import { lines } from "./stdin-lines.js";
import type { HostBoot } from "./boot-context.js";
import { assertHostInspectorGuard } from "./inspector-guard.js";

/** The snapshot shape the host boots from (`framework` selects the runner). */
export type HostSnapshot = GuueyAgent & { framework?: string };

/**
 * One turn's input, as a runner receives it — the `Invoke` control message
 * minus the discriminator.
 */
export type HostTurn = Omit<Invoke, "type">;

export type { HostBoot } from "./boot-context.js";

/** The uniform surface every framework runner module exposes. */
export interface FrameworkRunner {
  /** Run one turn: drive the SDK, emit native events; resolve when the turn ends. */
  runTurn(snapshot: HostSnapshot, turn: HostTurn, emit: Emitter): Promise<void>;
}

/**
 * Per-framework runner registry: module path + the peer package whose absence
 * is the overwhelmingly likely cause of an import failure (the install hint).
 */
const RUNNERS: Record<string, { module: string; peer: string; agentEntry: boolean }> = {
  "claude-agent-sdk": { module: "./frameworks/claude-runner.js", peer: "@anthropic-ai/claude-agent-sdk", agentEntry: false },
  "openai-agents-sdk": { module: "./frameworks/openai-runner.js", peer: "@openai/agents", agentEntry: false },
  "google-adk": { module: "./frameworks/google-adk.js", peer: "@google/adk", agentEntry: true },
};

/**
 * Graceful mode (`GUUEY_AGENT_ENTRY`) is per-runner: a framework whose runner
 * ignores the entry env must FAIL LOUDLY, not silently run the no-code
 * snapshot instead of the dev's module ("non-goal" means
 * rejected, not ignored). Boot-time check, same posture as a missing peer.
 */
export function assertGracefulSupport(framework: string, agentEntryEnv: string | undefined): void {
  if (agentEntryEnv === undefined || agentEntryEnv === "") return;
  const entry = RUNNERS[framework];
  if (entry !== undefined && !entry.agentEntry) {
    throw new Error(
      `@guuey/host: guuey.json#agent.entry (graceful mode) is not supported for framework "${framework}" yet — ` +
        `only ${Object.entries(RUNNERS)
          .filter(([, r]) => r.agentEntry)
          .map(([f]) => f)
          .join(", ")} run a dev-exported agent module. ` +
        `Use a full worker (serveNative) for this framework, or remove agent.entry.`,
    );
  }
}

/** Parse the boot snapshot — the resolved `agent` section (a {@link GuueyAgent}). */
function readSnapshot(): HostSnapshot {
  const raw = process.env.GUUEY_AGENT_SNAPSHOT ?? "{}";
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("@guuey/host: GUUEY_AGENT_SNAPSHOT must be a JSON object (the agent section).");
  }
  return parsed as HostSnapshot;
}

/**
 * Load the runner for `framework`, translating a module-resolution failure
 * into the actionable missing-peer message (the runtimes are optional peers —
 * the host deliberately does not bundle them).
 */
export async function loadRunner(framework: string, boot: HostBoot = {}): Promise<FrameworkRunner> {
  const entry = RUNNERS[framework];
  if (!entry) {
    throw new Error(
      `@guuey/host: unknown framework "${framework}" — supported: ${Object.keys(RUNNERS).join(", ")}`,
    );
  }
  try {
    const mod = (await import(entry.module)) as { createRunner: (boot: HostBoot) => FrameworkRunner };
    return mod.createRunner(boot);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(
        `@guuey/host: cannot load the "${framework}" runner — its runtime is an optional peer. ` +
          `Install ${entry.peer} next to @guuey/host to run this framework. (${String(err)})`,
      );
    }
    throw err;
  }
}

/**
 * Boot step one (guuey#2139): obtain the private launch envelope, before any
 * runner module is imported and before anything is spawned.
 *
 * With the marker set this is a platform launch, so the inspector guard runs
 * first and a refused startup never reads the descriptor. The read closes the
 * descriptor and asserts it closed, so no child the host starts later can
 * inherit it. With the marker absent (local `guuey dev`) no envelope is read
 * and no descriptor check is made: an open fd 5 is not refused, because Node
 * opens its own descriptors at the low numbers and an open fd 5 there proves
 * nothing about inheritance (see the header of `@guuey/worker`'s
 * launch-envelope.ts).
 */
export async function bootEnvelope(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): Promise<LaunchEnvelope | undefined> {
  if (env[LAUNCH_ENVELOPE_FD_ENV] !== undefined) assertHostInspectorGuard({ execArgv, env });
  return readLaunchEnvelope({ env });
}

/** The worker loop: per `invoke` run the framework runner; on `shutdown`/EOF exit. */
async function main(): Promise<void> {
  // fd 3 is the write end of the pipe the Router created at spawn.
  const out = createWriteStream("", { fd: 3 });
  const emit: Emitter = createEmitter(out);
  let envelope: LaunchEnvelope | undefined;
  try {
    envelope = await bootEnvelope();
  } catch (err) {
    // Fail closed: no runner is loaded and nothing is spawned. The message
    // names the refusal, never a payload byte.
    emit.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    out.end();
    return;
  }
  const snapshot = readSnapshot();
  const framework = snapshot.framework ?? "claude-agent-sdk";
  // Load ONCE at boot — the pod runs one framework for its whole life, and a
  // missing peer must fail the first turn loudly, not lazily mid-session.
  assertGracefulSupport(framework, process.env.GUUEY_AGENT_ENTRY);
  const runner = await loadRunner(framework, envelope !== undefined ? { envelope } : {});

  for await (const line of lines(process.stdin)) {
    const msg = parseControl(line);
    if (isShutdown(msg)) break;
    if (!isInvoke(msg)) continue;
    const { type: _type, ...turn } = msg;
    // Turns are sequential — await this invoke before reading the next line.
    await runner.runTurn(snapshot, turn, emit);
  }
}

/**
 * Whether this module is the process entry (`node <host>/dist/index.js`, the
 * `guuey-host` bin, or `guuey dev`'s resolved entry). Importing the module
 * (its tests, a runner lookup) never starts the worker loop.
 */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || !existsSync(entry)) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isProcessEntry()) {
  main().catch((err: unknown) => {
    process.stderr.write(`@guuey/host fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
