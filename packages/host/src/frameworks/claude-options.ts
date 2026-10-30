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
import type { CanUseTool, Options, SDKMessage, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { FirstImpressionPush, FirstImpressionShown, Fs, HistoryMessage, JsonValue, McpAvailability, ProfileSection, WithheldTool } from "@guuey/worker";
import { forbiddenClaudeEnvNames, makeClaudeSpawner, trustEnvOf } from "@guuey/worker";
import {
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
/**
 * File tools enabled when GuueyFS layers are bound
 * ({@link BuildOptionsContext.fsBound}). `Bash` is added separately (see
 * {@link BASH_TOOL}) so the two are independently testable.
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
 * The built-in tool catalog this host can expose — exactly the file tools plus
 * `Bash`, all keyed on {@link BuildOptionsContext.fsBound}. A bare tool-gate
 * entry (`"Bash"`, `"Write"`) matches one of these by name.
 */
const BUILTIN_TOOLS: readonly string[] = [...FS_TOOLS, BASH_TOOL];

/**
 * Belt-and-braces (spec §4): guuey's memory mechanism is prompted file memory
 * (a platform-owned system-prompt section, below), never the SDK's own
 * auto-memory. Set UNCONDITIONALLY on every `Options` this module builds so a
 * future SDK default flip can never start writing its own memory format into
 * the durable, quota-billed home layer without Guuey explicitly opting in.
 */
const AUTO_MEMORY_DISABLED: Settings = { autoMemoryEnabled: false };

/**
 * Build the platform-owned memory system-prompt section (memory-mcp spec §4):
 * the SAVE instruction plus, when {@link BuildOptionsContext.userMemory} is
 * present, a RECALL block rendering the Router-read `MEMORY.md` content. Gated
 * on `authMode === "authenticated"` AND {@link BuildOptionsContext.memoryAttached}
 * — the memory child booted this pod, so the `save_memory` tool is spliced. A
 * guest has no memory tool (the spec forbids offering it), and an unattached pod
 * has no tool to name. Returns `""` (append-safe) when out of scope.
 *
 * The SAVE gate is ATTACHMENT, not file presence — so a brand-new authenticated
 * user (no `MEMORY.md` yet) STILL gets the save instruction (save-only section)
 * and can bootstrap turn-one durable memory. The RECALL block is separately
 * gated on `userMemory` presence INSIDE {@link renderMemorySection}.
 *
 * Gate change (memory-mcp T5 review): was `ctx.fs` (a proxy for attachment).
 * `memoryAttached` is the REAL signal — it no longer over-renders in the
 * transient fs-on-but-child-unattached window, and no longer under-renders when
 * the tool exists. Delegates to the framework-neutral {@link renderMemorySectionForTurn}
 * (`../preamble.js`) so Claude, OpenAI, and ADK all render the IDENTICAL section;
 * its RECALL block is byte-identical to the pre-factor inline string (pinned).
 */
function buildMemorySection(ctx: BuildOptionsContext, noTools: boolean): string {
  if (ctx.identity.authMode !== "authenticated" || !ctx.memoryAttached) return "";
  // guuey#2262: with no tools declared, the RECALL block alone (no SAVE).
  return renderMemorySectionForTurn(ctx.userMemory, noTools);
}

/**
 * Build the platform-owned cross-app profile system-prompt section
 * (cross-app-profile spec §4) — the SIBLING of {@link buildMemorySection},
 * appended AFTER it. Gated on `authMode === "authenticated"` AND a resolved
 * {@link BuildOptionsContext.profileAccess} (the Router's fail-closed grant
 * check produced a live, clamped access level). A guest / an ungranted app never
 * reaches here. Delegates to the framework-neutral {@link renderProfileSection}
 * (`../preamble.js`) so Claude, OpenAI, and ADK render the IDENTICAL section; that
 * renderer owns the two inner gates (SAVE on `read-write`, RECALL on sections
 * presence). Returns `""` (append-safe) when out of scope.
 */
function buildProfileSection(ctx: BuildOptionsContext, noTools: boolean): string {
  if (ctx.identity.authMode !== "authenticated" || ctx.profileAccess === undefined) return "";
  // guuey#2262: with no tools declared the model cannot call `save_profile`,
  // so the section renders as for a read grant (RECALL only).
  return renderProfileSection(ctx.profileSections, noTools ? "read" : ctx.profileAccess);
}

/**
 * Build the app-resources system-prompt section (guuey#456 B4) — the hint
 * that builder-provided reference files exist at `<fs.app>/resources`. SIBLING
 * of {@link buildMemorySection}/{@link buildProfileSection}, appended AFTER
 * the profile section. Gated on {@link BuildOptionsContext.fsBound} — the
 * REAL "file tools are armed" signal (guuey#234), never `fs` presence — AND a
 * positive {@link BuildOptionsContext.resourceCount} (the Router only writes
 * it when > 0; re-checked here fail-closed). Deliberately NOT auth-gated: the
 * app layer is shared, public-by-definition content — guests read it too.
 * Delegates to the framework-neutral {@link renderResourcesSection}
 * (`../preamble.js`) so Claude, OpenAI, and ADK render the IDENTICAL section.
 * Returns `""` (append-safe) when out of scope.
 */
function buildFirstImpressionSection(ctx: BuildOptionsContext, noTools: boolean): string {
  // guuey#2262: the first impression asks for a `ggui_handshake` call, which a
  // turn that declares no tools cannot make.
  if (ctx.gguiAttached !== true || noTools) return "";
  return renderFirstImpressionSection(ctx.firstImpression);
}
function buildResourcesSection(ctx: BuildOptionsContext): string {
  const count = ctx.resourceCount;
  if (ctx.fsBound !== true || count === undefined || count <= 0 || ctx.fs === undefined) return "";
  return renderResourcesSection(count, ctx.fs.app);
}

import type { CredentialFile } from "@guuey/worker";

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
   * section ({@link buildProfileSection}): the `save_profile` SAVE instruction on
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
   * ({@link buildResourcesSection}) together with {@link fsBound}, so the hint
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
   * Returns every credential the Router broker wrote for this invoke (the
   * servers file, else `<sessionDir>/.guuey/credentials/`) — one `{name, cred}`
   * per usable MCP server. `name` is the server name; `cred` is the parsed
   * `CredentialFile`. Injected so option-building stays pure (no disk).
   */
  listCredentials: () => Array<{ name: string; cred: CredentialFile }>;
  /** Cancels the in-flight `query` when the client disconnects. */
  abortController?: AbortController;
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
 * environment because the platform runtime owns them, in the map's order.
 * Names only, never values.
 */
export function reservedEnvNamesDropped(snapshot: Pick<RunSnapshot, "env">): string[] {
  return withoutReservedEnvNames(snapshot.env).dropped;
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
  // guuey#2262: `tools.allowlist: ["@none"]` — no MCP tool this turn, so the
  // sections that tell the model about tools it cannot call are left out.
  const noTools = declaresNoTools(snapshot.tools);
  const systemPrompt =
    withContextPreamble(
      snapshot.systemPrompt ?? GUUEY_DEFAULT_SYSTEM_PROMPT,
      ctx.history,
      ctx.priorMemory,
      ctx.priorState,
    ) +
    buildMemorySection(ctx, noTools) +
    // cross-app-profile T7: the profile section is a SIBLING of the memory
    // section, appended AFTER it (memory first, then profile). Both are
    // framework-blind renderers from ../preamble.js.
    buildProfileSection(ctx, noTools) +
    // guuey#456 B4: the app-resources hint, appended AFTER the profile
    // section (memory → profile → resources) — same framework-blind renderer
    // family from ../preamble.js, gated on fsBound && resourceCount > 0.
    buildResourcesSection(ctx) +
    buildFirstImpressionSection(ctx, noTools) +
    // The welcome card the Router already drew (never beside a first-impression push).
    renderFirstImpressionShownSection(ctx.firstImpressionShown) +
    // guuey#901: the connected-services section — the pod's per-turn fact about
    // each OAuth server, placed with the tool-shaped sections and before the
    // surface/norms sections. Empty (byte-identical prompt) without OAuth servers.
    renderMcpAvailabilitySection(ctx.mcpAvailability) +
    // guuey#531: the surface-formatting section — default ON, suppressed
    // only by an explicit `agent.surfaceHints: false` (BYO plain-text
    // surfaces). Before the norms, which stay LAST.
    renderSurfaceSection(snapshot.surfaceHints) +
    // guuey#630: the generative-UI section — DIRECTLY AFTER the surface
    // section it qualifies ("use a table when comparing things" is right
    // for a text answer, wrong for a shaped one). Gated inside the
    // renderer on `gguiAttached` (the rail is really armed) AND the same
    // `surfaceHints: false` BYO opt-out. Before the norms, which stay LAST.
    // Left out when the tools block declares no tools (guuey#2262): the
    // model cannot draw a card.
    (noTools ? "" : renderGenerativeUiSection(ctx.gguiAttached, snapshot.surfaceHints)) +
    // guuey#556: the default response norms, LAST and unconditional —
    // every hosted agent inherits them (see RESPONSE_NORMS_SECTION's doc
    // for the confirm-gate carve-out + the per-court opt-out grammar).
    RESPONSE_NORMS_SECTION;
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
  // CLAUDE_CONFIG_DIR pins the CLI's own config/state root to the (ephemeral,
  // pod-local) session dir — spec §4 belt-and-braces, alongside the
  // unconditional `settings.autoMemoryEnabled:false` below — so CLI session
  // state never lands in the durable, quota-billed home layer.
  // XDG_CACHE_HOME likewise: the CLI's cache tree (~/.cache/claude-cli-nodejs,
  // MCP logs etc.) follows $HOME by XDG default, and $HOME resolves inside the
  // durable home mount — live-found on the first G5 gate run (2026-07-20)
  // leaking per-invoke log files into quota-billed storage.
  // HOME rides along (guuey#176): this env REPLACES the subprocess env
  // wholesale, and omitting HOME left the agent's shell with no `~` even
  // though bwrap set HOME=/home on the worker (live-found on the multi-pod
  // gate walk — GUUEY_HOME_DIR set, `~` expansion dead). Safe now that the
  // CLI's own state is pinned away from the durable layer via
  // CLAUDE_CONFIG_DIR + XDG_CACHE_HOME below (the G5 leak this env once
  // avoided by omission).
  //
  // The names the platform runtime owns (`RUNTIME_RESERVED_ENV_NAMES`,
  // `@guuey/config`) are then left out of the builder's env. A new document
  // that sets one is refused at deploy; a stored one keeps running without
  // them, and the caller reports each dropped name ({@link reservedEnvNamesDropped}).
  const refusedNames = forbiddenClaudeEnvNames(snapshot.env ?? {});
  if (refusedNames.length > 0) throw new ClaudeBuilderEnvError(refusedNames);
  const builderEnv = withoutReservedEnvNames(snapshot.env).env;
  const fsEnv: Record<string, string> = fs
    ? {
        HOME: fs.home,
        [ENV_HOME_DIR]: fs.home,
        [ENV_APP_DIR]: fs.app,
        CLAUDE_CONFIG_DIR: fs.session,
        XDG_CACHE_HOME: fs.session,
      }
    : {};
  // The trust variables the host process holds (`PLATFORM_TRUST_ENV_NAMES`):
  // this env replaces the CLI's environment, so without them the CLI trusts
  // public roots only (guuey#3114). After the builder's env, so a builder
  // value never replaces the platform's.
  const trustEnv = trustEnvOf(process.env);
  let env: Record<string, string>;
  let key: string;
  if (baseUrl !== undefined && authToken !== undefined) {
    env = {
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
  const mcpHeaderValues = Object.values(mcpServers).flatMap((server) =>
    "headers" in server && server.headers !== undefined ? Object.values(server.headers) : [],
  );

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
    spawnClaudeCodeProcess: makeClaudeSpawner({ key, secrets: mcpHeaderValues }),
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
  /** The built-in catalog: `[...FS_TOOLS, Bash]` when fs is bound, else `[]`. */
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

// withContextPreamble now lives in ../preamble.js (framework-neutral — the
// ADK runner renders the same preamble); re-exported for existing importers.
// `renderMemorySection` (the memory SAVE + RECALL block, memory-mcp T5) lives
// there too — framework-blind, so openai/adk render the identical section.
export { withContextPreamble } from "../preamble.js";
import {
  RESPONSE_NORMS_SECTION,
  renderSurfaceSection,
  renderGenerativeUiSection,
  renderMemorySectionForTurn,
  renderProfileSection,
  renderResourcesSection,
  renderFirstImpressionSection,
  renderFirstImpressionShownSection,
  withContextPreamble,
  renderMcpAvailabilitySection,
} from "../preamble.js";
