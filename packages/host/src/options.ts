/**
 * Snapshot → Claude Agent SDK `Options` construction. Lifted from
 * `backend/services/nocode-runtime/src/agent-runner.ts` (the pure-logic half),
 * with the B2-mcp amendment: `@guuey/host` is a THIN CRED-DIR READER. All MCP
 * resolution (default, federation, mint, env-substitution) now lives once on the
 * Router-side credential broker. The worker just reads
 * `<sessionDir>/.guuey/credentials/*.json` (via ctx.listCredentials) and shapes
 * each entry into the framework-neutral `SdkMcpServer` map.
 *
 * Two responsibilities:
 *
 * 1. **Snapshot → SDK options mapping.** Translates the agent.json shape
 *    (model, allowedTools, maxTurns, GuueyFS binding) and the cred-dir contents
 *    into the Claude Agent SDK's `mcpServers` + `allowedTools` + `maxTurns`.
 * 2. **Cred-dir mapping.** `resolveMcpServers(ctx)` globs the cred dir via
 *    `ctx.listCredentials()` → one `SdkMcpServer` per file; ALL the old
 *    federation/default/isGguiUrl/env-sub logic is DELETED (Router-side now).
 *
 * OSS-legality: this package imports ONLY `@anthropic-ai/claude-agent-sdk`,
 * `@guuey/worker`, `@guuey/config`, and Node built-ins.
 */
import type { CanUseTool, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Fs, HistoryMessage, JsonValue } from "@guuey/worker";
import { GUUEY_DEFAULT_SYSTEM_PROMPT, type GuueyAgent } from "@guuey/config";

export type { SDKMessage };

/** Default Claude model — only used when the snapshot omits `model`. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Default cap on agent-loop turns per user message (matches the SDK/runner default). */
const DEFAULT_MAX_TURNS = 25;

/**
 * Env-var names the Router injects so agent code reaches the home/app layers
 * portably. Host-owned copies of `@guuey/fs`'s `ENV_HOME_DIR`/`ENV_APP_DIR`
 * (trivial string literals — not imported, to keep this package OSS-legal).
 */
export const ENV_HOME_DIR = "GUUEY_HOME_DIR";
export const ENV_APP_DIR = "GUUEY_APP_DIR";

/**
 * File tools enabled when GuueyFS layers are bound. `Bash` is added separately
 * (see {@link BASH_TOOL}) so the two are independently testable.
 */
const FS_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];

/**
 * Real shell exec, enabled alongside the file tools when GuueyFS layers are
 * bound. Unlike the source runner — which enabled `Bash` only when the SDK's OWN
 * `sandbox:{}` block was on — this host runs entirely INSIDE the Router's
 * bubblewrap jail, so the OS isolation is always present whenever fs is bound.
 * The SDK `sandbox:{}` block is therefore NOT set here (it would spawn a nested
 * bubblewrap inside the Router's bwrap); the Router's bwrap IS the isolation.
 */
const BASH_TOOL = "Bash";

/**
 * The credential file the Router-side broker writes per invoke at
 * `<sessionDir>/.guuey/credentials/<server>.json`. Shape from spec §7.1 (B2-mcp).
 * `transport` is required so the worker knows which SDK arm to build without
 * consulting the snapshot — the broker owns ALL resolution including transport.
 */
export interface CredentialFile {
  /** The resolved MCP URL (may be scoped `<host>/apps/<id>` for federated ggui). */
  url: string;
  /** Transport the broker selected for this server. */
  transport: "http" | "sse";
  /** Headers to forward — typically `{ authorization: 'Bearer <token>' }`. */
  headers: Record<string, string>;
  /** ISO expiry; informational for the worker (the Router refreshes per invoke). */
  expiresAt?: string;
}

/**
 * SDK's `mcpServers` value shape — recreated structurally rather than imported
 * because the SDK ships it as part of `Options['mcpServers']` (a record-of-union)
 * and pulling out a single arm is awkward in TS.
 */
