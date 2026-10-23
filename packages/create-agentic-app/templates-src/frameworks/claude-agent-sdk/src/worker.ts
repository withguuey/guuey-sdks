/**
 * agentic-app-template's code-mode worker entry (Claude Agent SDK). Reads the
 * resolved agent snapshot + MCP endpoints via `./agent-config.js`, drives one
 * `query()` per invoke, and streams every native SDK message to the Router
 * via `emit.native` (the field spellings below — `mcpServers`/`systemPrompt`/
 * `allowedTools`/`disallowedTools`/`canUseTool`/`maxTurns`, and the
 * `type === "result" && subtype ===
 * "success"` result-detection — mirror `@guuey/host`'s `buildOptions` /
 * `runInvoke`, the platform's own consumer of this exact snapshot shape).
 */
import { createRequire } from "node:module";
import { query, type McpServerConfig, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_FORBIDDEN_ENV,
  makeClaudeSpawner,
  readLaunchEnvelope,
  serveNative,
  type ClaudeKeyKind,
} from "@guuey/worker";
import { claudeToolRules } from "@guuey/config";
import { loadAgent, systemPrompt, mcpEndpoints, withHistory } from "./agent-config.js";

/**
 * The model credential (guuey#2139). A platform launch delivers it privately
 * on a descriptor (`readLaunchEnvelope`, read once, here, before anything is
 * spawned); otherwise it comes from this process's environment, as before.
 * Either way the Claude CLI receives it only on its own private descriptor
 * (`makeClaudeSpawner`), never in its environment or argv, so the CLI's Bash
 * and tool children never inherit it. A local run with only a Claude OAuth
 * token (`CLAUDE_CODE_OAUTH_TOKEN`, no API key) hands that token over the same
 * way, on the CLI's OAuth descriptor input.
 */
const envelope = await readLaunchEnvelope();
const modelKey =
  envelope?.model?.token ?? (process.env.ANTHROPIC_AUTH_TOKEN || undefined) ?? (process.env.ANTHROPIC_API_KEY || undefined);
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined;
const credential: { key: string; keyKind: ClaudeKeyKind } | undefined =
  modelKey !== undefined
    ? { key: modelKey, keyKind: "api-key" }
    : oauthToken !== undefined
      ? { key: oauthToken, keyKind: "oauth-token" }
      : undefined;

/** This process's environment minus every credential, auth-path and inspector variable. */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CLAUDE_FORBIDDEN_ENV.includes(name)) env[name] = value;
  }
  return env;
}

/** How long the MCP servers may stay `pending` before the turn goes on without them. */
const MCP_READY_DEADLINE_MS = 15_000;
/**
 * How long the CLI may take to answer a control request (`setMcpServers`,
 * `mcpServerStatus`). A CLI that never answers fails the turn instead of
 * hanging it. Same value as `@guuey/host`'s `CLAUDE_STARTUP_DEADLINE_MS`: the
 * pinned CLI connects the servers before it answers `setMcpServers` and gives
 * a hung server up to 30 s, so this outlasts that wait.
 */
const CLAUDE_STARTUP_DEADLINE_MS = 60_000;

