import type { ClaudeSessionHeader, ClaudeSessionServer } from "./claude-session-block.js";
import { cliSessionNotAppliedMessage, type ClaudeSessionMessage, type WorkerClaudeSession } from "./claude-session.js";
import { CLAUDE_FORBIDDEN_ENV, makeClaudeSpawner, type ClaudeKeyKind } from "./claude-spawn.js";
import { anthropicUserContent, type AnthropicUserBlock } from "./image-parts.js";
import { modelInputOf, withHistory } from "./model-text.js";
import type { Invoke, JsonValue } from "./protocol.js";
import type { NativeEmit } from "./serve-native.js";

/**
 * One whole Claude Agent SDK turn, so a builder worker makes ONE call: `return runClaudeTurn({...})`.
 *
 * It does, in this order, what the Claude template's worker did inline (guuey#3550's session included):
 * 1. The turn's one user message: the invoke's images and text. A START carries the thread's history in its text
 *    ({@link ClaudeTurn.history}); a RESUME does not, because the CLI's own session holds it.
 * 2. `emit.claudeSession(...)`, before anything is emitted: it sends the turn's hello and, when the platform keeps the
 *    conversation's CLI session, applies it. A resume it cannot apply throws, and the turn fails with that reason.
 * 3. `query()` with the app's options, then the helper's, then (only when a session applied) the session's own: see
 *    {@link runClaudeTurn} for the order.
 * 4. The MCP servers over the CLI's stdin (`setMcpServers`) and the wait for them to leave `pending`, each bounded. The
 *    user message goes out only after that; a startup error closes the query and is the turn's error.
 * 5. Every SDK message forwarded with `emit.native`, after the session's first-message confirm: a refused confirm
 *    forwards nothing and fails the turn with its reason.
 * 6. The `result` message's text is the turn's text.
 *
 * The library never imports the Claude Agent SDK: the app passes its own `query`, so its own pinned SDK runs. The types
 * below name only what this function calls, and the app's own options type flows through from that `query`.
 */

/** The user message the turn sends: exactly the SDK's shape for one user turn. */
export interface ClaudeTurnUserMessage {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: AnthropicUserBlock[] };
  readonly parent_tool_use_id: null;
}

/** The fields of one SDK message this function reads: the confirm's, plus a result's `subtype` and `result`. */
export interface ClaudeTurnMessage extends ClaudeSessionMessage {
  readonly result?: string | object | number | boolean | null;
}

/** One MCP server's status as `mcpServerStatus()` answers it; only `status` is read. */
export interface ClaudeTurnServerStatus {
  readonly status: string;
}