export type SdkMcpServer =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[] };

/**
 * One prior memory record fed into the `<thread_memory>` preamble. Host-owned,
 * minimal projection of `@silverprotocol/core`'s `AgMemoryRecord` (the preamble
 * reads only `key`/`value`). Not imported — OSS-legality.
 */
export interface PriorMemoryRecord {
  key?: string;
  value: JsonValue;
}

/**
 * Per-invoke context `buildOptions` needs beyond the static snapshot. Sourced by
 * the worker loop from the `invoke` control message + boot env.
 */
export interface BuildOptionsContext {
  /** The user message — passed to `query({ prompt })` by the caller. */
  input: string;
  /** Router-vouched end-user identity. */
  identity: { userId: string; authMode: "anonymous" | "authenticated" };
  /** Anthropic API key (from env). Required — `buildOptions` throws if absent. */
  apiKey?: string;
  /**
   * Per-session GuueyFS layer mounts (the invoke's `fs`). When present, the
   * invoke binds `cwd`=session, exposes home+app as `additionalDirectories`,
   * enables the file tools, and injects `GUUEY_*` env. Absent → no FS binding.
   */
  fs?: Fs;
  /** Recent conversation window for the `<conversation_history>` preamble. */
  history?: HistoryMessage[];
  /** Thread-scoped memory for the `<thread_memory>` preamble (the §1.4 push). */
  priorMemory?: PriorMemoryRecord[];
  /** Prior working-state blob for the `<working_state>` preamble. */
  priorState?: JsonValue;
  /** Env map — reserved for future header expansion (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /**
   * Returns every credential the Router broker wrote to
   * `<sessionDir>/.guuey/credentials/` this invoke — one `{name, cred}` per
   * usable MCP server. `name` is the filename stem (server name); `cred` is the
   * parsed `CredentialFile`. Injected so option-building stays pure (no disk).
   */
  listCredentials: () => Array<{ name: string; cred: CredentialFile }>;
  /** Cancels the in-flight `query` when the client disconnects. */
  abortController?: AbortController;
}

/**
 * Build the Claude Agent SDK `Options` for one invoke. Pure: all disk/env access
 * is injected via {@link BuildOptionsContext}. Throws on an unresolved `{file}`
 * system prompt or a missing API key (the same loud failures the source had).
 */
