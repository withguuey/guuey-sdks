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
import type {
  McpServerConfig,
  McpServerStatus,
  McpSetServersResult,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CredentialFile,
  Emitter,
  Fs,
  HistoryMessage,
  Identity,
  InputKind,
  JsonValue,
  ProfileSection,
  StopReason, McpAvailability, FirstImpressionPush, FirstImpressionShown, WithheldTool } from "@guuey/worker";
import {
  buildOptions,
  reservedEnvNamesDropped,
  resolveMcpServers,
  type BuildOptionsContext,
  type PriorMemoryRecord,
} from "./claude-options.js";
import { resolveSdkVersion } from "../sdk-version.js";
import { HOST_INPUT_KIND_CAPABILITIES, modelInputOf } from "../model-text.js";
import { reportToolGateErrors } from "../mcp-tool-gates.js";

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
  /**
   * guuey#2549: set when the user typed nothing and the turn's content rode on the page context;
   * the arm's model text goes through `modelInputOf` (`../model-text.ts`). See `Invoke.inputKind`.
   */
  inputKind?: InputKind;
  identity: Identity;
  fs: Fs;
  /**
   * Whether `fs` names REAL GuueyFS layers this turn (guuey#234) — the gate
   * for the built-in file tools + `Bash`. See `Invoke.fsBound` in
   * `@guuey/worker`. Absent/false → purely MCP-driven.
   */
  fsBound?: boolean;
  history: HistoryMessage[];
  priorMemory?: PriorMemoryRecord[];
  priorState?: JsonValue;
  userMemory?: string;
  /**
   * Whether the memory MCP child booted this pod (memory-mcp T5) — gates the
   * SAVE instruction on `authenticated && memoryAttached`, independent of
   * `userMemory` (the bootstrap fix). See `Invoke.memoryAttached` in
   * `@guuey/worker`.
   */
  memoryAttached?: boolean;
  /**
   * The resolved cross-app profile access for this invoke (cross-app-profile
   * T7) — gates the profile system-prompt section: the `save_profile` SAVE
   * instruction on `read-write`, the RECALL block on {@link profileSections}.
   * Present only for a consenting authenticated caller. See `Invoke.profileAccess`
   * in `@guuey/worker`.
   */
  profileAccess?: "read" | "read-write";
  /** The user's cross-app profile sections for the RECALL push (cross-app-profile
   *  T7). See `Invoke.profileSections` in `@guuey/worker`. */
  profileSections?: ProfileSection[];
  /** The first-impression push (guuey#1183) — see `Invoke.firstImpression` in `@guuey/worker`; rendered only with the ggui rail armed. */
  firstImpression?: FirstImpressionPush;
  /** The Router's per-turn tool withholds — see `Invoke.withheldTools` in `@guuey/worker`; removed from this turn's catalog. */
  withheldTools?: WithheldTool[];
  /** The welcome card the Router already drew — see `Invoke.firstImpressionShown` in `@guuey/worker`. */
  firstImpressionShown?: FirstImpressionShown;
  /**
   * How many builder-provided reference files sit at `<fs.app>/resources` this
   * turn (guuey#456 B4) — present only when the layers are REAL and the count
   * is positive. Gates the app-resources system-prompt section together with
   * {@link fsBound}. See `Invoke.resourceCount` in `@guuey/worker`.
   */
  resourceCount?: number;
  /**
   * Whether the ggui generative-UI rail is ARMED this turn (guuey#630) — set
   * only when the ggui credential was actually written. Gates the
   * generative-UI system-prompt section. See `Invoke.gguiAttached` in
   * `@guuey/worker`.
   */
  gguiAttached?: boolean;
  /** guuey#901: per OAuth server, its availability this turn — the "Connected services" section. */
  mcpAvailability?: McpAvailability[];
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

/**
 * The `Query` surface the loop needs — the real SDK `Query` satisfies it: the
 * message stream plus the two control requests the MCP-ready gate uses
 * (guuey#2139: servers ride the CLI's stdin, never `--mcp-config` argv).
 */
export interface QueryHandle extends AsyncIterable<SDKMessage> {
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  close(): void;
}

/** The `query` surface the loop needs — the real SDK `query` satisfies it (streaming input). */
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => QueryHandle;

/**
 * How long the CLI may take to start and answer the first control request
 * (`setMcpServers`). A CLI that never answers fails the turn closed: the query
 * is closed (the CLI killed) and no user message is ever sent.
 *
 * Longer than the CLI's own MCP connection timeout: the pinned CLI (2.1.282)
 * connects the servers before it answers `setMcpServers`, and gives a server
 * that never answers `initialize` up to `MCP_TIMEOUT` (default 30 s) before it
 * reports it failed. Measured: ~30.7 s on this path, ~30.8 s on the old
 * `--mcp-config` path before the first model request. So a hung MCP server
 * still costs the same wait and the turn goes on without it, as before; only
 * a CLI that answers nothing at all hits this deadline.
 */
