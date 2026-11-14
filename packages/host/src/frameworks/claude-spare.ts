/**
 * The parked-spare path's pure half (guuey#3407 leg 5): a Claude CLI started
 * and waiting before its first prompt, through the Agent SDK's `prewarm()` and
 * `SpareProcess.claim()`.
 *
 * OFF unless the launcher sets {@link CLAUDE_SPARE_ENV}. With it unset, nothing
 * here runs and every turn takes the `query()` path unchanged.
 *
 * What is fixed at prewarm and what a claim may still set is the SDK's split
 * (`prewarm`, `ClaimOptions`): the environment, the system prompt, the tool
 * catalog and the permission callback are fixed, and the claim sets the
 * working directory and the extra directories. So the spare serves a turn only
 * when that turn's own options agree with the spare's on every fixed field
 * ({@link spareKeyOf}); any other turn closes the spare and starts cold.
 *
 * The spare's model credential is fixed at the park, before any turn (the
 * claim cannot hand a parked CLI a credential). When the launch envelope
 * carries the platform's thread token (`guuey_thr_…`, guuey#3456, the token
 * door's worker binding), the spare is started WITH that token, so the parked
 * CLI holds it from the park for its whole life; the platform admits its model
 * calls only during the bound thread's live turn. Any other envelope token,
 * or none, leaves it on {@link CLAUDE_SPARE_PLACEHOLDER_TOKEN}, a constant that
 * names no turn. Either way the token reaches the CLI only on the spawner's
 * private descriptor (never its environment, argv or a file) and is redacted
 * from its stderr. Its MCP servers arrive after the claim over stdin, as on
 * every turn.
 */
import type { CanUseTool, ClaimOptions, Options, PermissionResult, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isInvoke, parseControl, type Invoke } from "@guuey/worker";
import type { CliDirs } from "./claude-options.js";
import type { QueryHandle } from "./claude.js";

/**
 * The launcher's switch and the spare's template: a JSON object shaped like an
 * invoke without its content (`identity`, `fs`, and the flags that select the
 * turn's prompt class: `fsBound`, `memoryAttached`, `profileAccess`,
 * `resourceCount`, `gguiAttached`, `clientCatalogs`, `firstImpression`).
 * Unset = the spare path is off.
 *
 * Before setting it, know:
 *  - A claimed turn calls the model with the credential the spare was parked
 *    with ({@link spareAuthTokenOf}): the platform's thread token when the
 *    launch carried one, else {@link CLAUDE_SPARE_PLACEHOLDER_TOKEN}. With the
 *    placeholder the switch works only where the platform binds the turn
 *    outside the CLI; anywhere else a claimed turn's model calls are refused.
 *  - The first turn waits for a prewarm still in progress, up to the SDK's
 *    initialize limit (60 s, `CLAUDE_STARTUP_DEADLINE_MS` in claude.ts).
 *  - One spare serves one prompt class. No per-user value is fixed at the park
 *    (the user id never reaches the options; HOME is the constant home mount),
 *    but the class is: the auth mode, the memory tool, the profile access, the
 *    generative-UI rail, the A2UI catalog, real file layers (the built-in
 *    tools) and a bound first impression (thinking off). An app needs one
 *    spare, so one plain snapshot, per class its first turns arrive in.
 */
export const CLAUDE_SPARE_ENV = "GUUEY_CLAUDE_SPARE";

/**
 * The model credential a parked CLI holds when the launch carried no thread
 * token: a constant that names no turn and grants nothing. The turn is then
 * bound outside the CLI (the launcher's per-turn channel).
 */
export const CLAUDE_SPARE_PLACEHOLDER_TOKEN = "guuey-spare-unbound";

/** The prefix of the platform's thread token (the token door's worker binding, guuey#3456): the only credential a spare may be parked with. */
export const SPARE_THREAD_TOKEN_PREFIX = "guuey_thr_";

/**
 * The credential a spare is parked with (guuey#3456): the launch envelope's
 * model token when it is the platform's thread token (it begins
 * {@link SPARE_THREAD_TOKEN_PREFIX} and carries more after it), else
 * {@link CLAUDE_SPARE_PLACEHOLDER_TOKEN}. The prefix alone decides: a per-turn
 * token (an older Router's launch) never reaches a parked CLI, whose credential
 * outlives the turn.
 */
export function spareAuthTokenOf(envelopeToken: string | undefined): string {
  return envelopeToken !== undefined &&
    envelopeToken.length > SPARE_THREAD_TOKEN_PREFIX.length &&
    envelopeToken.startsWith(SPARE_THREAD_TOKEN_PREFIX)
    ? envelopeToken
    : CLAUDE_SPARE_PLACEHOLDER_TOKEN;
}

/** The parking directory's name under the spare's CLI state root: a constant path, outside every mount. */
export const SPARE_PARKING_DIR = "spare-parking";

/** The parked spare, as the SDK's `SpareProcess` exposes it. */
export interface SpareHandle {
  claim(params: { prompt: AsyncIterable<SDKUserMessage>; options: ClaimOptions }): QueryHandle;
  readonly claimed: Promise<{ cwd: string; sessionId: string; parkedMs?: number }>;
  readonly exited: Promise<void>;
  close(): void;
}

/** The SDK's `prewarm`, as this host calls it. */
export type PrewarmFn = (params: { options: Options; initializeTimeoutMs?: number }) => Promise<SpareHandle>;

