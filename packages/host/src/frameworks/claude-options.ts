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
import type { CanUseTool, Options, SDKMessage, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { Fs, HistoryMessage, JsonValue } from "@guuey/worker";
import { GUUEY_DEFAULT_SYSTEM_PROMPT, defaultModelFor, type GuueyAgent } from "@guuey/config";

export type { SDKMessage };

/**
 * Default Claude model — only used when the snapshot omits `model`. Derived
 * from the `@guuey/config` registry (single source of truth per the
 * model-release playbook §8 item A) rather than a bare literal, so a
 * registry default change propagates here automatically.
 */
const DEFAULT_MODEL = defaultModelFor("claude-agent-sdk");

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
 * Belt-and-braces (spec §4): guuey's memory mechanism is prompted file memory
 * (a platform-owned system-prompt section, below), never the SDK's own
 * auto-memory. Set UNCONDITIONALLY on every `Options` this module builds so a
 * future SDK default flip can never start writing its own memory format into
 * the durable, quota-billed home layer without Guuey explicitly opting in.
 */
const AUTO_MEMORY_DISABLED: Settings = { autoMemoryEnabled: false };

/**
 * SAVE half of prompted file memory (spec §4) — a platform-owned instruction
 * pointing the model at its own file tools + the well-known memory path.
 * Deliberately generic (no per-user content): the model decides WHAT is
 * durable-worthy, this just tells it WHERE.
 */
const MEMORY_SAVE_INSTRUCTION =
  "## Persistent user memory\n\n" +
  "Your persistent memory for this user lives at $GUUEY_HOME_DIR/memories/MEMORY.md — " +
  "read it if you need older detail, and update it via your file tools whenever you " +
  "learn durable facts about the user.";

/** Heading for the RECALL block — matched by callers/tests, kept as one constant. */
const MEMORY_RECALL_HEADING = "## What you remember about this user";

/**
 * Build the platform-owned memory system-prompt section (spec §4): the SAVE
 * instruction plus, when {@link BuildOptionsContext.userMemory} is present, a
 * RECALL block rendering the Router-read `MEMORY.md` content. Scoped to
 * `authMode === "authenticated"` AND an fs binding — a guest has no durable
 * home to point at (and the spec forbids offering guests a memory tool at
 * all), and no fs means no file tools exist to act on the instruction.
 * Returns `""` (append-safe, no leading/trailing noise) when out of scope.
 */
function buildMemorySection(ctx: BuildOptionsContext): string {
  if (!ctx.fs || ctx.identity.authMode !== "authenticated") return "";
  const recall = ctx.userMemory ? `\n\n${MEMORY_RECALL_HEADING}\n\n${ctx.userMemory}` : "";
  return `\n\n${MEMORY_SAVE_INSTRUCTION}${recall}`;
}

// CredentialFile now lives in ../creds.js (framework-neutral, shared by every
// runner); re-exported here so existing importers keep working.
export type { CredentialFile } from "../creds.js";
import type { CredentialFile } from "../creds.js";

/**
 * SDK's `mcpServers` value shape — recreated structurally rather than imported
 * because the SDK ships it as part of `Options['mcpServers']` (a record-of-union)
 * and pulling out a single arm is awkward in TS.
 */
export type SdkMcpServer =
  | { type: "http"; url: string; headers?: Record<string, string>; alwaysLoad?: boolean }
  | { type: "sse"; url: string; headers?: Record<string, string>; alwaysLoad?: boolean }
  | { type: "stdio"; command: string; args?: string[]; alwaysLoad?: boolean };

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
  /**
   * Anthropic API key — used for local-dev / off-sandbox fallback when
   * `baseUrl` + `authToken` are absent. One of (`baseUrl`+`authToken`) or
   * `apiKey` must be provided; `buildOptions` throws if neither is present.
   */
  apiKey?: string;
  /**
   * Loopback proxy base URL for the managed-LLM broker (`ANTHROPIC_BASE_URL`).
   * When present together with `authToken`, the Claude CLI subprocess is routed
   * through the broker; the real API key is intentionally omitted from
   * `options.env` so it cannot leak to agent code.
   */
  baseUrl?: string;
  /**
   * Opaque session token for the loopback proxy (`ANTHROPIC_AUTH_TOKEN`).
   * Required when `baseUrl` is set; ignored when only `apiKey` is present.
   */
  authToken?: string;
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
  /**
   * Content of the authenticated caller's `<home>/memories/MEMORY.md` file —
   * prompted file memory's RECALL half (guueyfs-slice4 spec §4), read
   * Router-side BEFORE this invoke so recall never depends on the model
   * choosing to read a file. Rendered into a platform-owned "## What you
   * remember about this user" system-prompt section when present. DISTINCT
   * from {@link priorMemory}: that is the persistence-fold THREAD-scoped
   * conversation memory (AgJSON `<thread_memory>` preamble); this is the
   * cross-session, cross-thread USER memory file. Absent for an anonymous
   * caller (never read Router-side) and for an authenticated caller with no
   * memory file yet.
   */
  userMemory?: string;
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
  const baseUrl = ctx.baseUrl;
  const authToken = ctx.authToken;

  // Require either the loopback proxy credentials (hosted/broker path) or a
  // direct API key (local-dev fallback). Neither → fail loudly.
  if (!((baseUrl !== undefined && authToken !== undefined) || apiKey)) {
    throw new Error(
      "@guuey/host: either (baseUrl + authToken) for the managed-LLM proxy, " +
        "or ANTHROPIC_API_KEY for local dev, is required.",
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
  const systemPrompt =
    withContextPreamble(
      snapshot.systemPrompt ?? GUUEY_DEFAULT_SYSTEM_PROMPT,
      ctx.history,
      ctx.priorMemory,
      ctx.priorState,
    ) + buildMemorySection(ctx);
  const model = snapshot.model ?? DEFAULT_MODEL;
  const maxTurns = snapshot.runtime?.maxTurns ?? DEFAULT_MAX_TURNS;
  const fs = ctx.fs;

  // Build the subprocess env. Two mutually-exclusive paths:
  //
  //  - Proxy path (baseUrl + authToken present): route the Claude CLI
  //    subprocess through the managed-LLM broker. baseUrl + authToken are
  //    spread LAST so a builder's snapshot.env cannot override them.
  //    ANTHROPIC_API_KEY is intentionally absent — the proxy owns auth.
  //    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC suppresses telemetry pings
  //    that would bypass the proxy.
  //
  //  - Local-dev fallback (only apiKey present): pass the real key directly.
  //    The guard above guarantees apiKey is non-null on this branch.
  // Explicit Record<string, string> annotation prevents TypeScript from widening
  // the ternary to a union `{ K: string } | {}`, which would make spread targets
  // produce optional-undefined keys that conflict with Record<string, string>.
  // CLAUDE_CONFIG_DIR pins the CLI's own config/state root to the (ephemeral,
  // pod-local) session dir — spec §4 belt-and-braces, alongside the
  // unconditional `settings.autoMemoryEnabled:false` below — so CLI session
  // state never lands in the durable, quota-billed home layer.
  const fsEnv: Record<string, string> = fs
    ? { [ENV_HOME_DIR]: fs.home, [ENV_APP_DIR]: fs.app, CLAUDE_CONFIG_DIR: fs.session }
    : {};
  let env: Record<string, string>;
  if (baseUrl !== undefined && authToken !== undefined) {
    env = {
      ...(snapshot.env ?? {}),
      ...fsEnv,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: authToken,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
  } else {
    // apiKey is guaranteed non-null by the guard; the if-check narrows the type.
    if (!apiKey) throw new Error("unreachable: apiKey guard should have prevented this path");
    env = {
      ANTHROPIC_API_KEY: apiKey,
      ...(snapshot.env ?? {}),
      ...fsEnv,
    };
  }

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
    // Belt-and-braces (spec §4): the SDK's OWN auto-memory is disabled
    // UNCONDITIONALLY, on every invoke, regardless of fs/authMode — Guuey's
    // memory mechanism is the platform-owned prompted-file scheme above, not
    // the SDK's. This guards against a future SDK default flip writing its
    // own memory format into (durable, quota-billed) home without Guuey ever
    // opting in.
    settings: AUTO_MEMORY_DISABLED,
    strictMcpConfig: true,
    maxTurns,
    env,
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
      // Declared MCP servers ARE this agent's tool surface. Without
      // alwaysLoad the CLI defers MCP tools behind its ToolSearch built-in —
      // absent here (tools: []) — leaving the model tool-less. Empirically
      // load-bearing; mirrors the scaffold template's worker (see
      // create-agentic-app templates-src claude worker.ts).
      alwaysLoad: true,
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

// withContextPreamble now lives in ../preamble.js (framework-neutral — the
// ADK runner renders the same preamble); re-exported for existing importers.
export { withContextPreamble } from "../preamble.js";
import { withContextPreamble } from "../preamble.js";
