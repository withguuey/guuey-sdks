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
import type { Fs, HistoryMessage, JsonValue, ProfileSection } from "@guuey/worker";
import {
  GUUEY_DEFAULT_SYSTEM_PROMPT,
  defaultModelFor,
  parseToolGateEntry,
  type GuueyAgent,
  type ProfileAccess,
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
 * the tool exists. Delegates to the framework-neutral {@link renderMemorySection}
 * (`../preamble.js`) so Claude, OpenAI, and ADK all render the IDENTICAL section;
 * its RECALL block is byte-identical to the pre-factor inline string (pinned).
 */
function buildMemorySection(ctx: BuildOptionsContext): string {
  if (ctx.identity.authMode !== "authenticated" || !ctx.memoryAttached) return "";
  return renderMemorySection(ctx.userMemory);
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
function buildProfileSection(ctx: BuildOptionsContext): string {
  if (ctx.identity.authMode !== "authenticated" || ctx.profileAccess === undefined) return "";
  return renderProfileSection(ctx.profileSections, ctx.profileAccess);
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
  const fsBound = ctx.fsBound === true;
  const gates = resolveToolGates(snapshot, Object.keys(mcpServers), fsBound);
  const systemPrompt =
    withContextPreamble(
      snapshot.systemPrompt ?? GUUEY_DEFAULT_SYSTEM_PROMPT,
      ctx.history,
      ctx.priorMemory,
      ctx.priorState,
    ) +
    buildMemorySection(ctx) +
    // cross-app-profile T7: the profile section is a SIBLING of the memory
    // section, appended AFTER it (memory first, then profile). Both are
    // framework-blind renderers from ../preamble.js.
    buildProfileSection(ctx);
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
  const fsEnv: Record<string, string> = fs
    ? {
        HOME: fs.home,
        [ENV_HOME_DIR]: fs.home,
        [ENV_APP_DIR]: fs.app,
        CLAUDE_CONFIG_DIR: fs.session,
        XDG_CACHE_HOME: fs.session,
      }
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
  // unset we ALWAYS install a `canUseTool` below (guuey#234) so no tool pick can
  // ever reach the SDK's interactive ask stage — a never-answered prompt would
  // hang this headless pod.
  const explicitMode = snapshot.claude?.permissions?.mode;

  const options: Options = {
    model,
    mcpServers,
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
    //    hang. We do NOT use `bypassPermissions`: it requires
    //    `allowDangerouslySkipPermissions` and globally disables hooks/deny-rule
    //    evaluation, whereas the callback keeps those stages intact while only
    //    collapsing the final ask stage.
    ...(explicitMode
      ? { permissionMode: explicitMode }
      : { canUseTool: gates.explicitAllowlist ? denyUnlistedTool(gates.allowedSet) : autoAllowTool }),
    ...(ctx.abortController ? { abortController: ctx.abortController } : {}),
  };

  return options;
}

/**
 * Auto-allow permission callback. Installed when the operator did NOT pin
 * `claude.permissions.mode` and the snapshot has NO explicit `tools.allowlist`,
 * so the default no-code agent's MCP tools (and, on a GuueyFS-armed pod, its
 * `Bash` + file tools) run prompt-free. Returns `{ behavior: 'allow' }` for
 * every request, passing the input through unchanged.
 *
 * Safe because the model's tool surface is already locked down BEFORE the
 * callback ever fires — `tools`/`allowedTools`/`disallowedTools` cap which
 * tools exist, `settingSources:[]` blocks filesystem-loaded settings,
 * `strictMcpConfig` pins the MCP catalog — and the real OS isolation is the
 * Router's bubblewrap jail this whole process runs inside. The callback only
 * collapses the SDK's final interactive "ask" stage (which would otherwise
 * hang a headless pod); the earlier hook/deny-rule stages still run.
 */
export const autoAllowTool: CanUseTool = (_toolName, input) =>
  Promise.resolve({ behavior: "allow", updatedInput: input });

/**
 * Deny-unlisted permission callback (guuey#234). Installed instead of
 * {@link autoAllowTool} when the snapshot carries an explicit `tools.allowlist`
 * (and no pinned mode). Tools that ARE listed never reach any callback — they
 * are SDK allow rules (`allowedTools`) and are auto-allowed upstream. So every
 * tool that DOES arrive here is, by construction, one the builder did not
 * list: it is denied with a message the model can act on. Never `null`, never
 * an ask — the invariant "an explicit allowlist can never hang the pod".
 *
 * `allowedSet` is consulted anyway (belt-and-braces against an SDK that
 * routes an allow-listed name here after all): a listed name is allowed.
 */
export function denyUnlistedTool(allowedSet: ReadonlySet<string>): CanUseTool {
  return (toolName, input) =>
    Promise.resolve(
      allowedSet.has(toolName)
        ? { behavior: "allow", updatedInput: input }
        : {
            behavior: "deny",
            message: `Tool "${toolName}" is not in this agent's tools.allowlist. Allowed: ${[...allowedSet].join(", ") || "(none)"}.`,
          },
    );
}

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
  /** Whether the snapshot carried a non-empty `tools.allowlist` (→ deny-unlisted posture). */
  explicitAllowlist: boolean;
  /** `allowedTools` as a set, for the deny-unlisted callback. */
  allowedSet: ReadonlySet<string>;
}

/**
 * Translate one parsed tool-gate entry (the `@guuey/config` grammar) into the
 * SDK's tool-name spelling(s). MCP tools are auto-namespaced by the SDK as
 * `mcp__<server>__<tool>`, and `mcp__<server>` is the SDK's own "every tool of
 * that server" rule. A bare name fans out to EVERY declared server (we cannot
 * enumerate a server's tools ahead of connecting) and, when it names one of the
 * host's built-ins, to that built-in — but only while fs is bound, since an
 * unbound turn has no built-in catalog for it to match.
 */
function toSdkToolNames(
  raw: string,
  declaredServerNames: readonly string[],
  fsBound: boolean,
): string[] {
  const parsed = parseToolGateEntry(raw);
  // Deploy-time validation (`validateToolGates`) rejects malformed entries
  // before a snapshot ever ships; a stale snapshot that slips one through is
  // dropped here (NOT passed verbatim — an unknown allow rule is inert, and an
  // unknown name reaching the ask stage is the hang this fix exists to close).
  if ("error" in parsed) return [];
  switch (parsed.kind) {
    case "server-tool":
      return [`mcp__${parsed.server}__${parsed.tool}`];
    case "server-all":
      return [`mcp__${parsed.server}`];
    case "bare":
      return [
        ...declaredServerNames.map((s) => `mcp__${s}__${parsed.tool}`),
        ...(fsBound && BUILTIN_TOOLS.includes(parsed.tool) ? [parsed.tool] : []),
      ];
  }
}

/**
 * Resolve the invoke's tool surface (guuey#234). Pure.
 *
 * - `tools` (the built-in catalog) is keyed ONLY on `fsBound` — the real
 *   "GuueyFS layers are bound this turn" signal from the runtime.
 * - `allowedTools`: an explicit `tools.allowlist` is TRANSLATED from the config
 *   grammar (`<server>.<tool>` / `<server>.*` / bare) into SDK names — never
 *   passed verbatim; absent → every tool of every declared server
 *   (`mcp__<server>`). When fs is bound the built-ins join as allow rules so
 *   the platform's memory feature (file tools + `Bash` in the jail) is never
 *   silently switched off by a builder's MCP-only allowlist; a builder who
 *   wants them gone deny-lists them (`"Bash"`).
 * - `disallowedTools`: the translated `tools.denylist` — the SDK removes those
 *   from the model's catalog outright.
 */
export function resolveToolGates(
  snapshot: GuueyAgent,
  declaredServerNames: readonly string[],
  fsBound: boolean,
): ResolvedToolGates {
  const explicit = snapshot.tools?.allowlist ?? [];
  const explicitAllowlist = explicit.length > 0;
  const builtins = fsBound ? [...BUILTIN_TOOLS] : [];
  const mcpAllowed = explicitAllowlist
    ? explicit.flatMap((e) => toSdkToolNames(e, declaredServerNames, fsBound))
    : declaredServerNames.map((s) => `mcp__${s}`);
  const allowedTools = dedupe([...mcpAllowed, ...builtins]);
  const disallowedTools = dedupe(
    (snapshot.tools?.denylist ?? []).flatMap((e) => toSdkToolNames(e, declaredServerNames, fsBound)),
  );
  return {
    tools: builtins,
    allowedTools,
    disallowedTools,
    explicitAllowlist,
    allowedSet: new Set(allowedTools),
  };
}

function dedupe(names: string[]): string[] {
  return [...new Set(names)];
}

// withContextPreamble now lives in ../preamble.js (framework-neutral — the
// ADK runner renders the same preamble); re-exported for existing importers.
// `renderMemorySection` (the memory SAVE + RECALL block, memory-mcp T5) lives
// there too — framework-blind, so openai/adk render the identical section.
export { withContextPreamble } from "../preamble.js";
import { renderMemorySection, renderProfileSection, withContextPreamble } from "../preamble.js";