export const CLAUDE_STARTUP_DEADLINE_MS = 60_000;
/**
 * How long the MCP servers may stay `pending` after `setMcpServers` before the
 * turn proceeds without them (each still-pending server is reported by name).
 * Bounds the wait whether the CLI connects them before answering or after.
 */
export const CLAUDE_MCP_READY_DEADLINE_MS = 15_000;
const MCP_STATUS_POLL_MS = 100;

/** Timing knobs; tests shorten them. */
export interface ClaudeTurnTiming {
  startupDeadlineMs?: number;
  mcpReadyDeadlineMs?: number;
}

/** A refused or failed CLI startup. */
export class ClaudeStartupError extends Error {
  constructor(reason: string) {
    super(`Claude CLI startup failed: ${reason}`);
    this.name = "ClaudeStartupError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve with `work`, or reject with `onTimeout()` once `ms` elapse first. */
function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Hand the turn's MCP servers to the CLI over stdin and wait until none is
 * `pending`, within the deadlines. Returns one line per server that did not
 * connect (failed, needs-auth, an error from the call, or still pending at the
 * deadline): the turn proceeds without those, exactly as a server that fails
 * to connect at CLI startup did before. Throws {@link ClaudeStartupError} when
 * the CLI does not answer the control request in time.
 */
export async function awaitMcpReady(
  q: QueryHandle,
  servers: Record<string, McpServerConfig>,
  timing: ClaudeTurnTiming = {},
): Promise<string[]> {
  const startupMs = timing.startupDeadlineMs ?? CLAUDE_STARTUP_DEADLINE_MS;
  const readyMs = timing.mcpReadyDeadlineMs ?? CLAUDE_MCP_READY_DEADLINE_MS;
  const result = await withDeadline(
    q.setMcpServers(servers),
    startupMs,
    () => new ClaudeStartupError(`no answer to setMcpServers within ${String(startupMs)} ms`),
  );
  const names = Object.keys(servers);
  const problems = new Map<string, string>();
  for (const [name, message] of Object.entries(result.errors)) problems.set(name, `error: ${message}`);
  if (names.length === 0) return [];
  const readyBy = Date.now() + readyMs;
  for (;;) {
    const statuses = await withDeadline(
      q.mcpServerStatus(),
      startupMs,
      () => new ClaudeStartupError(`no answer to mcpServerStatus within ${String(startupMs)} ms`),
    );
    const ours = statuses.filter((status) => names.includes(status.name));
    const pending = ours.filter((status) => status.status === "pending").map((status) => status.name);
    if (pending.length === 0 || Date.now() >= readyBy) {
      for (const status of ours) {
        if (status.status === "connected") continue;
        if (!problems.has(status.name)) {
          problems.set(status.name, status.status === "pending" ? `still pending after ${String(readyMs)} ms` : status.status);
        }
      }
      for (const name of names) {
        if (!ours.some((status) => status.name === name) && !problems.has(name)) problems.set(name, "not reported");
      }
      return [...problems.entries()].map(([name, why]) => `MCP server "${name}" not connected: ${why}`);
    }
    await sleep(MCP_STATUS_POLL_MS);
  }
}

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
  timing: ClaudeTurnTiming = {},
): Promise<void> {
  // The SDK-version handshake (§8 item B, additive-optional) — ALWAYS the
  // first event of this invoke's fd-3 stream, before the framework gate or any
  // native/turn event. `sdkVersion` is resolved at runtime, never hardcoded;
  // `null` (SDK not resolvable) is tolerated by the Router.
  emit.hello(CLAUDE_FRAMEWORK, CLAUDE_SDK_PACKAGE, resolveSdkVersion(CLAUDE_SDK_PACKAGE), HOST_INPUT_KIND_CAPABILITIES);

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
  let ctx: BuildOptionsContext;
  try {
    ctx = {
      input: invoke.input,
      identity: invoke.identity,
      fs: invoke.fs,
      ...(invoke.fsBound !== undefined ? { fsBound: invoke.fsBound } : {}),
      history: invoke.history,
      listCredentials: runtime.listCredentials,
      ...(runtime.apiKey !== undefined ? { apiKey: runtime.apiKey } : {}),
      ...(runtime.baseUrl !== undefined ? { baseUrl: runtime.baseUrl } : {}),
      ...(runtime.authToken !== undefined ? { authToken: runtime.authToken } : {}),
      ...(invoke.priorMemory !== undefined ? { priorMemory: invoke.priorMemory } : {}),
      ...(invoke.priorState !== undefined ? { priorState: invoke.priorState } : {}),
      ...(invoke.userMemory !== undefined ? { userMemory: invoke.userMemory } : {}),
      ...(invoke.memoryAttached !== undefined ? { memoryAttached: invoke.memoryAttached } : {}),
      ...(invoke.profileAccess !== undefined ? { profileAccess: invoke.profileAccess } : {}),
      ...(invoke.profileSections !== undefined ? { profileSections: invoke.profileSections } : {}),
      ...(invoke.resourceCount !== undefined ? { resourceCount: invoke.resourceCount } : {}),
      ...(invoke.gguiAttached !== undefined ? { gguiAttached: invoke.gguiAttached } : {}),
      // guuey#1183 — the first-impression push reaches buildOptions: it renders
      // the verbatim handshake section AND turns extended thinking off for this
      // invoke (the model-egress force is refused beside thinking). Dropped from
      // this ctx since the push landed (30c0db0ad): the OpenAI and ADK paths
      // read `invoke.firstImpression` directly, the Claude path only through
      // here — so on claude-agent-sdk neither the section nor the knob ever ran.
      ...(invoke.firstImpression !== undefined ? { firstImpression: invoke.firstImpression } : {}),
      ...(invoke.mcpAvailability !== undefined ? { mcpAvailability: invoke.mcpAvailability } : {}),
      // The Router's per-turn tool withholds → `disallowedTools` (servers attached this turn only).
      ...(invoke.withheldTools !== undefined ? { withheldTools: invoke.withheldTools } : {}),
      // The welcome card the Router already drew → its section in the system prompt.
      ...(invoke.firstImpressionShown !== undefined ? { firstImpressionShown: invoke.firstImpressionShown } : {}),
    };
    options = buildOptions(snapshot, ctx);
    reportToolGateErrors(snapshot.tools);
  } catch (err) {
    emit.error(err instanceof Error ? err.message : String(err));
    return;
  }
  // The runtime-owned names buildOptions left out of the agent's environment,
  // reported on stderr (names only) so the drop is never silent.
  const droppedEnv = reservedEnvNamesDropped(snapshot);
  if (droppedEnv.length > 0) {
    process.stderr.write(
      `[guuey] agent.env: ${droppedEnv.join(", ")} left out of the agent's environment: ` +
        "reserved by the platform runtime. Remove them from agent.env.\n",
    );
  }

  // Streaming input (guuey#2139): the one user message is yielded only after
  // the MCP-ready gate below decided, and the input ends once the result
  // arrives, which closes the CLI's stdin as the string-prompt path did.
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let endInput!: () => void;
  const inputDone = new Promise<void>((resolve) => {
    endInput = resolve;
  });
  let sendMessage = false;
  async function* userMessages(): AsyncGenerator<SDKUserMessage> {
    await gate;
    if (!sendMessage) return;
    yield {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: modelInputOf(invoke) }] },
      parent_tool_use_id: null,
    };
    await inputDone;
  }

  let q: QueryHandle;
  try {
    q = query({ prompt: userMessages(), options });
  } catch (err) {
    emit.error(err instanceof Error ? err.message : String(err));
    return;
  }
  let done: { stopReason: StopReason; result: string } | undefined;
  const messages = (async (): Promise<void> => {
    for await (const msg of q) {
      emit.native(CLAUDE_FRAMEWORK, toJson(msg));
      if (isResultMessage(msg)) {
        done = resultToDone(msg);
        endInput();
      }
    }
  })();
  // Observe a stream failure now; it is reported below, after the gate.
  const streamOutcome = messages.then(
    () => undefined,
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  );

  try {
    const problems = await awaitMcpReady(q, resolveMcpServers(ctx), timing);
    // Reported on stderr only, NOT through the `mcpAvailability` / `error`
    // path (guuey#2139): `mcpAvailability` is the Router's pre-turn input,
    // already rendered into the system prompt the CLI was spawned with, so a
    // server that fails here cannot reach it; and a new worker event for it
    // would be a cross-surface wire change. This equals the pre-change CLI,
    // which also went on without a server that failed to connect at its
    // startup.
    for (const line of problems) process.stderr.write(`[guuey] ${line}\n`);
  } catch (err) {
    // Fail closed: no user message is sent, the CLI is closed (killed), and
    // the turn ends with one error.
    endInput();
    openGate();
    q.close();
    await streamOutcome;
    emit.error(err instanceof Error ? err.message : String(err));
    return;
  }
  sendMessage = true;
  openGate();
  const failure = await streamOutcome;
  endInput();
  if (failure !== undefined) {
    emit.error(failure.message);
    return;
  }
  emit.done(done?.result ?? "", done?.stopReason ?? "end_turn");
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
