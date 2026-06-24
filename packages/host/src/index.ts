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
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
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
import type { CredentialFile } from "./options.js";

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
 * Read `<sessionDir>/.guuey/credentials/<server>.json` (the Router-broker
 * contract). Returns `undefined` when the file is absent (federation
 * unconfigured) or unreadable — the federated server is then skipped this turn.
 */
function makeCredentialReader(fs: Fs): (server: string) => CredentialFile | undefined {
  return (server: string): CredentialFile | undefined => {
    const path = join(fs.session, ".guuey", "credentials", `${server}.json`);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return undefined; // absent → no federated MCP this turn.
    }
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { url?: unknown }).url !== "string"
    ) {
      throw new Error(`@guuey/host: malformed credential file at ${path} (missing string url).`);
    }
    const obj = parsed as { url: string; headers?: unknown; expiresAt?: unknown };
    const headers: Record<string, string> = {};
    if (typeof obj.headers === "object" && obj.headers !== null && !Array.isArray(obj.headers)) {
      for (const [k, v] of Object.entries(obj.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
    return {
      url: obj.url,
      headers,
      ...(typeof obj.expiresAt === "string" ? { expiresAt: obj.expiresAt } : {}),
    };
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
  const apiKey = process.env.ANTHROPIC_API_KEY;

  for await (const line of lines(process.stdin)) {
    const msg = parseControl(line);
    if (isShutdown(msg)) break;
    if (!isInvoke(msg)) continue;

    const runtime: HostRuntime = {
      readCredential: makeCredentialReader(msg.fs),
      ...(apiKey !== undefined ? { apiKey } : {}),
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
    await runInvoke(snapshot, invoke, runtime, emit, query);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`@guuey/host fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