/**
 * The SDK module's `prewarm`, or undefined when the installed SDK does not
 * export one. `@guuey/host` accepts SDK versions older than `prewarm`, so it
 * is looked up on the module, never imported by name: a named import of a
 * missing export would stop the Claude runner from loading at all. Delete this
 * lookup when the declared SDK floor reaches the first version with `prewarm`.
 */
export function sparePrewarmOf(sdk: { readonly prewarm?: PrewarmFn }): PrewarmFn | undefined {
  return typeof sdk.prewarm === "function" ? sdk.prewarm : undefined;
}

/** A spare parked at boot, with the state root it was started in. */
export interface ParkedSpare {
  readonly spare: SpareHandle;
  /** The CLI state root the spare runs in; the turn that claims it uses the same, and removes it when it ends. */
  readonly root: string;
  readonly cliDirs: CliDirs;
  /** {@link spareKeyOf} of the options it was started with. */
  readonly key: string;
  /** Hands the claiming turn's permission check to the callback the spare was started with. */
  bindCanUseTool(check: CanUseTool): void;
  /**
   * Adds the claiming turn's secrets (its MCP header values) to the spare's
   * stderr redaction. The spare was spawned before they existed, so its
   * spawner reads this list on every line.
   */
  addSecrets(values: readonly string[]): void;
  /** Whether the spare's process has exited while parked. */
  exited(): boolean;
}

/** The template invoke a spare is started for, or the reason the template is refused. */
export type SpareTemplate = { ok: true; invoke: Omit<Invoke, "type"> } | { ok: false; reason: string };

/**
 * Parse {@link CLAUDE_SPARE_ENV}'s value with the worker's own invoke parser,
 * so a template means exactly what the same fields mean on a turn. A template
 * carrying a CLI session is refused: a spare starts no named session.
 */
export function parseSpareTemplate(raw: string): SpareTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${CLAUDE_SPARE_ENV} is not JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${CLAUDE_SPARE_ENV} must be a JSON object` };
  }
  let message: ReturnType<typeof parseControl>;
  try {
    message = parseControl(JSON.stringify({ ...parsed, type: "invoke", input: "", history: [] }));
  } catch (err) {
    return { ok: false, reason: `${CLAUDE_SPARE_ENV}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isInvoke(message)) return { ok: false, reason: `${CLAUDE_SPARE_ENV} is not an invoke template` };
  if (message.cliSession !== undefined) return { ok: false, reason: `${CLAUDE_SPARE_ENV} may not carry cliSession` };
  const { type: _type, ...invoke } = message;
  return { ok: true, invoke };
}

/**
 * The option fields a spare fixes at prewarm and a claiming turn must match
 * exactly ({@link spareKeyOf}). Every other field `buildOptions` returns is in
 * {@link SPARE_UNKEYED_FIELDS}, with its reason; a test pins the two lists
 * against `buildOptions`, so a new option cannot go uncompared unnoticed.
 */
export const SPARE_KEY_FIELDS = [
  "model",
  "thinking",
  "tools",
  "disallowedTools",
  "systemPrompt",
  "settingSources",
  "settings",
  "strictMcpConfig",
  "maxTurns",
  "includePartialMessages",
  "env",
  "pathToClaudeCodeExecutable",
  "permissionMode",
] as const satisfies readonly (keyof Options)[];

/**
 * The option fields not compared: what the claim sets (`cwd`,
 * `additionalDirectories`), what the turn hands the spare's callback
 * (`canUseTool`, and `allowedTools`, which names the turn's MCP servers and
 * only skips that callback), the per-start spawner, the turn's cancel handle,
 * and the session fields (a spare never serves a named session).
 */
export const SPARE_UNKEYED_FIELDS = [
  "cwd",
  "additionalDirectories",
  "canUseTool",
  "allowedTools",
  "spawnClaudeCodeProcess",
  "abortController",
  "sessionId",
  "resume",
] as const satisfies readonly (keyof Options)[];

/** The fields of {@link SPARE_KEY_FIELDS}, as one comparable string (the environment in name order). */
export function spareKeyOf(options: Options): string {
  const env = Object.entries(options.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(SPARE_KEY_FIELDS.map((name) => (name === "env" ? env : (options[name] ?? null))));
}

/** Why a turn cannot claim the spare, or undefined when it can. */
export function spareMismatch(parked: ParkedSpare, options: Options): string | undefined {
  if (parked.exited()) return "the spare exited while parked";
  if (options.permissionMode !== undefined) return "the agent pins a permission mode";
  if (options.canUseTool === undefined) return "the turn has no permission callback";
  if (options.cwd === undefined) return "the turn has no working directory";
  if (spareKeyOf(options) !== parked.key) return "the turn's fixed options differ from the spare's";
  return undefined;
}

/** What the claim sets: the turn's working directory and its extra directories. */
export function claimOptionsOf(cwd: string, options: Options): ClaimOptions {
  return {
    cwd,
    ...(options.additionalDirectories !== undefined ? { additionalDirectories: options.additionalDirectories } : {}),
  };
}

/**
 * The permission callback a spare is started with: it asks the claiming turn's
 * own check, bound at the claim. Before a claim no tool can run, and a call
 * with nothing bound is denied, never allowed.
 */
export function delegatingCanUseTool(): { canUseTool: CanUseTool; bind(check: CanUseTool): void } {
  let current: CanUseTool | undefined;
  const canUseTool: CanUseTool = (toolName, input, opts): Promise<PermissionResult | null> =>
    current !== undefined
      ? current(toolName, input, opts)
      : Promise.resolve({ behavior: "deny", message: "no turn has claimed this session" });
  return {
    canUseTool,
    bind(check) {
      current = check;
    },
  };
}
