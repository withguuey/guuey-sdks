/**
 * Snapshot → Claude Agent SDK `Options` construction. Lifted from
 * `backend/services/nocode-runtime/src/agent-runner.ts` (the pure-logic half),
 * with the F1 binding amendment: `@guuey/host` runs inside bubblewrap and must
 * NOT mint federation tokens (no IRSA in the sandbox). Instead, a federated MCP
 * server reads its credentials from a well-known path the Router-side credential
 * broker (Task 2.5) wrote — `<sessionDir>/.guuey/credentials/<server>.json`.
 *
 * Two responsibilities:
 *
 * 1. **Snapshot → SDK options mapping.** Translates the agent.json shape
 *    (transport / url / headers, default MCP server, framework-scoped knobs)
 *    into the Claude Agent SDK's `mcpServers` + `allowedTools` + `maxTurns`.
 * 2. **Env-var substitution.** Header values written as `${env.NAME}` resolve
 *    against the supplied env at call time. Keeps secrets out of the deploy
 *    snapshot — operators set them via `guuey env set NAME=...`.
 *
 * OSS-legality: this package imports ONLY `@anthropic-ai/claude-agent-sdk`,
 * `@guuey/worker`, `@guuey/config`, and Node built-ins. The federation mint
 * client and `FederationConfig` are NOT imported (they moved to the Router-side
 * credential broker). The `@silverprotocol/core`/`@guuey/fs` types the source
 * used become host-owned, dependency-free shapes here.
 */
import type { CanUseTool, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Fs, HistoryMessage, JsonValue } from "@guuey/worker";
import {
  DEFAULT_AGENT_MCP_SERVERS,
  GUUEY_DEFAULT_SYSTEM_PROMPT,
  type GuueyAgent,
  type GuueyAgentMcpServer,
} from "@guuey/config";

export type { SDKMessage };

/**
 * Recognizes the ggui generative-UI MCP server by HOST. A lifted, dependency-
 * free copy of the backend `ggui-host.ts` predicate (NOT imported — keeps this
 * package OSS-legal; `@guuey/host` pulls in no `backend/*` code). It MUST stay
 * structurally identical to the broker's so producer + consumer agree on which
 * servers are federated.
 *
 * Matches the canonical prod host `mcp.ggui.ai` AND the per-environment sandbox
 * hosts `<env>.mcp.sandbox.ggui.ai` (dev / staging). A federated ggui server is
 * detected by host so the platform-DEFAULT ggui (declared without `federate`)
 * still reads its Router-minted credential.
 */
function isGguiHost(host: string): boolean {
  return host === "mcp.ggui.ai" || host.endsWith(".mcp.sandbox.ggui.ai");
}

/** {@link isGguiHost} for a full URL; false on a malformed URL. */
function isGguiUrl(url: string): boolean {
  try {
    return isGguiHost(new URL(url).host);
  } catch {
    return false;
  }
}

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
 * The well-known credential file a federated MCP server reads. Written per
 * invoke by the Router-side credential broker (Task 2.5) at
 * `<sessionDir>/.guuey/credentials/<server>.json`. Contract from spec §7.1.
 */
export interface CredentialFile {
  /** The per-app MCP URL the minted token is scoped to (`<host>/apps/<id>`). */
  url: string;
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
  /** Env map for `${env.NAME}` header substitution (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /**
   * Reads `<sessionDir>/.guuey/credentials/<server>.json` for a federated MCP
   * server, or `undefined` when the file is absent (federation unconfigured).
   * Injected so the option-building stays pure (no disk in `buildOptions`).
   */
  readCredential: (server: string) => CredentialFile | undefined;
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

