/**
 * A Claude CLI turn's thread resume (guuey#3407 B3; guuey#3550): the ONE sequence `@guuey/host`'s Claude framework and a
 * builder's own worker both run, so the Router compares like with like.
 *
 * In order: the session id is checked (a UUID, before anything is read), the hello's block is computed and sent, a
 * `resume` that carries the platform's record is checked against the stored session before the CLI starts, and the
 * CLI's first message must confirm the session. Every refusal THROWS, with the text a Router reads.
 *
 * NOT a boundary (infra-hardening's framing): this code runs inside the jail and the builder can change it. The checks
 * keep an honest worker's thread intact; isolation is the platform's (the thread folder bound alone, at
 * `<root>/projects/-session`, on folder turns only, and the Router's own stamp). A worker that skips or edits them can
 * only damage its own thread's session: a cwd other than the session folder starts clean, and ignoring the session
 * means no resume.
 */
import { isAbsolute } from "node:path";
import { CLAUDE_CODE_EXECUTABLE_ENV, claudeCodeExecutableOf } from "./claude-spawn.js";
import { compareStoredSession, type CliSessionRefusal, type CliSessionVerdict } from "./cli-session-compare.js";
import { claudeSessionBlock, type ClaudeSessionHeader, type ClaudeSessionServer } from "./claude-session-block.js";
import type { AnthropicUserBlock } from "./image-parts.js";
import { CLI_SESSION_RESUME_FAILED, type HelloCliSession, type InvokeCliSession } from "./protocol.js";

/** A session id the CLI may run: only a UUID (B3 R5); the worker never derives one (R4). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The refusal of a session id that is not a UUID; the id (up to 80 characters) follows in parentheses. */
export const CLI_SESSION_ID_NOT_UUID = "guuey: cliSession.id must be a UUID";
/** The refusal of a system prompt that is not one string (a preset cannot be hashed, so it cannot resume). */
export const CLI_SESSION_PROMPT_NOT_STRING = "guuey: the system prompt must be one string to resume a CLI session";

/** Why this invoke's session id cannot be run, or `undefined` when it can. Reads nothing. */
export function cliSessionIdProblem(session: InvokeCliSession): string | undefined {
  return UUID.test(session.id) ? undefined : `${CLI_SESSION_ID_NOT_UUID} (got ${JSON.stringify(session.id.slice(0, 80))}).`;
}

/** The `error` of a resume the stored session does not match (the cooperative check, guuey#3407 6a F1). */
export function cliSessionRefusedMessage(reason: CliSessionRefusal): string {
  return `${CLI_SESSION_RESUME_FAILED}: refused (${reason})`;
}

/**
 * The `error` of a resume this worker cannot apply. A resumed invoke carries no history (the session holds it), so a
 * worker that cannot continue the session must not answer: the Router resets and re-runs the turn as a start.
 */
export function cliSessionNotAppliedMessage(why: string): string {
  return `${CLI_SESSION_RESUME_FAILED}: not applied (${why})`;
}

/** The `error` of a resume the CLI did not confirm: the protocol's prefix, then what the CLI said first. */
export function cliSessionUnconfirmedMessage(firstMessage: string): string {
  return `${CLI_SESSION_RESUME_FAILED}: the CLI's first message was ${firstMessage}, not the init of the session sent`;
}

/** The fields of one SDK message the first-message confirm reads. */
export interface ClaudeSessionMessage {
  readonly type: string;
  readonly subtype?: unknown;
  readonly session_id?: unknown;
}

/** A short, content-free description of an SDK message: its type, and its subtype when it has one. */
function describeMessage(msg: ClaudeSessionMessage): string {
  return `${msg.type}${typeof msg.subtype === "string" ? `/${msg.subtype}` : ""}`;
}

/** What {@link applyClaudeSession} needs for one turn. */
export interface ClaudeSessionTurn {
  readonly session: InvokeCliSession;
  /** The system prompt passed to the SDK. Only one string can be hashed; anything else refuses. */
  readonly systemPrompt: string | object | undefined;
  readonly header: ClaudeSessionHeader;
  readonly servers: Readonly<Record<string, ClaudeSessionServer>>;
  /** The turn's user message, every block exactly as it will be sent; the last block is the turn's own text. */
  readonly content: readonly AnthropicUserBlock[];
  /** The CLI's config root (its `CLAUDE_CONFIG_DIR`). */
  readonly configDir: string;
  /** The CLI's cwd for this turn: the session folder. */
  readonly cwd: string;
  /** Sends the invoke's hello with this block (and the thread-resume capability). Called once, before any check reads it. */
  readonly hello: (block: HelloCliSession) => void;
}

/** One turn's applied session. */
export interface AppliedClaudeSession {
  /** Spread into the SDK's options: `start` creates the session under the Router's id, `resume` continues it. Never both. */
  readonly options: { readonly sessionId: string } | { readonly resume: string };
  /** The block the hello carried. */
  readonly block: HelloCliSession;
  /**
   * Call with the CLI's FIRST message only. `undefined` when the turn may go on; otherwise the `error` that ends it,
   * and nothing of the turn may be forwarded. A `start` is always confirmed; a `resume` only by the `system`/`init`
   * of exactly the id sent (R14).
   */
  readonly confirmFirst: (msg: ClaudeSessionMessage) => string | undefined;
}

