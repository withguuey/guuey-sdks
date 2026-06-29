#!/usr/bin/env node
/**
 * `@guuey/host` — the universal config-driven Guuey worker.
 *
 * Reads the resolved agent.json snapshot (`GUUEY_AGENT_SNAPSHOT`), runs the
 * Claude Agent SDK per invoke, and emits each native `SDKMessage` to fd-3 as a
 * `native` WorkerEvent. The Router dispatches those to the matching
 * `@silverprotocol/<framework>` normalizer. On the SDK result it emits `done`;
 * on a throw it emits `error`; on `shutdown` (or stdin EOF) it exits.
 *
 * Runs inside bubblewrap with NO IRSA — it never mints federation tokens. A
 * federated MCP server's credentials are read from the well-known path the
 * Router-side credential broker wrote: `<sessionDir>/.guuey/credentials/<srv>.json`.
 *
 * Protocol wiring (per `@guuey/worker`): Router→Worker control on fd 0 (stdin),
 * Worker→Router events on fd 3. We use the raw emitter (NOT the text-only
 * `serve(handler)`) because the host emits `native`.
 */
import { createWriteStream, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { run as openaiRun, setDefaultOpenAIKey } from "@openai/agents";
import {
  createEmitter,
  isInvoke,
  isShutdown,
  parseControl,
  type Emitter,
  type Fs,
} from "@guuey/worker";
import type { GuueyAgent } from "@guuey/config";
import { runInvoke, type HostInvoke, type HostRuntime } from "./run.js";
import { runInvokeOpenai, type OpenaiRunFn } from "./run-openai.js";
import type { CredentialFile } from "./options.js";
import { buildHostContext } from "./boot-context.js";

/** The OpenAI framework tag (matches `AgentFramework`). */
const OPENAI_FRAMEWORK = "openai-agents-sdk";

/**
 * The real `@openai/agents` `run` (streamed overload), narrowed to the injected
 * {@link OpenaiRunFn} surface the loop consumes. The SDK's `run` is generic over
 * the agent + context; the loop only needs `(agent, input, {stream,maxTurns}) →
 * a streamed result`. A typed adapter (NOT a cast) pins the streamed overload.
 */
const realOpenaiRun: OpenaiRunFn = (agent, input, options) =>
  openaiRun(agent, input, { stream: true, ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}) });

/** Parse the boot snapshot — the resolved `agent` section (a {@link GuueyAgent}). */
function readSnapshot(): GuueyAgent & { framework?: string } {
  const raw = process.env.GUUEY_AGENT_SNAPSHOT ?? "{}";
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("@guuey/host: GUUEY_AGENT_SNAPSHOT must be a JSON object (the agent section).");
  }
  return parsed as GuueyAgent & { framework?: string };
}

/**
 * Read all credential files the Router broker wrote to
 * `<sessionDir>/.guuey/credentials/` this invoke. Returns one
 * `{ name, cred }` per valid `.json` file — malformed files are silently
 * skipped (never crash the turn). Missing directory → empty array (no MCP).
 */
function listCredentials(fs: Fs): () => Array<{ name: string; cred: CredentialFile }> {
  return () => {
    const dir = join(fs.session, ".guuey", "credentials");
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return []; // no cred dir this turn → no MCP.
    }
    const out: Array<{ name: string; cred: CredentialFile }> = [];
    for (const file of names) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          typeof (parsed as { url?: unknown }).url === "string" &&
          ((parsed as { transport?: unknown }).transport === "http" ||
            (parsed as { transport?: unknown }).transport === "sse")
        ) {
          out.push({ name: file.replace(/\.json$/, ""), cred: parsed as CredentialFile });
        }
      } catch {
        // malformed file → skip (never crash the turn).
      }
    }
    return out;
  };
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

/** The worker loop: per `invoke` run the SDK emitting native; on `shutdown`/EOF exit. */
async function main(): Promise<void> {
  const snapshot = readSnapshot();
  // fd 3 is the write end of the pipe the Router created at spawn.
  const out = createWriteStream("", { fd: 3 });
  const emit: Emitter = createEmitter(out);
  const isOpenai = snapshot.framework === OPENAI_FRAMEWORK;

  // Resolve the framework-correct credentials once at boot.
  //
  //  - OpenAI path: the key (or opaque broker token in hosted mode) is applied
  //    globally to the SDK via `setDefaultOpenAIKey`. The OpenAI SDK also reads
  //    `OPENAI_BASE_URL` + `OPENAI_API_KEY` from env directly, so the broker
  //    env injected by Task 8's `buildWorkerEnv` already routes it — no extra
  //    wiring needed here.
  //  - Claude path (hosted/broker): `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
  //    are set by the broker (Task 8); they ride the per-invoke `HostRuntime` →
  //    `BuildOptionsContext` → `options.env`. The real `ANTHROPIC_API_KEY` is
  //    intentionally absent so it cannot leak to agent code.
  //  - Claude path (local-dev): only `ANTHROPIC_API_KEY` is set; the broker
  //    fields are absent, `buildOptions` falls back to the direct-key path.
  //
  // A missing key is NOT fatal here — each run path emits a clear `error` per
  // invoke if neither the broker credentials nor a direct key are present.
  const bootCtx = buildHostContext(process.env);
  if (isOpenai && bootCtx.openaiKey !== undefined) setDefaultOpenAIKey(bootCtx.openaiKey);

  for await (const line of lines(process.stdin)) {
    const msg = parseControl(line);
    if (isShutdown(msg)) break;
    if (!isInvoke(msg)) continue;

    // Broker fields (`baseUrl`/`authToken`) are only wired for the Claude path.
    // The OpenAI SDK reads OPENAI_BASE_URL + OPENAI_API_KEY from env directly.
    const runtime: HostRuntime = {
      listCredentials: listCredentials(msg.fs),
      ...(isOpenai
        ? {}
        : {
            ...(bootCtx.anthropicApiKey !== undefined ? { apiKey: bootCtx.anthropicApiKey } : {}),
            ...(bootCtx.anthropicBaseUrl !== undefined ? { baseUrl: bootCtx.anthropicBaseUrl } : {}),
            ...(bootCtx.anthropicAuthToken !== undefined ? { authToken: bootCtx.anthropicAuthToken } : {}),
          }
      ),
    };
    // §1.4 push-by-value context now arrives TYPED on the Invoke (extended in
    // Task 3) — no raw-line re-parse. `priorState` uses a `!== undefined` gate so
    // a falsy blob (null/0/"") still feeds the preamble.
    const invoke: HostInvoke = {
      input: msg.input,
      identity: msg.identity,
      fs: msg.fs,
      history: msg.history,
      ...(msg.priorMemory !== undefined ? { priorMemory: msg.priorMemory } : {}),
      ...(msg.priorState !== undefined ? { priorState: msg.priorState } : {}),
    };
    // Turns are sequential — await this invoke before reading the next line.
    // Select the framework-correct run path: OpenAI agents vs the Claude SDK.
    if (isOpenai) {
      await runInvokeOpenai(snapshot, invoke, runtime, emit, realOpenaiRun);
    } else {
      await runInvoke(snapshot, invoke, runtime, emit, query);
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`@guuey/host fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