/** What `query()` returns, as far as this function uses it. */
/** One MCP server as the turn hands it to the CLI: what the session hashes, plus the header values the spawner hides. */
export interface ClaudeTurnServer extends ClaudeSessionServer {
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ClaudeQueryHandle extends AsyncIterable<ClaudeTurnMessage> {
  setMcpServers(servers: Readonly<Record<string, ClaudeTurnServer>>): Promise<object>;
  mcpServerStatus(): Promise<readonly ClaudeTurnServerStatus[]>;
  close(): void;
}

/**
 * The one option this function READS beyond the session header's fields: the app's `env`. Everything else it writes
 * (`persistSession`, the spawner, the session's id and CLI) is spread over the app's options, so the app's own SDK
 * options type stays exactly what its `query` declares.
 */
export interface ClaudeTurnOwnOptions {
  env?: Readonly<Record<string, string | undefined>>;
}

/** The SDK's `query`, as this function calls it: one async-iterable prompt, and the options. */
export type ClaudeQueryFn<O extends ClaudeTurnOwnOptions> = (args: {
  prompt: AsyncIterable<ClaudeTurnUserMessage>;
  /** Optional on the type because the SDK's own `query` declares it so (that is what lets `O` be read from it). */
  options?: O;
}) => ClaudeQueryHandle;

/** One turn, as the app hands it over. `O` is the app's SDK options type, read from its own `query`. */
export interface ClaudeTurn<O extends ClaudeTurnOwnOptions> {
  /** The app's own `query` from @anthropic-ai/claude-agent-sdk. */
  readonly query: ClaudeQueryFn<O>;
  readonly invoke: Invoke;
  readonly emit: NativeEmit;
  /** The agent's system prompt. Undefined or "" runs the turn without one, and then no session can apply. */
  readonly systemPrompt: string | undefined;
  /** The MCP servers, handed to the CLI over its stdin (`setMcpServers`), never on its argv. */
  readonly servers: Readonly<Record<string, ClaudeTurnServer>>;
  /**
   * The model credential (guuey#2139), as the app read it ONCE at its top, before anything spawned (`readLaunchEnvelope`,
   * else its own environment). Given, this function builds the CLI's spawner itself (`makeClaudeSpawner`): the key reaches
   * only the CLI's own descriptor, and every server header value is one of the secrets no argument or environment value
   * may carry. Absent, the CLI finds its credential as the SDK does. Never together with `options.spawnClaudeCodeProcess`.
   */
  readonly credential?: { readonly key: string; readonly keyKind: ClaudeKeyKind };
  /**
   * Everything else `query()` gets: the app's posture (model, tool rules, `tools`, `settingSources`, `strictMcpConfig`,
   * `includePartialMessages`, `maxTurns`, `pathToClaudeCodeExecutable`, ...). `env` defaults to this process's environment
   * minus every credential, auth-path and inspector variable (`CLAUDE_FORBIDDEN_ENV`).
   */
  readonly options: O & ClaudeSessionHeader;
  /**
   * The conversation's own tool rules, WITHOUT this turn's withholds: what the session is kept for. A tool withheld for
   * one turn is still refused (`options` is what `query()` gets), but it never starts the conversation over.
   * Default: the rules in `options`.
   */
  readonly sessionRules?: { readonly allowedTools: readonly string[]; readonly disallowedTools: readonly string[] };
  /** How a START turn's text carries the thread. Default: {@link withHistory}. */
  readonly history?: (invoke: Invoke) => string;
  /**
   * Whether this agent's model can open a stored file this turn (it has a Read-class tool): it decides how the files
   * note names each non-native part (design v7 D1). Must equal the worker's serveNative `parts.fileTools`. Default false.
   */
  readonly fileTools?: boolean;
}

/** How long the MCP servers may stay `pending` before the turn goes on without them. */
export const CLAUDE_TURN_MCP_READY_DEADLINE_MS = 15_000;
/**
 * How long the CLI may take to answer a control request (`setMcpServers`, `mcpServerStatus`). A CLI that never answers
 * fails the turn instead of hanging it. The pinned CLI connects the servers before it answers `setMcpServers` and gives
 * a hung server up to 30 s, so this outlasts that wait. Same value as `@guuey/host`'s `CLAUDE_STARTUP_DEADLINE_MS`.
 */
export const CLAUDE_TURN_STARTUP_DEADLINE_MS = 60_000;

/** The session header: a CLOSED pick of what the session is kept for. Nothing else of the options reaches it. */
function sessionHeaderOf(options: ClaudeSessionHeader, rules: ClaudeTurn<ClaudeTurnOwnOptions>["sessionRules"]): ClaudeSessionHeader {
  return {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
    ...(options.canUseTool !== undefined ? { canUseTool: options.canUseTool } : {}),
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(rules !== undefined
      ? { allowedTools: rules.allowedTools, disallowedTools: rules.disallowedTools }
      : {
          ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
          ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
        }),
  };
}

/** Resolve with `work`, or reject naming `what` once the startup deadline passes first. */
function withStartupDeadline<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Claude CLI startup failed: no answer to ${what} within ${String(CLAUDE_TURN_STARTUP_DEADLINE_MS)} ms`)),
      CLAUDE_TURN_STARTUP_DEADLINE_MS,
    );
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/** This process's environment minus every credential, auth-path and inspector variable: the CLI's default env. */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CLAUDE_FORBIDDEN_ENV.includes(name)) env[name] = value;
  }
  return env;
}

/** An SDK message as the Router's native event: its JSON form (the SDK's messages are plain JSON). */
function nativeOf(message: ClaudeTurnMessage): JsonValue {
  return JSON.parse(JSON.stringify(message)) as JsonValue;
}

/**
 * Run one Claude turn and return its result text (see {@link ClaudeTurn}). Throws the turn's error: a resume the
 * platform could not apply, a refused first-message confirm, or a CLI startup failure.
 *
 * `query()` gets, in this order (a later one wins): the app's `options`; then the spawner built from `credential`;
 * then `persistSession: false` (without a platform session, each turn's thread arrives in `invoke.history`, and a
 * persisted transcript would land in the end user's durable home) and the env (the app's, else {@link cliEnv}'s); then, ONLY when a session applied, the session's own: its `env`
 * (CLAUDE_CONFIG_DIR, over the app's env), and its options: the session id or resume id, `persistSession: true`, and
 * `pathToClaudeCodeExecutable` = the platform's pinned CLI, which wins over the app's own path because the session file
 * belongs to that binary.
 */
export async function runClaudeTurn<O extends ClaudeTurnOwnOptions>(turn: ClaudeTurn<O>): Promise<string> {
  const { invoke, emit, systemPrompt, servers, options, credential } = turn;
  if (credential !== undefined && "spawnClaudeCodeProcess" in options && options.spawnClaudeCodeProcess !== undefined) {
    throw new TypeError("runClaudeTurn: pass the credential or options.spawnClaudeCodeProcess, not both");
  }
  const resumes = invoke.cliSession?.mode === "resume";
  const history = turn.history ?? withHistory;
  const content = anthropicUserContent(invoke, resumes ? modelInputOf(invoke) : history(invoke), {
    fileTools: turn.fileTools === true,
  });
  const session: WorkerClaudeSession | undefined = emit.claudeSession?.({
    systemPrompt: systemPrompt || undefined,
    header: sessionHeaderOf(options, turn.sessionRules),
    servers,
    content,
  });
  // An emit without claudeSession (a hand-built stand-in, not serveNative's) cannot continue a session, and a resume
  // has no history to run with.
  if (resumes && session === undefined) throw new Error(cliSessionNotAppliedMessage("this serve loop has no claudeSession"));

  // Set when the CLI's first message does not confirm the session: the turn's error, and nothing is forwarded.
  let resumeFailed: string | undefined;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => (openGate = resolve));
  let endInput!: () => void;
  const inputDone = new Promise<void>((resolve) => (endInput = resolve));
  // The one user message goes out only once the MCP gate below decided; a failed startup opens the gate with `send`
  // still false, so none is sent.
  let send = false;
  async function* userMessages(): AsyncGenerator<ClaudeTurnUserMessage> {
    await gate;
    if (!send) return;
    // The turn's images (if any) as image blocks, then the text: the same blocks the hello hashed.
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
    await inputDone;
  }
  const q = turn.query({
    prompt: userMessages(),
    options: {
      ...options,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(credential !== undefined
        ? {
            spawnClaudeCodeProcess: makeClaudeSpawner({
              ...credential,
              secrets: Object.values(servers).flatMap((server) => Object.values(server.headers ?? {})),
            }),
          }
        : {}),
      persistSession: false,
      env: { ...(options.env ?? cliEnv()), ...session?.env },
      ...session?.options,
    },
  });
  let result = "";
  const messages = (async () => {
    let confirmed = session === undefined;
    for await (const message of q) {
      if (!confirmed) {
        resumeFailed = session?.confirmFirst(message);
        if (resumeFailed !== undefined) {
          endInput();
          openGate();
          q.close();
          return;
        }
        confirmed = true;
      }
      emit.native(nativeOf(message));
      if (message.type === "result") {
        if (message.subtype === "success" && typeof message.result === "string") result = message.result;
        endInput();
      }
    }
  })();
  try {
    await withStartupDeadline(q.setMcpServers(servers), "setMcpServers");
    const readyBy = Date.now() + CLAUDE_TURN_MCP_READY_DEADLINE_MS;
    while (
      Date.now() < readyBy &&
      (await withStartupDeadline(q.mcpServerStatus(), "mcpServerStatus")).some((s) => s.status === "pending")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (err) {
    endInput();
    openGate();
    q.close();
    // The setup error is the turn's error; the stream's own end is awaited, not reported.
    await Promise.allSettled([messages]);
    throw resumeFailed !== undefined ? new Error(resumeFailed) : err;
  }
  if (resumeFailed !== undefined) {
    await Promise.allSettled([messages]);
    throw new Error(resumeFailed);
  }
  send = true;
  openGate();
  await messages;
  endInput();
  if (resumeFailed !== undefined) throw new Error(resumeFailed);
  return result;
}