/** Resolve with `work`, or reject naming `what` once the startup deadline passes first. */
function withStartupDeadline<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Claude CLI startup failed: no answer to ${what} within ${String(CLAUDE_STARTUP_DEADLINE_MS)} ms`)),
      CLAUDE_STARTUP_DEADLINE_MS,
    );
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/**
 * This worker is tsup-bundled (`noExternal`), which breaks the SDK's own
 * native-CLI lookup: the SDK resolves `claude-agent-sdk-<platform>-<arch>`
 * relative to its OWN module location, and once inlined into
 * `guuey.worker.js` that location is the bundle's — where no node_modules
 * has the binary. Resolution order here:
 *   1. `GUUEY_CLAUDE_CODE_EXECUTABLE` — set by the guuey pod Router, pointing
 *      at the platform image's binary (a deployed `/worker` has no
 *      node_modules at all).
 *   2. Anchored resolve — find the *installed* SDK from the bundle's location
 *      (it is this app's direct dependency), then resolve the platform binary
 *      package from the SDK's real location, exactly as the unbundled SDK
 *      would. Covers local `guuey dev --serve`, where the bundle runs next to
 *      the app's node_modules.
 *   3. undefined — let the SDK try (and fail with its actionable error).
 */
function claudeExecutable(): string | undefined {
  if (process.env.GUUEY_CLAUDE_CODE_EXECUTABLE) return process.env.GUUEY_CLAUDE_CODE_EXECUTABLE;
  try {
    const sdkEntry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    return createRequire(sdkEntry).resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
    );
  } catch {
    return undefined;
  }
}
const pathToClaudeCodeExecutable = claudeExecutable();

await serveNative(
  async (invoke, emit) => {
    const agent = loadAgent(invoke);
    const endpoints = mcpEndpoints(invoke, agent);
    const mcpServers: Record<string, McpServerConfig> = Object.fromEntries(
      Object.entries(endpoints).map(([name, ep]) => [
        name,
        // `alwaysLoad` — this agent's declared MCP servers ARE its tool
        // surface; without it the CLI defers MCP tools behind its ToolSearch
        // built-in (absent here — see `tools: []` below), leaving the model
        // tool-less.
        { type: ep.transport, url: ep.url, headers: ep.headers, alwaysLoad: true },
      ])
    );
    // guuey#2139: the servers (and their header values) reach the CLI over its
    // stdin with `setMcpServers`, never as `--mcp-config` on its argv; the
    // spawner refuses any argument or environment value that carries one.
    const headerValues = Object.values(endpoints).flatMap((ep) => Object.values(ep.headers));
    // The agent's tool gates (`tools.allowlist` / `tools.denylist` in
    // guuey.json, as narrowed by the turn's mode) and this turn's withholds
    // (`invoke.withheldTools`), in the SDK's own rule spelling
    // (`mcp__<server>[__<tool>]`). `builtins: []` matches `tools: []` below.
    const toolRules = claudeToolRules(agent.tools, Object.keys(mcpServers), {
      builtins: [],
      withheld: invoke.withheldTools,
    });
    // A denylist entry that cannot be read makes the rules keep no MCP tool
    // this turn (they fail closed); name it so it can be fixed.
    for (const error of toolRules.errors) console.error(`[guuey] ${error}`);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let endInput!: () => void;
    const inputDone = new Promise<void>((resolve) => (endInput = resolve));
    // The one user message goes out only once the MCP gate below decided; a
    // failed startup opens the gate with `send` still false, so none is sent.
    let send = false;
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      await gate;
      if (!send) return;
      yield { type: "user", message: { role: "user", content: withHistory(invoke) }, parent_tool_use_id: null };
      await inputDone;
    }
    const q = query({
      prompt: prompt(),
      options: {
        ...(agent.model ? { model: agent.model } : {}),
        ...(systemPrompt(invoke, agent) ? { systemPrompt: systemPrompt(invoke, agent) } : {}),
        // Same posture as `@guuey/host`'s `buildOptions` (options.ts):
        // - allowedTools: the allowlist translated into SDK rules, else every
        //   tool of every server (`mcp__<server>`); an allow rule only
        //   pre-approves.
        // - disallowedTools: the denylist and this turn's withholds, removed
        //   from the model's catalog outright (deny wins).
        // - canUseTool: under an explicit allowlist an unlisted pick is
        //   DENIED with a message the model can read; otherwise every pick is
        //   allowed. Either way the SDK's interactive ask stage, which
        //   nothing answers headless, is never reached.
        // - tools: [] — purely MCP-driven; no Bash/file/search built-ins.
        // - settingSources: [] — never load the machine's ~/.claude or
        //   project settings into this worker (a dev box's logged-in Claude
        //   Code MCPs/plugins would leak into the tool catalog).
        // - strictMcpConfig: true — the snapshot's servers only; ignore
        //   .mcp.json / user settings / plugins.
        allowedTools: toolRules.allowedTools,
        ...(toolRules.disallowedTools.length > 0 ? { disallowedTools: toolRules.disallowedTools } : {}),
        canUseTool: toolRules.canUseTool,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        // - persistSession: false — the worker never resumes a CLI session
        //   (each turn's thread arrives in `invoke.history`), and a persisted
        //   transcript lands under $HOME/.claude/projects/. Hosted, $HOME is
        //   the end user's DURABLE home, so the default would keep every
        //   turn's text there across sessions and pods.
        persistSession: false,
        env: cliEnv(),
        ...(credential !== undefined
          ? { spawnClaudeCodeProcess: makeClaudeSpawner({ ...credential, secrets: headerValues }) }
          : {}),
        ...(agent.runtime?.maxTurns ? { maxTurns: agent.runtime.maxTurns } : {}),
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      },
    });
    let result = "";
    const messages = (async () => {
      for await (const message of q) {
        emit.native(JSON.parse(JSON.stringify(message)));
        if (message.type === "result") {
          if (message.subtype === "success") result = message.result;
          endInput();
        }
      }
    })();
    try {
      await withStartupDeadline(q.setMcpServers(mcpServers), "setMcpServers");
      const readyBy = Date.now() + MCP_READY_DEADLINE_MS;
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
      throw err;
    }
    send = true;
    openGate();
    await messages;
    endInput();
    return result;
  },
  { framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk" }
);
