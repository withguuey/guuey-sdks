/**
 * The testable core of the worker loop. `runInvoke` runs one invoke through the
 * Claude Agent SDK and emits each native `SDKMessage` to fd-3 as a `native`
 * WorkerEvent (the Router dispatches them to the matching normalizer). On the
 * SDK result message it emits `done`; on a throw or a framework-gate violation
 * it emits `error`. Emits `hello` FIRST (§8 item B) — the SDK-version handshake.
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
} from "./claude-options.js";
import { resolveSdkVersion } from "../sdk-version.js";

/** The framework THIS run path runs. OpenAI has its own path (`run-openai.ts`). */
const CLAUDE_FRAMEWORK = "claude-agent-sdk";
/** The npm package whose installed version is this framework's `hello.sdkVersion`. */
const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * The invoke this host consumes. Mirrors `@guuey/worker`'s `Invoke` (minus the
 * `type` discriminator): `priorMemory`/`priorState` are the §1.4 push-by-value
 * context the worker renders into the preamble; `userMemory` is the
 * guueyfs-slice4 prompted-file-memory RECALL push (Task 3) — see the doc on
 * `Invoke.userMemory` in `@guuey/worker` for how it differs from `priorMemory`.
 */
export interface HostInvoke {
  input: string;
  identity: Identity;
  fs: Fs;
  history: HistoryMessage[];
  priorMemory?: PriorMemoryRecord[];
  priorState?: JsonValue;
  userMemory?: string;
}

/** Per-process config the worker resolves once at boot. */
export interface HostRuntime {
  /**
   * Anthropic API key — local-dev fallback when `baseUrl`+`authToken` are
   * absent. One of (`baseUrl`+`authToken`) or `apiKey` must be provided;
   * `buildOptions` throws at invoke time if neither is present.
   */
  apiKey?: string;
  /**
   * Loopback proxy base URL (hosted/broker mode). Task 8 injects this as
   * `ANTHROPIC_BASE_URL` via `buildWorkerEnv`. When set together with
   * `authToken`, the Claude CLI subprocess routes through the managed-LLM
   * broker; the real API key is intentionally absent to prevent leaks.
   */
  baseUrl?: string;
  /**
   * Opaque session token for the loopback proxy (hosted/broker mode). Task 8
   * injects this as `ANTHROPIC_AUTH_TOKEN`. Required when `baseUrl` is set.
   */
  authToken?: string;
  /**
   * Returns every credential the Router broker wrote to
   * `<sessionDir>/.guuey/credentials/` this invoke. Injected so the run path
   * stays pure (no disk access inside `runInvoke`).
   */
  listCredentials: () => Array<{ name: string; cred: CredentialFile }>;
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
  // The SDK-version handshake (§8 item B, additive-optional) — ALWAYS the
  // first event of this invoke's fd-3 stream, before the framework gate or any
  // native/turn event. `sdkVersion` is resolved at runtime, never hardcoded;
  // `null` (SDK not resolvable) is tolerated by the Router.
  emit.hello(CLAUDE_FRAMEWORK, CLAUDE_SDK_PACKAGE, resolveSdkVersion(CLAUDE_SDK_PACKAGE));

  // Framework gate: this run path is the Claude SDK. OpenAI agents route to
  // `runInvokeOpenai` (selected in `index.ts` by `snapshot.framework`) and never
  // reach here. A non-claude framework arriving here (e.g. `google-adk`,
  // `vanilla`) has no run path yet → a clear `error`, never a silent mis-run.
  if (snapshot.framework && snapshot.framework !== CLAUDE_FRAMEWORK) {
    emit.error(
      `@guuey/host: the claude run path got framework '${snapshot.framework}'; no run path for it yet.`,
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
      listCredentials: runtime.listCredentials,
      ...(runtime.apiKey !== undefined ? { apiKey: runtime.apiKey } : {}),
      ...(runtime.baseUrl !== undefined ? { baseUrl: runtime.baseUrl } : {}),
      ...(runtime.authToken !== undefined ? { authToken: runtime.authToken } : {}),
      ...(invoke.priorMemory !== undefined ? { priorMemory: invoke.priorMemory } : {}),
      ...(invoke.priorState !== undefined ? { priorState: invoke.priorState } : {}),
      ...(invoke.userMemory !== undefined ? { userMemory: invoke.userMemory } : {}),
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