  const mcpServers = buildMcpServers(snapshot, ctx);
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
 * Build the per-invoke MCP server map. Arms (F1 binding amendment):
 *
 * - **external (non-federated)** → `{ type: transport ?? 'http', url, headers }`
 *   with `${env.NAME}` header substitution (unchanged).
 * - **federated external** (`isGguiUrl(url)` — incl. the platform-default ggui —
 *   OR `federate: true`) → read `<sessionDir>/.guuey/credentials/<server>.json`
 *   and use its `url` + `headers`. Absent file (federation unconfigured) → the
 *   server is SKIPPED this turn.
 *
 * `colocated`/`hosted`/`proxied` throw — runtime support is out of scope for the
 * universal host (see {@link toSdkMcpServer} for the F9 colocated rationale).
 */
function buildMcpServers(
  snapshot: GuueyAgent,
  ctx: BuildOptionsContext,
): Record<string, SdkMcpServer> {
  const source = snapshot.mcpServers ?? DEFAULT_AGENT_MCP_SERVERS;
  const out: Record<string, SdkMcpServer> = {};
  for (const [name, entry] of Object.entries(source)) {
    const mapped = toSdkMcpServer(name, entry, ctx);
    if (mapped !== undefined) out[name] = mapped;
  }
  return out;
}

/**
 * Map one agent.json `mcpServers` entry to the SDK shape, or `undefined` when a
 * federated server (ggui-by-URL or `federate:true`) has no credential file this
 * turn (skip it — no federated MCP).
 */
function toSdkMcpServer(
  name: string,
  entry: GuueyAgentMcpServer,
  ctx: BuildOptionsContext,
): SdkMcpServer | undefined {
  switch (entry.kind) {
    case "colocated": {
      // F9 — colocated/stdio MCP is REJECTED on the universal-host path. The host
      // runs inside the Router's bubblewrap jail; the Claude SDK would spawn this
      // `command` INSIDE that jail, but a no-code (config-only) snapshot ships no
      // filesystem bundle — a working stdio MCP needs bundled binaries, which is
      // inherently CODE-MODE (a `/worker` dir / custom Dockerfile that binds its
      // own paths), not the universal host. The jail binds only the rootfs +
      // session layers, never builder binaries the Router has no manifest of, so
      // there is nothing safe to bind here. Reject loudly (a silent stdio spawn
      // would fail opaquely with ENOENT inside bwrap) — colocated MCP is a
      // code-mode/follow concern (recorded in the slice spec Non-Goals).
      throw new Error(
        `mcpServers["${name}"]: colocated (stdio) MCP is not supported on the universal ` +
          `host path — it requires bundled binaries (code-mode /worker). Use a code-mode ` +
          `agent (a /worker dir) to ship a colocated stdio MCP server.`,
      );
    }
    case "external": {
      // A server is federated when its URL is a ggui host (auto-federate the
      // platform-DEFAULT ggui server + any env-specific ggui issuer, even with
      // no `federate:true`) OR an external server opts in via `federate:true`.
      // This is the IDENTICAL predicate the Router-side credential broker uses
      // to decide which servers to mint + write a credential for — keeping
      // producer + consumer in lockstep so the default agent's ggui keeps auth.
      if (isGguiUrl(entry.url) || entry.federate === true) {
        // F1: read the Router-written credential file instead of minting.
        const cred = ctx.readCredential(name);
        if (cred === undefined) return undefined; // federation unconfigured → skip.
        const transport = entry.transport ?? "http";
        return {
          type: transport,
          url: cred.url,
          ...(Object.keys(cred.headers).length > 0 ? { headers: cred.headers } : {}),
        };
      }
      const transport = entry.transport ?? "http";
      const headers = entry.headers ? resolveEnvVars(entry.headers, ctx.env) : undefined;
      return {
        type: transport,
        url: entry.url,
        ...(headers ? { headers } : {}),
      };
    }
    case "hosted": {
      throw new Error(`mcpServers["${name}"]: hosted MCP resolution lands in a later slice`);
    }
    case "proxied": {
      throw new Error(`mcpServers["${name}"]: proxied (Case C) runtime lands in v2`);
    }
  }
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
 * Substitute `${env.NAME}` placeholders in header values against `env`
 * (defaults to `process.env`). Anything else passes through unchanged. Missing
 * env vars resolve to an empty string — the upstream request fails with a
 * clearer 401/403 than a "blank header" mystery.
 */
function resolveEnvVars(
  headers: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = value.replace(/\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, varName: string) => {
      const v = env[varName];
      return v ?? "";
    });
  }
  return out;
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
