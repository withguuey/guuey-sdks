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
 * Runs inside bubblewrap with NO IRSA — it never mints federation tokens. A
 * federated MCP server's credentials are read from the well-known path the
 * Router-side credential broker wrote: `<sessionDir>/.guuey/credentials/<srv>.json`.
 *
 * Protocol wiring (per `@guuey/worker`): Router→Worker control on fd 0 (stdin),
 * Worker→Router events on fd 3. We use the raw emitter (NOT the text-only
 * `serve(handler)`) because the host emits `native`.
 */
import { createWriteStream } from "node:fs";
import {
  createEmitter,
  isInvoke,
  isShutdown,
  parseControl,
  type Emitter,
  type Invoke,
} from "@guuey/worker";
import type { GuueyAgent } from "@guuey/config";

/** The snapshot shape the host boots from (`framework` selects the runner). */
export type HostSnapshot = GuueyAgent & { framework?: string };

/**
 * One turn's input, as a runner receives it — the `Invoke` control message
 * minus the discriminator.
 */
export type HostTurn = Omit<Invoke, "type">;

/** The uniform surface every framework runner module exposes. */
export interface FrameworkRunner {
  /** Run one turn: drive the SDK, emit native events; resolve when the turn ends. */
  runTurn(snapshot: HostSnapshot, turn: HostTurn, emit: Emitter): Promise<void>;
}

/**
 * Per-framework runner registry: module path + the peer package whose absence
 * is the overwhelmingly likely cause of an import failure (the install hint).
 */
const RUNNERS: Record<string, { module: string; peer: string }> = {
  "claude-agent-sdk": { module: "./frameworks/claude-runner.js", peer: "@anthropic-ai/claude-agent-sdk" },
  "openai-agents-sdk": { module: "./frameworks/openai-runner.js", peer: "@openai/agents" },
  "google-adk": { module: "./frameworks/google-adk.js", peer: "@google/adk" },
};

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
export async function loadRunner(framework: string): Promise<FrameworkRunner> {
  const entry = RUNNERS[framework];
  if (!entry) {
    throw new Error(
      `@guuey/host: unknown framework "${framework}" — supported: ${Object.keys(RUNNERS).join(", ")}`,
    );
  }
  try {
    const mod = (await import(entry.module)) as { createRunner: () => FrameworkRunner };
    return mod.createRunner();
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

/** Async-iterate NDJSON lines off stdin. */
async function* lines(input: NodeJS.ReadableStream): AsyncIterable<string> {
  let buf = "";
  for await (const chunk of input) {
    buf += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) yield line;
      nl = buf.indexOf("\n");
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) yield tail;
}

/** The worker loop: per `invoke` run the framework runner; on `shutdown`/EOF exit. */
async function main(): Promise<void> {
  const snapshot = readSnapshot();
  const framework = snapshot.framework ?? "claude-agent-sdk";
  // fd 3 is the write end of the pipe the Router created at spawn.
  const out = createWriteStream("", { fd: 3 });
  const emit: Emitter = createEmitter(out);
  // Load ONCE at boot — the pod runs one framework for its whole life, and a
  // missing peer must fail the first turn loudly, not lazily mid-session.
  const runner = await loadRunner(framework);

  for await (const line of lines(process.stdin)) {
    const msg = parseControl(line);
    if (isShutdown(msg)) break;
    if (!isInvoke(msg)) continue;
    const { type: _type, ...turn } = msg;
    // Turns are sequential — await this invoke before reading the next line.
    await runner.runTurn(snapshot, turn, emit);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`@guuey/host fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
