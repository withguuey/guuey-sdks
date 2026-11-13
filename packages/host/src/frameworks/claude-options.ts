/**
 * Snapshot → Claude Agent SDK `Options` construction. Lifted from
 * `backend/services/nocode-runtime/src/agent-runner.ts` (the pure-logic half),
 * with the B2-mcp amendment: `@guuey/host` is a THIN CRED-DIR READER. All MCP
 * resolution (default, federation, mint, env-substitution) now lives once on the
 * Router-side credential broker. The worker just reads the broker's entries
 * (via ctx.listCredentials: the servers file when `GUUEY_MCP_SERVERS_FILE` is
 * set, else `<sessionDir>/.guuey/credentials/*.json`) and shapes each entry
 * into the framework-neutral `SdkMcpServer` map.
 *
 * Two responsibilities:
 *
 * 1. **Snapshot → SDK options mapping.** Translates the agent.json shape
 *    (model, allowedTools, maxTurns, GuueyFS binding) and the credential entries
 *    into the Claude Agent SDK's `allowedTools` + `maxTurns` (the MCP servers go
 *    to the CLI over stdin with `setMcpServers`, guuey#2139, never as options).
 * 2. **Credential mapping.** `resolveMcpServers(ctx)` reads the entries via
 *    `ctx.listCredentials()` → one `SdkMcpServer` per entry; ALL the old
 *    federation/default/isGguiUrl/env-sub logic is DELETED (Router-side now).
 *
 * OSS-legality: this package imports ONLY `@anthropic-ai/claude-agent-sdk`,
 * `@guuey/worker`, `@guuey/config`, and Node built-ins.
 */