export function buildOptions(snapshot: GuueyAgent, ctx: BuildOptionsContext): Options {
  const apiKey = ctx.apiKey;
  if (!apiKey) {
    throw new Error(
      "@guuey/host: ANTHROPIC_API_KEY env var required (the Router sets it at pod boot).",
    );
  }

  // Snapshots reach the worker fully resolved — the CLI's loader inlines any
  // `{file}` system prompt before upload. A `{file}` reaching the worker means
  // someone hit the API directly with an un-resolved snapshot; reject loudly.
  if (snapshot.systemPrompt !== undefined && typeof snapshot.systemPrompt !== "string") {
    throw new Error(
      `@guuey/host: snapshot.systemPrompt must be a resolved string (got ${JSON.stringify(
        snapshot.systemPrompt,
      )}). The CLI inlines {file} references before upload; workers never read the filesystem.`,
    );
  }

  const mcpServers = resolveMcpServers(ctx);
  const allowedTools = buildAllowedTools(snapshot, Object.keys(mcpServers), Boolean(ctx.fs));
  const systemPrompt = withContextPreamble(
    snapshot.systemPrompt ?? GUUEY_DEFAULT_SYSTEM_PROMPT,
    ctx.history,
    ctx.priorMemory,
    ctx.priorState,
  );
  const model = snapshot.model ?? DEFAULT_MODEL;
  const maxTurns = snapshot.runtime?.maxTurns ?? DEFAULT_MAX_TURNS;
  const fs = ctx.fs;

  // Whether the operator pinned a Claude permission mode in agent.json. When
  // set we forward it verbatim and let the SDK's mode govern the posture; when
  // unset we install the auto-allow `canUseTool` below so the default no-code
  // agent's Bash runs prompt-free (a never-answered prompt would hang the pod).
  const explicitMode = snapshot.claude?.permissions?.mode;

  const options: Options = {
    model,
    mcpServers,
    allowedTools,
    // With GuueyFS layers bound, expose the file tools PLUS real `Bash`; without
    // them this is byte-identical to the source (purely MCP-driven). `Bash` is
    // safe here because the host already runs inside the Router's bubblewrap
    // jail — that bwrap, NOT the SDK's own `sandbox:{}` block, is the isolation.
    tools: fs ? [...FS_TOOLS, BASH_TOOL] : [],
    // Settings isolation. Empty array = "no filesystem settings loaded" — guards
    // against a future SDK change auto-pulling `~/.claude/settings.json` and
    // leaking the operator's logged-in Claude Code MCPs into the tool catalog.
    settingSources: [],
    strictMcpConfig: true,
    maxTurns,
    env: {
      ANTHROPIC_API_KEY: apiKey,
      ...(snapshot.env ?? {}),
      ...(fs ? { [ENV_HOME_DIR]: fs.home, [ENV_APP_DIR]: fs.app } : {}),
    },
    systemPrompt,
    // GuueyFS binding (opt-in): session dir as cwd, home+app as extra roots.
    ...(fs ? { cwd: fs.session, additionalDirectories: [fs.home, fs.app] } : {}),
    // Permission posture. Two mutually-exclusive paths:
    //
    //  - Operator pinned `claude.permissions.mode` → forward it verbatim; the
    //    operator owns the posture (e.g. `acceptEdits`).
    //  - No explicit mode + fs bound → install an auto-allow `canUseTool`. In
    //    the SDK permission flow (hooks → deny → allow → ask → mode/canUseTool),
    //    `default` mode with no callback routes Bash subcommands through an
    //    interactive permission prompt — which, in this headless ephemeral pod,
    //    no one answers, so the agent would HANG. The auto-allow callback short-
    //    circuits that: every tool the model picks (already constrained to
    //    `tools`/`allowedTools` + `settingSources:[]` + `strictMcpConfig`) is
    //    allowed without a prompt. This is safe precisely because the Router's
    //    bubblewrap jail is the real isolation boundary — NOT the SDK's own
    //    `sandbox:{}` block (which is intentionally absent to avoid a nested
    //    bwrap inside the Router's bwrap). We do NOT use `bypassPermissions`
    //    here: it requires `allowDangerouslySkipPermissions` and globally
    //    disables hooks/deny-rule evaluation, whereas the callback keeps the
    //    deny/hook stages intact while only collapsing the final ask stage.
    ...(explicitMode
      ? { permissionMode: explicitMode }
      : fs
        ? { canUseTool: autoAllowTool }
        : {}),
    ...(ctx.abortController ? { abortController: ctx.abortController } : {}),
  };

  return options;
}

/**
 * Auto-allow permission callback. Installed when fs is bound and the operator
 * did NOT pin `claude.permissions.mode`, so the default no-code agent's `Bash`
 * (and the file tools) run prompt-free. Returns `{ behavior: 'allow' }` for
 * every request, passing the input through unchanged.
 *
 * Safe because the model's tool surface is already locked down BEFORE the
 * callback ever fires — `tools`/`allowedTools` cap which tools exist,
 * `settingSources:[]` blocks filesystem-loaded settings, `strictMcpConfig`
 * pins the MCP catalog — and the real OS isolation is the Router's bubblewrap
 * jail this whole process runs inside. The callback only collapses the SDK's
 * final interactive "ask" stage (which would otherwise hang a headless pod);
 * the earlier hook/deny-rule stages of the permission flow still run.
 */
