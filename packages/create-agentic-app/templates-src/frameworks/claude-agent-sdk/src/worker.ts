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
import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  MODEL_TEXT_INPUT_KIND_CAPABILITIES,
  TOOL_GATES_CAPABILITY,
  readLaunchEnvelope,
  runClaudeTurn,
  serveNative,
  type ClaudeKeyKind,
} from "@guuey/worker";
import { claudeToolRules } from "@guuey/config";
import { loadAgent, systemPrompt, mcpEndpoints } from "./agent-config.js";

/**
 * The model credential (guuey#2139). A platform launch delivers it privately
 * on a descriptor (`readLaunchEnvelope`, read once, here, before anything is
 * spawned); otherwise it comes from this process's environment, as before.
 * Either way the Claude CLI receives it only on its own private descriptor
 * (runClaudeTurn's `makeClaudeSpawner`), never in its environment or argv, so the CLI's Bash
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
    // spawner runClaudeTurn builds refuses any argument or environment value
    // that carries one.
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
    // One call runs the whole turn (@guuey/worker's runClaudeTurn): the hello and, when the platform keeps the
    // conversation's CLI session, its resume; the MCP servers over the CLI's stdin; every SDK message forwarded; the
    // result text returned. The options below are this app's posture; runClaudeTurn adds persistSession: false, and
    // only a platform session's own options win over them (its id, its config root, its pinned CLI).
    return runClaudeTurn({
      query,
      invoke,
      emit,
      systemPrompt: systemPrompt(invoke, agent),
      servers: mcpServers,
      options: {
        ...(agent.model ? { model: agent.model } : {}),
        // allowedTools: the allowlist translated into SDK rules, else every tool of every server (`mcp__<server>`);
        // an allow rule only pre-approves. disallowedTools: the denylist and this turn's withholds, removed from the
        // model's catalog outright (deny wins). canUseTool: under an explicit allowlist an unlisted pick is DENIED with
        // a message the model can read; otherwise every pick is allowed, so the SDK's interactive ask stage, which
        // nothing answers headless, is never reached. Same posture as `@guuey/host`'s `buildOptions` (options.ts).
        allowedTools: toolRules.allowedTools,
        ...(toolRules.disallowedTools.length > 0 ? { disallowedTools: toolRules.disallowedTools } : {}),
        canUseTool: toolRules.canUseTool,
        // tools: [] — purely MCP-driven; no Bash/file/search built-ins.
        tools: [],
        // settingSources: [] — never load the machine's ~/.claude or project settings into this worker (a dev box's
        // logged-in Claude Code MCPs/plugins would leak into the tool catalog). strictMcpConfig: true — the snapshot's
        // servers only; ignore .mcp.json / user settings / plugins.
        settingSources: [],
        strictMcpConfig: true,
        // includePartialMessages: true — token streaming: the Router forwards the deltas, deduped against the
        // complete message that follows. Same posture as `@guuey/host` (frameworks/claude-options.ts).
        includePartialMessages: true,
        ...(agent.runtime?.maxTurns ? { maxTurns: agent.runtime.maxTurns } : {}),
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      },
      // The model key on the CLI's own descriptor only (runClaudeTurn builds the spawner); the CLI's env is this
      // process's minus every credential, auth-path and inspector variable (runClaudeTurn's default).
      ...(credential !== undefined ? { credential } : {}),
      // The conversation's own rules, WITHOUT this turn's withholds: what the session is kept for. A tool withheld for
      // one turn is still refused (the options above), but it never starts the conversation over.
      sessionRules: claudeToolRules(agent.tools, Object.keys(mcpServers), { builtins: [] }),
    });
  },
  {
    framework: "claude-agent-sdk",
    sdkName: "@anthropic-ai/claude-agent-sdk",
    // Every turn's text goes through @guuey/worker's model text (runClaudeTurn), so this
    // worker handles a turn sent without text; the Router reads it here.
    // It also applies the agent's tool gates (the rules above), so every hello
    // says so with tool-gates.v1 (guuey#2670).
    capabilities: [...MODEL_TEXT_INPUT_KIND_CAPABILITIES, TOOL_GATES_CAPABILITY],
    // The turn's images reach the model (runClaudeTurn sends them as image blocks)
    // and are stored in the turn's session storage, so the hello says so.
    images: true,
    // The hello waits for runClaudeTurn's `emit.claudeSession`, so it can carry the session's block (guuey#3550).
    claudeSession: true,
  }
);