/**
 * Apply `invoke.cliSession` to one Claude turn: check the id, send the hello with its block, check a recorded resume
 * against the stored session, and return the options to run with and the first-message confirm. Throws on every
 * refusal; the hello has then been sent only when the refusal is the stored-session check.
 */
export function applyClaudeSession(turn: ClaudeSessionTurn): AppliedClaudeSession {
  const { session } = turn;
  const idProblem = cliSessionIdProblem(session);
  if (idProblem !== undefined) throw new Error(idProblem);
  if (typeof turn.systemPrompt !== "string") {
    throw new Error(CLI_SESSION_PROMPT_NOT_STRING);
  }
  const block = claudeSessionBlock({
    systemPrompt: turn.systemPrompt,
    header: turn.header,
    servers: turn.servers,
    content: turn.content,
    session,
    configDir: turn.configDir,
    cwd: turn.cwd,
  });
  turn.hello(block);
  // The cooperative half (guuey#3407 6a F1): a refused file is never loaded and nothing reaches the model. The
  // platform's own comparison on the hello is what gates the turn.
  if (session.mode === "resume" && session.expectLastPromptSha !== undefined) {
    const verdict: CliSessionVerdict =
      block.stored === undefined
        ? { ok: false, reason: "unreadable" }
        : compareStoredSession({ id: session.id, lastPromptSha: session.expectLastPromptSha }, block.stored);
    if (!verdict.ok) throw new Error(cliSessionRefusedMessage(verdict.reason));
  }
  return {
    options: session.mode === "start" ? { sessionId: session.id } : { resume: session.id },
    block,
    confirmFirst: (msg) =>
      session.mode !== "resume" || (msg.type === "system" && msg.subtype === "init" && msg.session_id === session.id)
        ? undefined
        : cliSessionUnconfirmedMessage(describeMessage(msg)),
  };
}

/**
 * The Claude CLI's config root for a builder worker's resumable turn: an absolute path the platform's slot sets, after
 * the frame's env and never from it (infra-runtime names it: `@guuey-private/fs-contract` `ENV_CLI_CONFIG_DIR`; this is
 * its published mirror). The worker only reads it.
 */
export const CLAUDE_CLI_CONFIG_DIR_ENV = "GUUEY_CLI_CONFIG_DIR";

/** Where a builder worker's resumable turn runs, or why it runs without a session. Reads only `env`. */
export type WorkerClaudeSessionGate =
  | { readonly ok: true; readonly configDir: string; readonly executable: string }
  | { readonly ok: false; readonly why: string };

/**
 * A builder worker applies a session only on a platform that set BOTH: the CLI's config root (absolute), and the CLI
 * binary the platform pinned (`GUUEY_CLAUDE_CODE_EXECUTABLE`). The binary is what writes and reads the session file, so
 * the turn must run that one, never another.
 */
export function workerClaudeSessionGate(env: Readonly<Record<string, string | undefined>>): WorkerClaudeSessionGate {
  const configDir = env[CLAUDE_CLI_CONFIG_DIR_ENV];
  if (configDir === undefined || configDir === "") return { ok: false, why: `${CLAUDE_CLI_CONFIG_DIR_ENV} is not set` };
  if (!isAbsolute(configDir)) return { ok: false, why: `${CLAUDE_CLI_CONFIG_DIR_ENV} is not an absolute path` };
  const executable = claudeCodeExecutableOf(env);
  if (executable === undefined) return { ok: false, why: `${CLAUDE_CODE_EXECUTABLE_ENV} is not set` };
  return { ok: true, configDir, executable };
}

/** What a builder worker's turn hands {@link NativeEmit.claudeSession}: exactly the values it passes `query()`. */
export interface WorkerClaudeSessionTurn {
  /** The system prompt option. Only one string can resume; a preset runs the turn without a session. */
  readonly systemPrompt: string | object | undefined;
  readonly header: ClaudeSessionHeader;
  readonly servers: Readonly<Record<string, ClaudeSessionServer>>;
  /** The user message, every block exactly as yielded to the CLI; the last block is the turn's own text. */
  readonly content: readonly AnthropicUserBlock[];
  /** The CLI's cwd. Default: this process's cwd, which on a platform turn is the session folder. */
  readonly cwd?: string;
}

/** A builder worker's applied session: spread `options` into the SDK's options and `env` into its `env`. */
export interface WorkerClaudeSession {
  readonly options: AppliedClaudeSession["options"] & {
    readonly persistSession: true;
    /** The platform's pinned CLI: the turn must run this binary, the one the session file belongs to. */
    readonly pathToClaudeCodeExecutable: string;
  };
  readonly env: { readonly CLAUDE_CONFIG_DIR: string };
  readonly block: HelloCliSession;
  readonly confirmFirst: AppliedClaudeSession["confirmFirst"];
}