import { isAbsolute } from "node:path";
import type { CanUseTool, Options, SDKMessage, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { CredentialFile, FirstImpressionPush, FirstImpressionShown, Fs, HistoryMessage, JsonValue, McpAvailability, ProfileSection, WithheldTool } from "@guuey/worker";
import { claudeCodeExecutableOf, forbiddenClaudeEnvNames, isClaudeHostOwnedEnvName, makeClaudeSpawner, trustEnvOf } from "@guuey/worker";
import {
  BUILTIN_TOOLS,
  GUUEY_DEFAULT_SYSTEM_PROMPT,
  claudeToolRules,
  declaresNoTools,
  defaultModelFor,
  rejectsDisabledThinking,
  type GuueyAgent,
  type ProfileAccess,
  type RunSnapshot,
  withoutReservedEnvNames,
} from "@guuey/config";
import { buildSystemPrompt, buildTurnContextBlocks, promptClassOf, type PromptClass } from "../preamble.js";

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
 * portably. Host-owned copies (trivial string literals — not imported, to
 * keep this published package OSS-legal: it cannot depend on the
 * platform-private `@guuey-private/fs-contract`). Sync sites if these ever
 * change: `backend/libs/fs-contract/src/contract.ts` (the platform-internal
 * source of truth) and `oss/packages/fs/src/roots.ts` (the public dev-guidance
 * helper's own copy, same OSS-legality constraint).
 */
export const ENV_HOME_DIR = "GUUEY_HOME_DIR";
export const ENV_APP_DIR = "GUUEY_APP_DIR";
// The built-in catalog (the file tools plus `Bash`) is `BUILTIN_TOOLS`, the one
// list in `@guuey/config` (guuey#2651). It is enabled when GuueyFS layers are
// bound ({@link BuildOptionsContext.fsBound}). `Bash` here is real shell exec:
// this host runs entirely INSIDE the Router's bubblewrap jail, so the OS
// isolation is always present whenever fs is bound, and the SDK `sandbox:{}`
// block is NOT set (it would spawn a nested bubblewrap inside the Router's
// bwrap).

/**
 * Belt-and-braces (spec §4): guuey's memory mechanism is prompted file memory
 * (a platform-owned system-prompt section, `../preamble.js`), never the SDK's own
 * auto-memory. Set UNCONDITIONALLY on every `Options` this module builds so a
 * future SDK default flip can never start writing its own memory format into
 * the durable, quota-billed home layer without Guuey explicitly opting in.
 */
const AUTO_MEMORY_DISABLED: Settings = { autoMemoryEnabled: false };

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
 * The Claude CLI's own state roots for one invoke, each a fresh, empty
 * directory: its config root (`CLAUDE_CONFIG_DIR`, where `.claude.json` and
 * the session transcripts live), its cache, and the XDG config, data and
 * state roots. None is a directory an earlier turn could have written.
 */
export interface CliDirs {
  config: string;
  cache: string;
  xdgConfig: string;
  xdgData: string;
  xdgState: string;
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
   * Per-session layer mounts (the invoke's `fs`). When present, the invoke
   * binds `cwd`=session, exposes home+app as `additionalDirectories`, and
   * injects the `HOME`/`GUUEY_*`/`CLAUDE_CONFIG_DIR` env. NOTE: the wire
   * carries a NON-NULL `fs` on every turn (spec §1.4 — the spec-default
   * `/app`/`/home`/`/session` mounts when GuueyFS is off), so presence here
   * says nothing about whether durable storage is bound. It is therefore NOT
   * the tool-catalog gate — {@link fsBound} is (guuey#234).
   */
  fs?: Fs;
  /**
   * Whether {@link fs} names REAL GuueyFS layers this turn — the pod has
   * `GUUEY_FS_BASE` armed and the Router resolved per-session layer dirs under
   * it — as opposed to the spec-default / federation-ephemeral mounts. THE gate
   * for the built-in file tools + `Bash` (`tools`, and their `allowedTools`
   * entries): absent/false → `tools: []`, purely MCP-driven. Threaded from the
   * runtime on the invoke (`Invoke.fsBound`); mirrors {@link memoryAttached}
   * (the memory-mcp T5 lesson: gate on the real signal, not on `fs` presence —
   * which is why the pre-#234 `Boolean(ctx.fs)` gate put Bash in EVERY no-code
   * agent's catalog on EVERY env).
   */
  fsBound?: boolean;
  /**
   * The CLI's own state roots for THIS invoke: fresh, empty directories the
   * caller made for this invoke alone ({@link CliDirs}). Required whenever
   * {@link fs} is set. The CLI reads `.claude.json` from its config root on
   * every start and applies the `env` block it finds there, even with
   * `settingSources: []`; with the root at `fs.session`, a file a turn wrote
   * there steered the next turn of the same session (the CLI's model calls
   * went to the URL the file named). Roots no earlier turn could write remove
   * that path by construction.
   */
  cliDirs?: CliDirs;
  /** Recent conversation window for the `<conversation_history>` preamble. */
  history?: HistoryMessage[];
  /** guuey#901: the OAuth servers' availability this turn (the "Connected services" section); absent = no such server. */
  mcpAvailability?: McpAvailability[];
  /** Thread-scoped memory for the `<thread_memory>` preamble (the §1.4 push). */
  priorMemory?: PriorMemoryRecord[];
  /** Prior working-state blob for the `<working_state>` preamble. */
  priorState?: JsonValue;
  /**
   * Content of the authenticated caller's `<home>/memories/MEMORY.md` file —
   * prompted memory's RECALL half (memory-mcp spec §4), read Router-side BEFORE
   * this invoke so recall never depends on the model choosing to read a file.
   * Rendered into the RECALL block of the "## What you remember about this user"
   * section when present (the SAVE half is gated on {@link memoryAttached}, not
   * this). DISTINCT from {@link priorMemory}: that is the persistence-fold
   * THREAD-scoped conversation memory (AgJSON `<thread_memory>` preamble); this
   * is the cross-session, cross-thread USER memory file. Absent for an anonymous
   * caller (never read Router-side) and for an authenticated caller with no
   * memory file yet (turn one — the SAVE instruction still renders via
   * {@link memoryAttached}).
   */
  userMemory?: string;
  /**
   * Whether the memory MCP child booted this pod (memory-mcp T5) — the Router
   * threads it per-invoke. Gates the SAVE instruction (`save_memory`) on
   * `authMode === "authenticated" && memoryAttached`, INDEPENDENT of
   * {@link userMemory}: the bootstrap fix so a brand-new authenticated user is
   * told the tool exists before any file. Was previously proxied by `fs`; this
   * is the real signal (the tool is spliced iff this is true for an
   * authenticated invoke).
   */
  memoryAttached?: boolean;
  /**
   * The Router's fail-closed cross-app profile access for this invoke
   * (cross-app-profile T7) — present ONLY for a consenting authenticated caller,
   * clamped to the app's declared posture. Gates the profile system-prompt
   * section ({@link promptClassOf}): the `save_profile` SAVE instruction on
   * `read-write`, the RECALL block on {@link profileSections}. DISTINCT from
   * {@link memoryAttached}: that is this app's own memory tool; this is the
   * consent-gated cross-app profile.
   */
  profileAccess?: ProfileAccess;
  /** The user's cross-app profile sections for the RECALL push (cross-app-profile
   *  T7), read Router-side. Gated by {@link profileAccess}. */
  profileSections?: ProfileSection[];
  /** The first-impression push (guuey#1183) — mirrors `Invoke.firstImpression`; rendered only with the ggui rail armed. */
  firstImpression?: FirstImpressionPush;
  /** The Router's per-turn tool withholds — mirrors `Invoke.withheldTools`; folded into `disallowedTools` for attached servers. */
  withheldTools?: WithheldTool[];
  /** The welcome card the Router already drew — mirrors `Invoke.firstImpressionShown`; rendered whenever present. */
  firstImpressionShown?: FirstImpressionShown;
  /**
   * How many builder-provided reference files sit at `<fs.app>/resources` this
   * turn (guuey#456 B4) — counted Router-side at invoke assembly and written
   * onto the wire only when the layers are REAL and the count is positive.
   * Gates the app-resources system-prompt section
   * ({@link promptClassOf}) together with {@link fsBound}, so the hint
   * never renders on a turn whose file tools are off (the memory-mcp T5
   * lesson: gate on the real signal, never on `fs` presence). See
   * `Invoke.resourceCount` in `@guuey/worker`.
   */
  resourceCount?: number;
  /**
   * Whether the ggui generative-UI rail is ARMED this turn (guuey#630) — the
   * Router sets it only when the ggui credential was actually written, so the
   * generative-UI section never names a tool this turn cannot call. See
   * `Invoke.gguiAttached` in `@guuey/worker`.
   */
  gguiAttached?: boolean;
  /**
   * The UI catalogs the client draws natively this turn (guuey#2386), as the
   * Router passed them. Gates the A2UI section by membership. See
   * `Invoke.clientCatalogs` in `@guuey/worker`.
   */
  clientCatalogs?: readonly string[];
  /**
   * Returns every credential the Router broker wrote for this invoke (the
   * servers file, else `<sessionDir>/.guuey/credentials/`) — one `{name, cred}`
   * per usable MCP server. `name` is the server name; `cred` is the parsed
   * `CredentialFile`. Injected so option-building stays pure (no disk).
   */
  listCredentials: () => Array<{ name: string; cred: CredentialFile }>;
  /** Cancels the in-flight `query` when the client disconnects. */
  abortController?: AbortController;
  /**
   * Secrets that arrive after the CLI is spawned (guuey#3407 leg 5: a parked
   * spare's claiming turn and its MCP header values). The spawner redacts them
   * from the CLI's stderr from the moment they are added.
   */
  lateSecrets?: () => readonly string[];
}

/**
 * A builder's `snapshot.env` named a variable the CLI's environment must not
 * carry (guuey#2139): a credential, an auth-path switch or an inspector
 * variable. The turn errors with this message; it names the variables, never
 * their values.
 */
export class ClaudeBuilderEnvError extends Error {
  constructor(names: readonly string[]) {
    super(
      `agent.env names ${names.join(", ")}, which the Claude CLI environment may not carry: ` +
        "the platform delivers the model credential privately and owns the CLI's auth path. Remove them from agent.env.",
    );
    this.name = "BuilderConfigError";
  }
}

/**
 * The `snapshot.env` names {@link buildOptions} leaves out of the CLI's
 * environment because the platform owns them (the runtime's reserved names and
 * the host-owned CLI variables), in the map's order. Names only, never values.
 */
export function reservedEnvNamesDropped(snapshot: Pick<RunSnapshot, "env">): string[] {
  return builderEnvOf(snapshot).dropped;
}

/**
 * `snapshot.env` without the names the platform owns on the CLI's environment:
 * the runtime's reserved names (`RUNTIME_RESERVED_ENV_NAMES`, `@guuey/config`)
 * and the CLI session and request variables the host owns
 * (`CLAUDE_HOST_OWNED_ENV`, `@guuey/worker`). The dropped names come back in
 * the map's order, so {@link buildOptions} and the report the caller writes
 * never disagree.
 */
function builderEnvOf(snapshot: Pick<RunSnapshot, "env">): { env: Record<string, string>; dropped: string[] } {
  const reserved = withoutReservedEnvNames(snapshot.env);
  const env: Record<string, string> = {};
  const hostOwned: string[] = [];
  for (const [name, value] of Object.entries(reserved.env)) {
    if (isClaudeHostOwnedEnvName(name)) hostOwned.push(name);
    else env[name] = value;
  }
  const droppedSet = new Set([...reserved.dropped, ...hostOwned]);
  return { env, dropped: Object.keys(snapshot.env ?? {}).filter((name) => droppedSet.has(name)) };
}

/** The `PATH` `env` holds, only when set to a non-empty value (guuey#3140). */
export function hostPathEnvOf(env: { readonly [name: string]: string | undefined }): { PATH?: string } {
  const value = env.PATH;
  return value === undefined || value === "" ? {} : { PATH: value };
}

/**
 * The turn's prompt class (A1): every input the system prompt reads, from the
 * snapshot and the invoke context. `tools.allowlist: ["@none"]` (guuey#2262)
 * makes it a no-tools class, which leaves out the sections that name tools the
 * model cannot call.
 */
export function claudePromptClass(snapshot: GuueyAgent, ctx: BuildOptionsContext): PromptClass {
  return promptClassOf(ctx, { noTools: declaresNoTools(snapshot.tools), surfaceHints: snapshot.surfaceHints });
}

/**
 * The leading text blocks of the SDK user message this turn adds (A1): always
 * exactly two, the `<turn_context>` block (always opening with the constant
 * `TURN_CONTEXT_LEAD` line, alone when there is no section) then the
 * `<turn_directive>` block (`<turn_directive></turn_directive>` with no order). `runInvoke` puts
 * each in its own content block, ahead of the invoke's own content.
 */
export function claudeTurnContext(snapshot: GuueyAgent, ctx: BuildOptionsContext): string[] {
  return buildTurnContextBlocks(ctx, claudePromptClass(snapshot, ctx));
}

/**
 * Build the Claude Agent SDK `Options` for one invoke. Pure: all disk/env access
 * is injected via {@link BuildOptionsContext}. Throws on an unresolved `{file}`
 * system prompt or a missing API key (the same loud failures the source had).
 */
export function buildOptions(snapshot: RunSnapshot, ctx: BuildOptionsContext): Options {
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
  const fsBound = ctx.fsBound === true;
  const gates = resolveToolGates(snapshot, Object.keys(mcpServers), fsBound, ctx.withheldTools);
  // A1: the system prompt is a function of the turn's CLASS only (byte-stable
  // across turns and users of a class: the prompt-cache prefix); what varies
  // per turn rides the turn's own message ({@link claudeTurnContext}).
  const systemPrompt = buildSystemPrompt(snapshot.systemPrompt ?? GUUEY_DEFAULT_SYSTEM_PROMPT, claudePromptClass(snapshot, ctx));
  const model = snapshot.model ?? DEFAULT_MODEL;
  const maxTurns = snapshot.runtime?.maxTurns ?? DEFAULT_MAX_TURNS;
  const fs = ctx.fs;

  // Build the subprocess env (guuey#2139). It carries NO credential on either
  // path: the key reaches the CLI only on its private descriptor, through the
  // spawner installed below, so neither the CLI's initial environment nor any
  // Bash, tool or stdio-MCP child it starts holds it.
  //
  //  - Proxy path (baseUrl + authToken present): route the Claude CLI
  //    subprocess through the managed-LLM broker. baseUrl is spread LAST so a
  //    builder's snapshot.env cannot override it. The key is the scoped token.
  //    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC suppresses telemetry pings
  //    that would bypass the proxy.
  //  - Local-dev fallback (only apiKey present): the key is the real API key.
  //
  // A builder's snapshot.env naming a credential, an auth-path switch or an
  // inspector variable is REFUSED with a named error (never silently dropped):
  // `CLAUDE_CODE_REMOTE` would make the CLI persist the key to disk and
  // `CLAUDE_CODE_SIMPLE` would make it ignore the descriptor.
  //
  // CLAUDE_CONFIG_DIR pins the CLI's own config/state root to a fresh, empty
  // per-invoke directory the caller made ({@link BuildOptionsContext.cliDirs}),
  // so CLI session state never lands in the durable, quota-billed home layer
  // (spec §4 belt-and-braces, alongside the unconditional
  // `settings.autoMemoryEnabled:false` below), and no `.claude.json` an earlier
  // turn wrote is read by this one.
  // XDG_CACHE_HOME and the XDG config, data and state roots likewise: the
  // CLI's cache tree (~/.cache/claude-cli-nodejs, MCP logs etc.) follows $HOME
  // by XDG default, and $HOME resolves inside the durable home mount —
  // live-found on the first G5 gate run (2026-07-20) leaking per-invoke log
  // files into quota-billed storage. Each is fresh per invoke, for the same
  // reason as the config root.
  // HOME rides along (guuey#176): this env REPLACES the subprocess env
  // wholesale, and omitting HOME left the agent's shell with no `~` even
  // though bwrap set HOME=/home on the worker (live-found on the multi-pod
  // gate walk — GUUEY_HOME_DIR set, `~` expansion dead). Safe now that the
  // CLI's own state is pinned away from the durable layer via
  // CLAUDE_CONFIG_DIR + XDG_CACHE_HOME below (the G5 leak this env once
  // avoided by omission).
  //
  // The names the platform owns are then left out of the builder's env: the
  // runtime's reserved names (`RUNTIME_RESERVED_ENV_NAMES`, `@guuey/config`; a
  // new document that sets one is refused at deploy) and the CLI session and
  // request variables the host owns (`CLAUDE_HOST_OWNED_ENV`, `@guuey/worker`).
  // A stored definition that names one keeps running without it, and the
  // caller reports each dropped name ({@link reservedEnvNamesDropped}).
  const refusedNames = forbiddenClaudeEnvNames(snapshot.env ?? {});
  if (refusedNames.length > 0) throw new ClaudeBuilderEnvError(refusedNames);
  const builderEnv = builderEnvOf(snapshot).env;
  const cliDirs = ctx.cliDirs;
  if (fs && cliDirs === undefined) {
    throw new Error("@guuey/host: buildOptions needs fresh per-invoke cliDirs whenever fs is set.");
  }
  // guuey#3407 B3 (hardening): an empty value would let the CLI fall back to a
  // default under HOME (`XDG_CACHE_HOME || HOME/.cache` in its own resolver), the
  // durable layer; a relative one would resolve against cwd, the session
  // directory. Refused here, where the env is written, whoever built cliDirs.
  if (cliDirs !== undefined) {
    for (const [name, dir] of Object.entries(cliDirs)) {
      if (!isAbsolute(dir)) throw new Error(`@guuey/host: cliDirs.${name} must be an absolute path (got ${JSON.stringify(dir)}).`);
    }
  }
  const fsEnv: Record<string, string> =
    fs && cliDirs !== undefined
      ? {
          HOME: fs.home,
          [ENV_HOME_DIR]: fs.home,
          [ENV_APP_DIR]: fs.app,
          CLAUDE_CONFIG_DIR: cliDirs.config,
          XDG_CACHE_HOME: cliDirs.cache,
          XDG_CONFIG_HOME: cliDirs.xdgConfig,
          XDG_DATA_HOME: cliDirs.xdgData,
          XDG_STATE_HOME: cliDirs.xdgState,
        }
      : {};
  // The trust variables the host process holds (`PLATFORM_TRUST_ENV_NAMES`):
  // this env replaces the CLI's environment, so without them the CLI trusts
  // public roots only (guuey#3114). After the builder's env, so a builder
  // value never replaces the platform's.
  const trustEnv = trustEnvOf(process.env);
  // The host's own PATH (guuey#3140): this env replaces the CLI's environment,
  // so without it the CLI's Bash child finds no external command (`ls`,
  // `head`, `sleep`); only shell builtins and absolute paths ran. FIRST, so a
  // builder's agent.env PATH (not reserved, and the only PATH a stored
  // definition could give) still replaces it, as it did before.
  const pathEnv = hostPathEnvOf(process.env);
  let env: Record<string, string>;
  let key: string;
  if (baseUrl !== undefined && authToken !== undefined) {
    env = {
      ...pathEnv,
      ...builderEnv,
      ...fsEnv,
      ...trustEnv,
      ANTHROPIC_BASE_URL: baseUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    key = authToken;
  } else {
    // apiKey is guaranteed non-null by the guard; the if-check narrows the type.
    if (!apiKey) throw new Error("unreachable: apiKey guard should have prevented this path");
    env = {
      ...pathEnv,
      ...builderEnv,
      ...fsEnv,
      ...trustEnv,
    };
    key = apiKey;
  }
  // The MCP servers reach the CLI over its stdin (`setMcpServers`, see
  // claude.ts), never as `--mcp-config` argv: their header values are
  // registered with the spawner, which refuses any argument or environment
  // value that carries one.
  const mcpHeaderValues = mcpHeaderValuesOf(mcpServers);

  // Whether the operator pinned a Claude permission mode in agent.json. When
  // set we forward it verbatim and let the SDK's mode govern the posture; when
  // unset we ALWAYS install a `canUseTool` below (guuey#234) so no tool pick can
  // ever reach the SDK's interactive ask stage — a never-answered prompt would
  // hang this headless pod.
  const explicitMode = snapshot.claude?.permissions?.mode;

  // guuey#1183 — a BOUND first impression is a forced handshake call (the
  // Router's model-egress arm sets `tool_choice: { type: "tool" }` on the
  // turn's first request, guuey#1237), and the Anthropic API refuses a forced
  // `tool_choice` beside extended thinking. The SDK's default for Sonnet 5 /
  // Opus 4.6+ is ADAPTIVE thinking, so without this knob every first-impression
  // turn reached the arm with `thinking` on and the force was skipped
  // (`FIRST_IMPRESSION_SKIPPED { reason: 'thinking' }` on every guest turn of
  // QA's dev read, 5755395744) — the WOW turn was back to model discretion.
  // Thinking is disabled for THIS invoke only (the handshake's arguments are
  // verbatim from the prompt; the render step follows in the same turn) —
  // and for the whole invoke, not the first request alone: toggling thinking
  // back on mid-turn 400s ("a final assistant message must start with a
  // thinking block") on the tool-result continuation, which the arm's
  // retry-once cannot rescue. Same gate as the prompt section: the ggui rail
  // armed AND a push present. Later turns on the thread keep the default.
  //
  // guuey#1606 — EXCEPT on a model the provider refuses `disabled` for
  // (Fable 5.1, Fable 5, Opus 5.5, Sonnet 5.5 — `rejectsDisabledThinking`). There the whole bound turn
  // would 400 on every request, and the arm's retry cannot rescue it (the
  // retry drops only the force). Those models also refuse the forced
  // `tool_choice` itself, so disabling thinking would buy nothing: the turn
  // keeps the model's default (adaptive) thinking, the arm skips the force
  // (`reason: 'thinking'`), and the prompt instruction stands — exactly the
  // path those models serve on before this knob existed.
  const firstImpressionBound = ctx.gguiAttached === true && ctx.firstImpression !== undefined;
  //
  // guuey#2231 — the platform can also turn thinking off for a whole run
  // through the snapshot (`thinking: { type: "disabled" }`; today the hook
  // door's small-tier run, Haiku 5.5). The same refusing-model guard applies:
  // on a model that refuses `disabled` the directive is dropped and the run
  // keeps the model's own thinking, never a 400 on every request.
  const thinkingOff = firstImpressionBound || snapshot.thinking?.type === "disabled";
  const disableThinking = thinkingOff && !rejectsDisabledThinking(model);

  const executable = claudeCodeExecutableOf(process.env);
  const options: Options = {
    model,
    ...(disableThinking ? { thinking: { type: "disabled" as const } } : {}),
    allowedTools: gates.allowedTools,
    // Deny-listed tools (`tools.denylist`, translated) are removed from the
    // model's catalog outright — the SDK's own mechanism, not a callback.
    ...(gates.disallowedTools.length > 0 ? { disallowedTools: gates.disallowedTools } : {}),
    // Token streaming (guuey#91 consumer half): the SDK interleaves
    // `stream_event` partials, which `@silverprotocol/claude-agent-sdk` ≥0.4
    // maps to token-granular text/reasoning/tool.args deltas and dedupes
    // against the complete assistant message that follows. The Router passes
    // stream_event through its structural SDKMessage guard untouched, and the
    // render meter never reads partials (it bills user-message tool-results,
    // idempotent by tool_use id), so this flag's only observable effect is
    // incremental frames on the SSE wire.
    includePartialMessages: true,
    // With GuueyFS layers REALLY bound (`fsBound`, guuey#234 — never `fs`
    // presence, which is unconditional on the wire), expose the file tools PLUS
    // real `Bash`; otherwise purely MCP-driven. `Bash` is safe here because the
    // host already runs inside the Router's bubblewrap jail — that bwrap, NOT
    // the SDK's own `sandbox:{}` block, is the isolation.
    tools: gates.tools,
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
    // The Claude Code binary the platform resolved in its own image, when it
    // names one (`GUUEY_CLAUDE_CODE_EXECUTABLE`); otherwise the SDK's own lookup.
    ...(executable !== undefined ? { pathToClaudeCodeExecutable: executable } : {}),
    spawnClaudeCodeProcess: makeClaudeSpawner({
      key,
      secrets: mcpHeaderValues,
      ...(ctx.lateSecrets !== undefined ? { lateSecrets: ctx.lateSecrets } : {}),
    }),
    systemPrompt,
    // GuueyFS binding (opt-in): session dir as cwd, home+app as extra roots.
    ...(fs ? { cwd: fs.session, additionalDirectories: [fs.home, fs.app] } : {}),
    // Permission posture. Two mutually-exclusive paths:
    //
    //  - Operator pinned `claude.permissions.mode` → forward it verbatim; the
    //    operator owns the posture (e.g. `acceptEdits`).
    //  - No explicit mode → ALWAYS install a `canUseTool` (guuey#234: it used
    //    to be installed only when fs was "bound", which was every turn — once
    //    the gate is real, an fs-off pod with an explicit allowlist would sit
    //    in `default` mode). In the SDK permission flow (hooks → deny → allow →
    //    ask → mode/canUseTool), `default` mode with no callback routes any
    //    tool not covered by an allow rule through an interactive permission
    //    prompt — which, in this headless ephemeral pod, no one answers, so
    //    the agent would HANG. The callback short-circuits that stage: with no
    //    explicit allowlist every pick is allowed (the tool surface is already
    //    capped by `tools`/`allowedTools` + `settingSources:[]` +
    //    `strictMcpConfig`, and the Router's bubblewrap jail is the real
    //    isolation boundary — NOT the SDK's own `sandbox:{}` block, which is
    //    intentionally absent to avoid a nested bwrap); with an explicit
    //    allowlist an UNLISTED pick is DENIED with a message the model can read
    //    — that is what makes the allowlist a real narrowing, and it can never
    //    hang. The callback is `@guuey/config`'s own check (`claudeToolRules`,
    //    the one the code-mode scaffold installs too), so a denial names the
    //    actual cause: the allowlist, a denylist "*", or an unreadable
    //    denylist entry (a stored "*.*" is one). We do NOT use
    //    `bypassPermissions`: it requires
    //    `allowDangerouslySkipPermissions` and globally disables hooks/deny-rule
    //    evaluation, whereas the callback keeps those stages intact while only
    //    collapsing the final ask stage.
    ...(explicitMode
      ? { permissionMode: explicitMode }
      : { canUseTool: gates.canUseTool }),
    ...(ctx.abortController ? { abortController: ctx.abortController } : {}),
  };

  return options;
}

/** Every header value of `servers`: the secrets the CLI's spawner must keep out of its arguments, environment and stderr. */
export function mcpHeaderValuesOf(servers: Record<string, SdkMcpServer>): string[] {
  return Object.values(servers).flatMap((server) =>
    "headers" in server && server.headers !== undefined ? Object.values(server.headers) : [],
  );
}

/**
 * Map the Router-resolved cred files to the framework-neutral SdkMcpServer map.
 * The Router (credential-broker) owns ALL resolution — default, federation, mint,
 * env-substitution; this worker just reads the broker's entries (via
 * ctx.listCredentials, `@guuey/worker`'s two sources) and shapes each entry.
 * Keyed by the server name.
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
 * The resolved tool surface for one invoke — what `buildOptions` hands the SDK.
 * Exported for the invariant tests ("an explicit allowlist can never hang").
 */
export interface ResolvedToolGates {
  /** The built-in catalog: `BUILTIN_TOOLS` when fs is bound, else `[]`. */
  tools: string[];
  /** SDK allow rules — MCP names in the SDK's `mcp__<server>[__<tool>]` spelling plus the built-ins in `tools`. */
  allowedTools: string[];
  /** SDK `disallowedTools` — the translated `tools.denylist` (removed from the catalog). */
  disallowedTools: string[];
  /** Whether the snapshot carried a non-empty `tools.allowlist`, `["@none"]` included (→ deny-unlisted posture). */
  explicitAllowlist: boolean;
  /** `allowedTools` as a set. */
  allowedSet: ReadonlySet<string>;
  /**
   * The ask-stage permission check, installed when no
   * `claude.permissions.mode` is pinned: `@guuey/config`'s
   * `claudeToolRules(...).canUseTool`. With no explicit allowlist it allows
   * every pick (the surface is already capped by `tools` / `allowedTools` /
   * `disallowedTools`, `settingSources: []` and `strictMcpConfig`; the
   * Router's bubblewrap jail is the isolation). Otherwise it DENIES every
   * pick outside `allowedSet` with a message naming the cause, never an ask
   * (guuey#234: an explicit allowlist can never hang the pod).
   */
  canUseTool: CanUseTool;
}

/**
 * Resolve the invoke's tool surface (guuey#234). Pure. The translation from
 * the config grammar into the SDK's rules is `@guuey/config`'s
 * `claudeToolRules` (the one implementation the code-mode scaffold shares;
 * its doc carries the contract); this host adds only its built-in catalog,
 * keyed ONLY on `fsBound` — the real "GuueyFS layers are bound this turn"
 * signal from the runtime. When fs is bound the built-ins join the allow
 * rules, so the platform's memory feature is never silently switched off by a
 * builder's MCP-only allowlist; a builder who wants them gone deny-lists them
 * (`"Bash"`).
 */
export function resolveToolGates(
  snapshot: GuueyAgent,
  declaredServerNames: readonly string[],
  fsBound: boolean,
  withheld?: readonly WithheldTool[],
): ResolvedToolGates {
  const builtins = fsBound ? [...BUILTIN_TOOLS] : [];
  const rules = claudeToolRules(snapshot.tools, declaredServerNames, { builtins, withheld });
  return {
    tools: builtins,
    allowedTools: rules.allowedTools,
    disallowedTools: rules.disallowedTools,
    explicitAllowlist: rules.explicitAllowlist,
    allowedSet: rules.allowedSet,
    canUseTool: rules.canUseTool,
  };
}