export const autoAllowTool: CanUseTool = (_toolName, input) =>
  Promise.resolve({ behavior: "allow", updatedInput: input });

/**
 * Map the Router-resolved cred files to the framework-neutral SdkMcpServer map.
 * The Router (credential-broker) owns ALL resolution — default, federation, mint,
 * env-substitution; this worker just reads `<session>/.guuey/credentials/*.json`
 * (via ctx.listCredentials) and shapes each entry. Keyed by the server name.
 */
export function resolveMcpServers(ctx: BuildOptionsContext): Record<string, SdkMcpServer> {
  const out: Record<string, SdkMcpServer> = {};
  for (const { name, cred } of ctx.listCredentials()) {
    out[name] = {
      type: cred.transport,
      url: cred.url,
      ...(Object.keys(cred.headers).length > 0 ? { headers: cred.headers } : {}),
    };
  }
  return out;
}

/**
 * Build the SDK's `allowedTools` array. MCP tools are auto-namespaced by the SDK
 * as `mcp__<server>__<tool>`; we can't enumerate the namespaces ahead of time,
 * so the allowlist is necessarily wildcard-ish.
 *
 * - explicit `tools.allowlist` → pass those literal names through.
 * - else → allow every tool from every declared server via `mcp__<server>`.
 *
 * When GuueyFS layers are bound, the file tools AND `Bash` join the allowlist
 * (an allow rule in the SDK permission flow), so the model may use them
 * alongside the MCP allowlist. The auto-allow `canUseTool` (or the operator's
 * pinned mode) governs whether those still prompt — see `buildOptions`.
 */
function buildAllowedTools(
  snapshot: GuueyAgent,
  declaredServerNames: string[],
  fsBound: boolean,
): string[] {
  const explicit = snapshot.tools?.allowlist;
  const base =
    explicit && explicit.length > 0
      ? explicit.slice()
      : declaredServerNames.map((s) => `mcp__${s}`);
  return fsBound ? [...base, ...FS_TOOLS, BASH_TOOL] : base;
}

/**
 * Render prior context sections (conversation history, thread memory, working
 * state) as a preamble and prepend to the system prompt. The SDK's `query()`
 * accepts only the current `input` as `prompt`, so feeding context here is how
 * an ephemeral worker gives the model memory across invokes.
 *
 * Empty sections are omitted; if all inputs are empty/undefined the original
 * system prompt is returned unchanged. Exported for unit testing + reuse by the
 * worker loop.
 */
export function withContextPreamble(
  systemPrompt: string,
  history: HistoryMessage[] | undefined,
  priorMemory: PriorMemoryRecord[] | undefined,
  priorState: JsonValue | undefined,
): string {
  const sections: string[] = [];

  if (history && history.length > 0) {
    sections.push(
      [
        "Prior conversation with this user, for context. Continue naturally;",
        "do not repeat it back verbatim.",
        "<conversation_history>",
        ...history.map((m) => `${roleLabel(m.role)}: ${m.text}`),
        "</conversation_history>",
      ].join("\n"),
    );
  }

  if (priorMemory && priorMemory.length > 0) {
    sections.push(
      [
        "Facts you previously recorded for this thread. Treat as known.",
        "<thread_memory>",
        ...priorMemory.map((m) => `${m.key ?? "(unkeyed)"}: ${JSON.stringify(m.value)}`),
        "</thread_memory>",
      ].join("\n"),
    );
  }

  if (priorState !== undefined) {
    sections.push(
      [
        "Your working state carried from the previous turn.",
        "<working_state>",
        JSON.stringify(priorState, null, 2),
        "</working_state>",
      ].join("\n"),
    );
  }

  if (sections.length === 0) return systemPrompt;
  return `${sections.join("\n\n")}\n\n${systemPrompt}`;
}

function roleLabel(role: HistoryMessage["role"]): string {
  return role === "agent" ? "Assistant" : "User";
}
