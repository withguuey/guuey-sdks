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
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  StopReason, McpAvailability, FirstImpressionPush, FirstImpressionShown, WithheldTool, InvokeImageAttachment,
  AnthropicUserBlock, HelloCliSession, HelloHeaderShas, InvokeCliSession } from "@guuey/worker";
import {
  anthropicUserContent,
  CLAUDE_CLI_FIXED_ROOT,
  CLAUDE_CLI_ROOT_ENV,
  CLI_SESSION_CAPABILITY,
  CLI_SESSION_HASH_VERSION,
  CLI_SESSION_RESUME_FAILED,
  compareStoredSession,
  type CliSessionVerdict,
  invokeImagesCapabilities,
  storeTurnImages,
} from "@guuey/worker";
import { hashSystemPrompt, hashUserBlocks, hashUserText, sha256OfFields } from "./cli-session-hash.js";
import { measureStoredSession } from "./cli-session-store.js";
import {
  buildOptions,
  claudeTurnContext,
  mcpHeaderValuesOf,
  reservedEnvNamesDropped,
  resolveMcpServers,
  type BuildOptionsContext,
  type CliDirs,
  type PriorMemoryRecord,
} from "./claude-options.js";
import {
  SPARE_PARKING_DIR,
  claimOptionsOf,
  delegatingCanUseTool,
  spareAuthTokenOf,
  spareKeyOf,
  spareMismatch,
  type ParkedSpare,
  type PrewarmFn,
} from "./claude-spare.js";
import { resolveSdkVersion } from "../sdk-version.js";
import { MODEL_TEXT_INPUT_KIND_CAPABILITIES } from "@guuey/worker";
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
   * the arm's model text goes through `modelInputOf` (`@guuey/worker`'s `model-text.ts`). See `Invoke.inputKind`.
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
  /** guuey#2386: the UI catalogs the client draws natively; gates the A2UI section. See `Invoke.clientCatalogs`. */
  clientCatalogs?: readonly string[];
  /** guuey#901: per OAuth server, its availability this turn — the "Connected services" section. */
  mcpAvailability?: McpAvailability[];
  /** The turn's images (guuey#2293) — see `Invoke.attachments` in `@guuey/worker`; they reach the model beside `input`. */
  attachments?: InvokeImageAttachment[];
  /** Thread resume (guuey#3407 B3): run the CLI session under the Router's id — see `Invoke.cliSession` in `@guuey/worker`. */
  cliSession?: InvokeCliSession;
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
   * Returns every credential the Router broker wrote for this invoke (the
   * servers file, else `<sessionDir>/.guuey/credentials/`). Injected so the run path
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
  is_error?: boolean;
}

function isResultMessage(msg: SDKMessage): msg is SDKMessage & ResultMessage {
  return (msg as { type?: unknown }).type === "result";
}

/**
 * Map the SDK result message → the Worker Protocol `done` stopReason + result.
 * A `success` result with `is_error: true` is a failed turn whose `result` is
 * the CLI's error text (an API or connection error): it ends with stopReason
 * `error`, never `end_turn`, so a consumer reading only the line protocol does
 * not take that text for the agent's answer (guuey#3114). It stays a `done`,
 * not an `error` event: the turn did end, and its native result carries the
 * failure's detail.
 */
