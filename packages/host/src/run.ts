/**
 * The testable core of the worker loop. `runInvoke` runs one invoke through the
 * Claude Agent SDK and emits each native `SDKMessage` to fd-3 as a `native`
 * WorkerEvent (the Router dispatches them to the matching normalizer). On the
 * SDK result message it emits `done`; on a throw or a framework-gate violation
 * it emits `error`.
 *
 * `query` is injected so the loop is unit-testable without a live model. The
 * worker entrypoint (`index.ts`) passes the real `@anthropic-ai/claude-agent-sdk`
 * `query`.
 */
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Emitter, Fs, HistoryMessage, Identity, JsonValue, StopReason } from "@guuey/worker";
import {
  buildOptions,
  type BuildOptionsContext,
  type CredentialFile,
  type PriorMemoryRecord,
} from "./options.js";

/** The framework this host runs. Other frameworks are a follow-slice. */
const CLAUDE_FRAMEWORK = "claude-agent-sdk";

/**
 * The invoke this host consumes. A superset of `@guuey/worker`'s `Invoke`:
 * `priorMemory`/`priorState` are the §1.4 push-by-value context the worker reads
 * for the preamble (the Worker Protocol `Invoke` is EXTENDED with these in
 * Task 3; until then the worker loop parses them off the raw control line).
 */
export interface HostInvoke {
  input: string;
  identity: Identity;
  fs: Fs;
  history: HistoryMessage[];
  priorMemory?: PriorMemoryRecord[];
  priorState?: JsonValue;
}

/** Per-process config the worker resolves once at boot. */
export interface HostRuntime {
  /** Anthropic API key (from env). */
  apiKey?: string;
  /** Reads `<sessionDir>/.guuey/credentials/<server>.json` for a federated server. */
  readCredential: (server: string) => CredentialFile | undefined;
}

/** The `query` surface the loop needs — the real SDK `query` satisfies it. */
export type QueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/** An SDK message is the terminal result when `type === 'result'`. */
interface ResultMessage {
  type: "result";
  subtype?: string;
  result?: string;
  stop_reason?: string | null;
}

function isResultMessage(msg: SDKMessage): msg is SDKMessage & ResultMessage {
  return (msg as { type?: unknown }).type === "result";
}

/** Map the SDK result message → the Worker Protocol `done` stopReason + result. */
function resultToDone(msg: SDKMessage & ResultMessage): { stopReason: StopReason; result: string } {
  const result = typeof msg.result === "string" ? msg.result : "";
  const stopReason: StopReason =
    msg.subtype === "success"
      ? "end_turn"
      : msg.subtype === "error_max_turns"
        ? "max_turns"
        : "error";
  return { stopReason, result };
}

/**
 * Run one invoke. Emits `native` per SDKMessage, `done` on the result, `error`
 * on a framework-gate violation or a thrown error. Never throws — every failure
 * path becomes an `error` event so the Router always sees a terminal event.
 */
export async function runInvoke(
  snapshot: { framework?: string } & Parameters<typeof buildOptions>[0],
  invoke: HostInvoke,
  runtime: HostRuntime,
  emit: Emitter,
  query: QueryFn,
): Promise<void> {
  // Framework gate: this slice is Claude-only. OpenAI/ADK = follow slice.
  if (snapshot.framework && snapshot.framework !== CLAUDE_FRAMEWORK) {
    emit.error(
      `@guuey/host: claude-agent-sdk only this slice (got '${snapshot.framework}').`,
    );
    return;
  }

  let options: Options;
  try {
    const ctx: BuildOptionsContext = {
      input: invoke.input,
      identity: invoke.identity,
      fs: invoke.fs,
      history: invoke.history,
      readCredential: runtime.readCredential,
      ...(runtime.apiKey !== undefined ? { apiKey: runtime.apiKey } : {}),
      ...(invoke.priorMemory !== undefined ? { priorMemory: invoke.priorMemory } : {}),
      ...(invoke.priorState !== undefined ? { priorState: invoke.priorState } : {}),
    };
    options = buildOptions(snapshot, ctx);
  } catch (err) {
    emit.error(err instanceof Error ? err.message : String(err));
    return;
  }

  try {
    let done: { stopReason: StopReason; result: string } | undefined;
    for await (const msg of query({ prompt: invoke.input, options })) {
      emit.native(CLAUDE_FRAMEWORK, toJson(msg));
      if (isResultMessage(msg)) done = resultToDone(msg);
    }
    emit.done(done?.result ?? "", done?.stopReason ?? "end_turn");
  } catch (err) {
    emit.error(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Coerce one SDKMessage to the `JsonValue` the `native` event carries. SDK
 * messages are plain JSON-serializable objects; the round-trip drops any
 * non-JSON surface (functions/symbols never appear on them) and yields the
 * exact shape the Router's normalizer parses off the wire.
 */
function toJson(msg: SDKMessage): JsonValue {
  return JSON.parse(JSON.stringify(msg)) as JsonValue;
}
