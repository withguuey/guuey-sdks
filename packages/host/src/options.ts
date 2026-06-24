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
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Fs, HistoryMessage, JsonValue } from "@guuey/worker";
import {
  DEFAULT_AGENT_MCP_SERVERS,
  GUUEY_DEFAULT_SYSTEM_PROMPT,
  type GuueyAgent,
  type GuueyAgentMcpServer,
} from "@guuey/config";

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
 * File tools enabled when GuueyFS layers are bound. NO `Bash` — real shell exec
 * is governed by the Router-side bubblewrap sandbox, not enabled in-process here.
 */
const FS_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];

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

  const options: Options = {
    model,
    mcpServers,
    allowedTools,
    // With GuueyFS layers bound, expose the file tools; without them this is
    // byte-identical to the source (purely MCP-driven). No `Bash` in-process —
    // real shell exec is governed by the Router-side bubblewrap sandbox.
    tools: fs ? [...FS_TOOLS] : [],
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
    ...(snapshot.claude?.permissions?.mode
      ? { permissionMode: snapshot.claude.permissions.mode }
      : {}),
    ...(ctx.abortController ? { abortController: ctx.abortController } : {}),
  };

  return options;
}

/**
 * Build the per-invoke MCP server map. Three arms (F1 binding amendment):
 *
 * - **colocated** → `{ type:'stdio', command, args }` (unchanged).
 * - **external (non-federated)** → `{ type: transport ?? 'http', url, headers }`
 *   with `${env.NAME}` header substitution (unchanged).
 * - **federated external** (`federate: true`) → read
 *   `<sessionDir>/.guuey/credentials/<server>.json` and use its `url` + `headers`.
 *   Absent file (federation unconfigured) → the server is SKIPPED this turn.
 *
 * `hosted`/`proxied` throw (runtime support lands in later slices).
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
 * federated server has no credential file this turn (skip it — no federated MCP).
 */
function toSdkMcpServer(
  name: string,
  entry: GuueyAgentMcpServer,
  ctx: BuildOptionsContext,
): SdkMcpServer | undefined {
  switch (entry.kind) {
    case "colocated": {
      return {
        type: "stdio",
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
      };
    }
    case "external": {
      if (entry.federate === true) {
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
 * When GuueyFS layers are bound, the file tools join the allowlist (so the model
 * may use them alongside the MCP allowlist).
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
  return fsBound ? [...base, ...FS_TOOLS] : base;
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