function resultToDone(msg: SDKMessage & ResultMessage): { stopReason: StopReason; result: string } {
  const result = typeof msg.result === "string" ? msg.result : "";
  const stopReason: StopReason =
    msg.subtype === "success"
      ? msg.is_error === true
        ? "error"
        : "end_turn"
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
  takeSpare?: () => Promise<ParkedSpare | undefined>,
): Promise<void> {
  // The SDK-version handshake (§8 item B, additive-optional) — ALWAYS the
  // first event of this invoke's fd-3 stream, before the framework gate or any
  // native/turn event. `sdkVersion` is resolved at runtime, never hardcoded;
  // `null` (SDK not resolvable) is tolerated by the Router.
  // guuey#2293: an invoke carrying images announces that this run path hands
  // them to the model (the Router acknowledges them to the client on this word).
  // guuey#3407 B3: an invoke carrying `cliSession` sends its hello only once the
  // turn's options exist, because that hello reports them (and, on a resume, the
  // stored session). It is still the first event: every failure before it sends
  // a hello without the capability, then the error. Without `cliSession` the
  // hello goes first, exactly as before.
  const hello = helloOnce(emit, [...MODEL_TEXT_INPUT_KIND_CAPABILITIES, ...invokeImagesCapabilities(invoke)]);
  const session = invoke.cliSession;
  if (session === undefined) hello();
  // guuey#2293: the turn's images are also stored in its session storage
  // (@guuey/worker storeTurnImages); a refusal is the person's face, and the
  // turn does not run.
  const imagesFace = storeTurnImages(invoke);
  if (imagesFace !== undefined) {
    hello();
    emit.error(imagesFace);
    return;
  }

  // Framework gate: this run path is the Claude SDK. OpenAI agents route to
  // `runInvokeOpenai` (selected in `index.ts` by `snapshot.framework`) and never
  // reach here. A non-claude framework arriving here (e.g. `google-adk`,
  // `vanilla`) has no run path yet → a clear `error`, never a silent mis-run.
  if (snapshot.framework && snapshot.framework !== CLAUDE_FRAMEWORK) {
    hello();
    emit.error(
      `@guuey/host: the claude run path got framework '${snapshot.framework}'; no run path for it yet.`,
    );
    return;
  }

  // B3 (R5): the session id is the Router's, and only a UUID is run. The host
  // never derives one (R4), and a malformed id stops here, before any spawn.
  if (session !== undefined && !UUID.test(session.id)) {
    hello();
    emit.error(`@guuey/host: cliSession.id must be a UUID (got ${JSON.stringify(session.id.slice(0, 80))}).`);
    return;
  }

  // guuey#3407 leg 5: a spare parked at boot serves this turn only when the
  // turn names no CLI session and its fixed options agree with the spare's;
  // otherwise the spare is closed and the turn starts cold, as before.
  // A discarded spare's root is removed before this turn makes its own: with
  // the platform's fixed root (CLAUDE_CLI_ROOT_ENV) both are the same path.
  let parked = takeSpare !== undefined ? await takeSpare() : undefined;
  if (parked !== undefined && session !== undefined) {
    discardSpare(parked, "the turn names a CLI session");
    parked = undefined;
  }
  if (parked !== undefined) {
    const why = spareMismatchFor(parked, snapshot, invoke, runtime);
    if (why !== undefined) {
      discardSpare(parked, why);
      parked = undefined;
    }
  }

  // The CLI's own state roots for this invoke (BuildOptionsContext.cliDirs):
  // the claimed spare's, or one fresh root made here; removed when the turn ends.
  let made: CliRoot;
  if (parked !== undefined) {
    made = { root: parked.root, bound: false, cliDirs: parked.cliDirs };
  } else {
    try {
      made = makeCliRoot();
    } catch (err) {
      hello();
      emit.error(`@guuey/host: could not make the CLI's per-invoke state directories: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }
  try {
    await runClaudeTurn(snapshot, invoke, runtime, emit, query, timing, made.cliDirs, hello, parked);
  } finally {
    if (made.bound) removeAroundBind(made.root);
    else removeCliRoot(made.root);
  }
}

/** One turn's CLI state root and the five roots under it. */
interface CliRoot {
  root: string;
  /** Whether the root is the jail's bound thread directory tree (B3 R23). */
  bound: boolean;
  cliDirs: CliDirs;
}

/**
 * Make a fresh CLI state root holding the config, cache and XDG roots. No
 * `.claude.json` an earlier turn wrote is read by the CLI that runs in it
 * (BuildOptionsContext.cliDirs). The root is the platform's fixed path when it
 * names one (CLAUDE_CLI_ROOT_ENV); otherwise a random name under this process's
 * temp dir (in the jail, its per-start tmpfs).
 *
 * B3 (hardening's B-2, R23): when the jail has bound the thread directory in,
 * bwrap has already made the fixed root's `config/projects/-session`. The host
 * then CHECKS that tree, never makes it: exactly `config/` → `projects/` →
 * `-session/`, all directories, no link, nothing else. A fixed root that is
 * absent is made by an exclusive mkdir. Either way the host makes `cache/` and
 * the three XDG roots itself, exclusively. Throws when a root cannot be made.
 */
function makeCliRoot(): CliRoot {
  let root: string;
  let bound = false;
  const fixedRoot = process.env[CLAUDE_CLI_ROOT_ENV];
  if (fixedRoot !== undefined && fixedRoot !== "") {
    if (fixedRoot !== CLAUDE_CLI_FIXED_ROOT) {
      throw new Error(`${CLAUDE_CLI_ROOT_ENV} may only name ${CLAUDE_CLI_FIXED_ROOT}`);
    }
    bound = isBoundRoot(fixedRoot);
    if (!bound) mkdirSync(fixedRoot, { mode: 0o700 });
    root = fixedRoot;
  } else {
    root = mkdtempSync(join(tmpdir(), CLI_ROOT_PREFIX));
  }
  const cliDirs: CliDirs = {
    config: join(root, "config"),
    cache: join(root, "cache"),
    xdgConfig: join(root, "xdg-config"),
    xdgData: join(root, "xdg-data"),
    xdgState: join(root, "xdg-state"),
  };
  for (const [name, dir] of Object.entries(cliDirs)) {
    if (bound && name === "config") continue;
    mkdirSync(dir, { mode: 0o700 });
  }
  return { root, bound, cliDirs };
}

/**
 * The runtime a spare is parked with (guuey#3407 leg 5, guuey#3456): the model-egress base URL, the credential
 * {@link spareAuthTokenOf} gives the boot's token (the platform's thread token, else the placeholder), and NO MCP
 * credential (a spare's MCP servers arrive after the claim). Pure, so the credential decision is pinned by a test.
 */
export function spareRuntimeOf(runtime: HostRuntime): HostRuntime {
  return {
    ...(runtime.baseUrl !== undefined ? { baseUrl: runtime.baseUrl } : {}),
    authToken: spareAuthTokenOf(runtime.authToken),
    listCredentials: () => [],
  };
}

/**
 * Start a Claude CLI as a parked spare before any turn (guuey#3407 leg 5): the
 * options a turn of `template` would get, with no MCP server, the credential
 * {@link spareAuthTokenOf} gives `runtime.authToken` (the platform's thread
 * token, guuey#3456, else the spare placeholder), a permission callback
 * the claiming turn binds, and a constant parking directory under a fresh CLI
 * root. Never throws: a spare that cannot start is reported on stderr, and
 * every turn then starts cold.
 */
export async function prewarmClaudeSpare(
  snapshot: { framework?: string } & Parameters<typeof buildOptions>[0],
  template: HostInvoke,
  runtime: HostRuntime,
  prewarm: PrewarmFn,
  timing: ClaudeTurnTiming = {},
): Promise<ParkedSpare | undefined> {
  const skip = (why: string): undefined => {
    process.stderr.write(`[guuey] Claude spare not started: ${why}\n`);
    return undefined;
  };
  if (snapshot.framework !== undefined && snapshot.framework !== CLAUDE_FRAMEWORK) return skip("the agent's framework is not Claude");
  // The platform binds the turn on the model-egress side, so a spare runs only behind its base URL.
  if (runtime.baseUrl === undefined) return skip("no model-egress base URL");
  let made: CliRoot;
  try {
    made = makeCliRoot();
  } catch (err) {
    return skip(`could not make the CLI's state directories: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (made.bound) {
    removeAroundBind(made.root);
    return skip("the CLI root is a bound thread directory");
  }
  try {
    const parking = join(made.root, SPARE_PARKING_DIR);
    mkdirSync(parking, { mode: 0o700 });
    const spareRuntime = spareRuntimeOf(runtime);
    // The claiming turn's MCP header values join the spare's stderr redaction at the claim.
    const late: string[] = [];
    const built = buildOptions(snapshot, { ...turnOptionsContext(template, spareRuntime, made.cliDirs), lateSecrets: () => late });
    if (built.permissionMode !== undefined) throw new Error("the agent pins a permission mode");
    const { cwd: _cwd, additionalDirectories: _dirs, ...fixed } = built;
    const permission = delegatingCanUseTool();
    const spare = await prewarm({
      options: { ...fixed, cwd: parking, canUseTool: permission.canUseTool },
      initializeTimeoutMs: timing.startupDeadlineMs ?? CLAUDE_STARTUP_DEADLINE_MS,
    });
    // `exited` settles, never rejects, in the SDK; a rejection would mean the same: the spare is gone.
    let exited = false;
    const markExited = (): void => {
      exited = true;
    };
    void spare.exited.then(markExited, markExited);
    return {
      spare,
      root: made.root,
      cliDirs: made.cliDirs,
      key: spareKeyOf(built),
      bindCanUseTool: permission.bind,
      addSecrets: (values) => {
        late.push(...values);
      },
      exited: () => exited,
    };
  } catch (err) {
    removeCliRoot(made.root);
    return skip(err instanceof Error ? err.message : String(err));
  }
}

/** Why this turn cannot claim `parked`, built with the spare's own state roots; undefined when it can. */
function spareMismatchFor(
  parked: ParkedSpare,
  snapshot: Parameters<typeof buildOptions>[0],
  invoke: HostInvoke,
  runtime: HostRuntime,
): string | undefined {
  try {
    return spareMismatch(parked, buildOptions(snapshot, turnOptionsContext(invoke, runtime, parked.cliDirs)));
  } catch (err) {
    // The turn's own path then reports the same failure as its error.
    return `the turn's options could not be built (${err instanceof Error ? err.message : String(err)})`;
  }
}

/** Close a spare no turn claimed, at host shutdown, and remove its state root. */
export function closeParkedSpare(parked: ParkedSpare): void {
  discardSpare(parked, "the host is shutting down");
}

/** Close a spare no turn will claim, and remove its state root. Reported on stderr. */
function discardSpare(parked: ParkedSpare, why: string): void {
  process.stderr.write(`[guuey] Claude spare not used: ${why}\n`);
  parked.spare.close();
  removeCliRoot(parked.root);
}

/** A UUID in its canonical text form (any version): the only session id the host runs (B3 R5). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bound thread directory's path under the fixed root, as bwrap makes it (B3 §2; `-session` is the CLI's name for cwd `/session`). */
const BOUND_TREE = ["config", "projects", "-session"] as const;

/**
 * Whether the fixed root is the jail's bound tree (B3 R23). Absent → false, and the caller makes it. Present → it
 * must be EXACTLY `config/` → `projects/` → `-session/`, each a directory and none a link, with nothing beside
 * them; anything else throws, so a planted entry or a link refuses the turn before the CLI starts.
 */
export function isBoundRoot(root: string): boolean {
  try {
    lstatSync(root);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return false;
    throw err;
  }
  // Each level, from the root down to the bound directory; every level but the last holds exactly the next one.
  const levels = [root, ...BOUND_TREE.map((_, i) => join(root, ...BOUND_TREE.slice(0, i + 1)))];
  levels.forEach((dir, i) => {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`the CLI state root's ${dir.slice(root.length) || "/"} is not a plain directory`);
    if (i === BOUND_TREE.length) return;
    const children = readdirSync(dir);
    if (children.length !== 1 || children[0] !== BOUND_TREE[i]) {
      throw new Error(`the CLI state root's ${dir.slice(root.length) || "/"} must hold exactly ${BOUND_TREE[i]}/ (found ${String(children.length)} entries)`);
    }
  });
  return true;
}

/**
 * After a bound turn: remove everything the turn left under the fixed root EXCEPT the bound thread directory, entry
 * by entry, never entering the bind (a recursive remove of the root would empty the thread's durable session through
 * it). Links are removed as links. A failure is reported on stderr, by path only.
 */
function removeAroundBind(root: string): void {
  const sweep = (dir: string, keep: string | undefined): void => {
    for (const name of readdirSync(dir)) {
      if (name === keep) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  };
  try {
    sweep(root, BOUND_TREE[0]);
    sweep(join(root, BOUND_TREE[0]), BOUND_TREE[1]);
    sweep(join(root, BOUND_TREE[0], BOUND_TREE[1]), BOUND_TREE[2]);
  } catch (err) {
    process.stderr.write(`[guuey] could not clear the CLI state directory ${root}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** The name prefix of the CLI's per-invoke state root, made under the temp dir with a random suffix. */
export const CLI_ROOT_PREFIX = "guuey-cli-";

/**
 * Removes the per-invoke state root once the turn has ended. A link inside it
 * is removed as a link, never followed. A failure is reported on stderr, by
 * path only.
 */
function removeCliRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`[guuey] could not remove the CLI state directory ${root}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** The Claude turn proper, after the hello, the image store and the framework gate, with this invoke's state roots. */
async function runClaudeTurn(
  snapshot: { framework?: string } & Parameters<typeof buildOptions>[0],
  invoke: HostInvoke,
  runtime: HostRuntime,
  emit: Emitter,
  query: QueryFn,
  timing: ClaudeTurnTiming,
  cliDirs: CliDirs,
  hello: HelloOnce,
  parked: ParkedSpare | undefined,
): Promise<void> {
  const session = invoke.cliSession;
  let options: Options;
  let ctx: BuildOptionsContext;
  let turnContext: string[];
  let content: AnthropicUserBlock[];
  let block: HelloCliSession | undefined;
  try {
    ctx = turnOptionsContext(invoke, runtime, cliDirs);
    options = buildOptions(snapshot, ctx);
    turnContext = claudeTurnContext(snapshot, ctx);
    reportToolGateErrors(snapshot.tools);
    // A1: the turn's two context blocks (`<turn_context>` then `<turn_directive>`,
    // always both; the context block always opens with its constant lead line, the
    // directive may be empty) lead the message, each its own text
    // block, then the invoke's own content (its images, then its text) unchanged.
    content = [...turnContext.map((text) => ({ type: "text" as const, text })), ...anthropicUserContent(invoke)];
    if (session !== undefined) {
      // B3 (R2, R3): `start` creates the session under the Router's id, `resume`
      // continues it; never both, and never a fork.
      options = session.mode === "start" ? { ...options, sessionId: session.id } : { ...options, resume: session.id };
      block = cliSessionBlock(options, resolveMcpServers(ctx), content, session, invoke.fs, cliDirs);
    }
  } catch (err) {
    hello();
    emit.error(err instanceof Error ? err.message : String(err));
    return;
  }
  // B3: the turn's first event, when it carried `cliSession` (R-1: the only
  // frame the Router takes these values from).
  hello(block);
  // guuey#3407 6a (F1): a resume that carries the platform's record is checked
  // HERE, against the measures the hello just reported, before the CLI starts:
  // a refused file is never loaded and nothing reaches the model. This is the
  // cooperative half; the platform's own comparison on the hello gates the turn.
  if (session?.mode === "resume" && session.expectLastPromptSha !== undefined) {
    const stored = block?.stored;
    const verdict: CliSessionVerdict =
      stored === undefined
        ? { ok: false, reason: "unreadable" }
        : compareStoredSession({ id: session.id, lastPromptSha: session.expectLastPromptSha }, stored);
    if (!verdict.ok) {
      emit.error(`${CLI_SESSION_RESUME_FAILED}: refused (${verdict.reason})`);
      return;
    }
  }
  // The platform-owned names buildOptions left out of the agent's environment,
  // reported on stderr (names only) so the drop is never silent.
  const droppedEnv = reservedEnvNamesDropped(snapshot);
  if (droppedEnv.length > 0) {
    process.stderr.write(
      `[guuey] agent.env: ${droppedEnv.join(", ")} left out of the agent's environment: ` +
        "reserved by the platform. Remove them from agent.env.\n",
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
  // Only the stream handed to the CLI that runs the turn yields: a refused
  // spare claim leaves its stream waiting, and it ends without a message.
  let activeStream = 0;
  function userMessages(): AsyncGenerator<SDKUserMessage> {
    const stream = ++activeStream;
    return (async function* (): AsyncGenerator<SDKUserMessage> {
      await gate;
      if (!sendMessage || stream !== activeStream) return;
      // The same blocks the hello's `promptSha` hashed (B3 R-2): one array.
      yield {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
      };
      await inputDone;
    })();
  }

  let q: QueryHandle;
  try {
    q =
      parked !== undefined
        ? await claimSpare(parked, options, mcpHeaderValuesOf(resolveMcpServers(ctx)), userMessages, query, timing)
        : query({ prompt: userMessages(), options });
  } catch (err) {
    emit.error(err instanceof Error ? err.message : String(err));
    return;
  }
  let done: { stopReason: StopReason; result: string } | undefined;
  // B3 (R14, cto point 1): a resume is confirmed POSITIVELY before anything is
  // forwarded. The CLI's first message must be the `init` of the id the Router
  // sent; R7b measured that every failure face (missing, empty, unreadable,
  // a directory) ends in an error result with no `init` first. Anything else
  // ends the turn with CLI_SESSION_RESUME_FAILED and forwards nothing: the host
  // never falls back on its own, the Router resets and re-runs once.
  let resumeFailed: string | undefined;
  const messages = (async (): Promise<void> => {
    let confirmed = session?.mode !== "resume";
    for await (const msg of q) {
      if (!confirmed) {
        if (isInitOf(msg, session?.id)) {
          confirmed = true;
        } else {
          resumeFailed = describeFirstMessage(msg);
          endInput();
          openGate();
          q.close();
          return;
        }
      }
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
    // already rendered into the turn's context block, so a
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
    emit.error(resumeFailed !== undefined ? resumeFailedMessage(resumeFailed) : err instanceof Error ? err.message : String(err));
    return;
  }
  if (resumeFailed !== undefined) {
    await streamOutcome;
    emit.error(resumeFailedMessage(resumeFailed));
    return;
  }
  sendMessage = true;
  openGate();
  const failure = await streamOutcome;
  endInput();
  if (resumeFailed !== undefined) {
    emit.error(resumeFailedMessage(resumeFailed));
    return;
  }
  if (failure !== undefined) {
    emit.error(failure.message);
    return;
  }
  emit.done(done?.result ?? "", done?.stopReason ?? "end_turn");
}

/** The option-building context of one invoke: its own fields, the boot runtime's credential, and the turn's state roots. */
function turnOptionsContext(invoke: HostInvoke, runtime: HostRuntime, cliDirs: CliDirs): BuildOptionsContext {
  return {
    input: invoke.input,
    identity: invoke.identity,
    fs: invoke.fs,
    cliDirs,
    ...(invoke.fsBound !== undefined ? { fsBound: invoke.fsBound } : {}),
    // B3 (R3): a resumed session already holds the conversation, so the turn
    // carries no history section, even when the invoke sent one.
    history: invoke.cliSession?.mode === "resume" ? [] : invoke.history,
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
    ...(invoke.clientCatalogs !== undefined ? { clientCatalogs: invoke.clientCatalogs } : {}),
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
    // The welcome card the Router already drew → its section in the turn's directive block.
    ...(invoke.firstImpressionShown !== undefined ? { firstImpressionShown: invoke.firstImpressionShown } : {}),
  };
}

/**
 * Claim the parked spare for this turn: bind the turn's permission check, send
 * the claim with the turn's working directories and its gated prompt, and wait
 * for the CLI's answer. A refused or failed claim closes the spare's Query and
 * starts this turn cold with `query()` and a fresh prompt stream; the refused
 * stream never yields. `option_not_applied` means the session already runs
 * (the SDK's contract), so it is kept, though this host sets no such option.
 */
async function claimSpare(
  parked: ParkedSpare,
  options: Options,
  secrets: readonly string[],
  prompt: () => AsyncGenerator<SDKUserMessage>,
  query: QueryFn,
  timing: ClaudeTurnTiming,
): Promise<QueryHandle> {
  const startupMs = timing.startupDeadlineMs ?? CLAUDE_STARTUP_DEADLINE_MS;
  const cwd = options.cwd;
  const check = options.canUseTool;
  if (cwd === undefined || check === undefined) {
    // spareMismatch refused these already; the turn's state root is the spare's, so it stays.
    process.stderr.write("[guuey] Claude spare not used: the turn has no working directory or permission callback\n");
    parked.spare.close();
    return query({ prompt: prompt(), options });
  }
  let claimed: QueryHandle | undefined;
  try {
    parked.bindCanUseTool(check);
    // Before the claim, so the turn's MCP header values are redacted from the spare's first line on.
    parked.addSecrets(secrets);
    claimed = parked.spare.claim({ prompt: prompt(), options: claimOptionsOf(cwd, options) });
    await withDeadline(parked.spare.claimed, startupMs, () => new ClaudeStartupError(`no answer to the spare's claim within ${String(startupMs)} ms`));
    process.stderr.write("[guuey] Claude spare claimed\n");
    return claimed;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (claimed !== undefined && why.startsWith("option_not_applied")) return claimed;
    process.stderr.write(`[guuey] Claude spare not used: the claim failed (${why})\n`);
    if (claimed !== undefined) claimed.close();
    else parked.spare.close();
    return query({ prompt: prompt(), options });
  }
}

/** The `error` message of an unconfirmed resume: the protocol's prefix, then what the CLI said first. */
function resumeFailedMessage(firstMessage: string): string {
  return `${CLI_SESSION_RESUME_FAILED}: the CLI's first message was ${firstMessage}, not the init of the session sent`;
}

/** Whether an SDK message is the `system`/`init` of exactly this session id. */
function isInitOf(msg: SDKMessage, id: string | undefined): boolean {
  return msg.type === "system" && msg.subtype === "init" && id !== undefined && msg.session_id === id;
}

/** A short, content-free description of an SDK message, for the resume-failed error. */
function describeFirstMessage(msg: SDKMessage): string {
  const subtype = "subtype" in msg && typeof msg.subtype === "string" ? `/${msg.subtype}` : "";
  return `${msg.type}${subtype}`;
}

/** Sends the invoke's hello at most once (see `runInvoke`); a block adds the thread-resume capability. */
type HelloOnce = (block?: HelloCliSession) => void;

function helloOnce(emit: Emitter, capabilities: readonly string[]): HelloOnce {
  let sent = false;
  return (block) => {
    if (sent) return;
    sent = true;
    emit.hello(
      CLAUDE_FRAMEWORK,
      CLAUDE_SDK_PACKAGE,
      resolveSdkVersion(CLAUDE_SDK_PACKAGE),
      block === undefined ? capabilities : [...capabilities, CLI_SESSION_CAPABILITY],
      block,
    );
  };
}

/**
 * The CLI's directory name for a cwd (R7a, measured on 2.1.282 and read in its bundle): the cwd's real path with every
 * character outside `[a-zA-Z0-9]` turned into `-`. `/session` gives `-session`. The CLI shortens a name over 200
 * characters with a hash this host does not reproduce, so such a cwd refuses rather than measuring the wrong file.
 */
export function cliProjectSlug(cwd: string): string {
  const slug = realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length > 200) throw new Error("@guuey/host: the session directory's path is too long to resume a CLI session in");
  return slug;
}

/** The hello's thread-resume block for this turn (B3 v1.9, wire v1.2), with the stored measures on a resume. */
function cliSessionBlock(
  options: Options,
  servers: Record<string, McpServerConfig>,
  content: readonly AnthropicUserBlock[],
  session: InvokeCliSession,
  fs: Fs,
  cliDirs: CliDirs,
): HelloCliSession {
  const own = content[content.length - 1];
  if (own === undefined || own.type !== "text") throw new Error("@guuey/host: the turn's message must end with its own text block");
  if (typeof options.systemPrompt !== "string") throw new Error("@guuey/host: the system prompt must be one string to resume a CLI session");
  const promptBytes = content.reduce((n, b) => n + (b.type === "text" ? Buffer.byteLength(b.text, "utf8") : 0), 0);
  return {
    hashVersion: CLI_SESSION_HASH_VERSION,
    systemPromptSha256: hashSystemPrompt(options.systemPrompt),
    headerShas: headerShas(options, servers),
    promptSha: hashUserBlocks(content),
    promptBytes,
    lastPromptSha: hashUserText(own.text),
    ...(session.mode === "resume"
      ? { stored: measureStoredSession(join(cliDirs.config, "projects", cliProjectSlug(fs.session)), session.id) }
      : {}),
  };
}

/**
 * One sha per agent-configuration field passed to the SDK (B-3; all four are `agent-config`-only, B3 v1.8 item 3).
 * Each is a fixed canonical form: sorted names, the MCP servers by name with their transport and URL, never a header.
 */
function headerShas(options: Options, servers: Record<string, McpServerConfig>): HelloHeaderShas {
  const list = (v: readonly string[] | undefined): string[] => [...(v ?? [])].sort();
  const tools = Array.isArray(options.tools) ? options.tools : [];
  return {
    model: sha256OfFields(["model", options.model ?? ""]),
    permissionMode: sha256OfFields(["permissionMode", options.permissionMode ?? (options.canUseTool !== undefined ? "canUseTool" : "")]),
    tools: sha256OfFields([
      "tools", ...list(tools),
      "allowed", ...list(options.allowedTools),
      "disallowed", ...list(options.disallowedTools),
    ]),
    mcpConfig: sha256OfFields([
      "mcp",
      ...Object.keys(servers).sort().flatMap((name) => {
        const s = servers[name];
        return [name, "type" in s && typeof s.type === "string" ? s.type : "", "url" in s && typeof s.url === "string" ? s.url : ""];
      }),
    ]),
  };
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
