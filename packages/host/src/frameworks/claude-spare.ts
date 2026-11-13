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
 * The spare holds no turn's credential: its CLI is given
 * {@link CLAUDE_SPARE_PLACEHOLDER_TOKEN}, and the platform binds the turn by
 * the channel it reaches the model through (the launcher's door, never the
 * string). Its MCP servers arrive after the claim over stdin, as on every turn.
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
 */
export const CLAUDE_SPARE_ENV = "GUUEY_CLAUDE_SPARE";

/**
 * The model credential a parked CLI holds: a constant that names no turn and
 * grants nothing. The turn is bound outside the CLI (the launcher's per-turn
 * channel), so no credential is ever read before the claim.
 */
export const CLAUDE_SPARE_PLACEHOLDER_TOKEN = "guuey-spare-unbound";

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
 * The fields a spare fixes at prewarm, as one comparable string. Left out on
 * purpose: what the claim sets (`cwd`, `additionalDirectories`), what the turn
 * hands the spare's callback (`canUseTool`, and `allowedTools`, which names the
 * turn's MCP servers and only skips that callback), the per-start spawner and
 * the session fields (a spare never serves a named session).
 */
export function spareKeyOf(options: Options): string {
  return JSON.stringify({
    model: options.model ?? null,
    thinking: options.thinking ?? null,
    tools: options.tools ?? null,
    disallowedTools: options.disallowedTools ?? [],
    systemPrompt: options.systemPrompt ?? null,
    settingSources: options.settingSources ?? null,
    settings: options.settings ?? null,
    strictMcpConfig: options.strictMcpConfig ?? null,
    maxTurns: options.maxTurns ?? null,
    includePartialMessages: options.includePartialMessages ?? null,
    env: Object.entries(options.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    executable: options.pathToClaudeCodeExecutable ?? null,
    permissionMode: options.permissionMode ?? null,
  });
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
