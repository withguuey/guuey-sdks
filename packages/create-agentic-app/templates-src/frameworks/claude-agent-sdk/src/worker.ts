/**
 * agentic-app-template's code-mode worker entry (Claude Agent SDK). Reads the
 * resolved agent snapshot + MCP endpoints via `./agent-config.js`, drives one
 * `query()` per invoke, and streams every native SDK message to the Router
 * via `emit.native` (the field spellings below — `mcpServers`/`systemPrompt`/
 * `allowedTools`/`maxTurns`, and the `type === "result" && subtype ===
 * "success"` result-detection — mirror `@guuey/host`'s `buildOptions` /
 * `runInvoke`, the platform's own consumer of this exact snapshot shape).
 */
import { createRequire } from "node:module";
import { query, type McpServerConfig, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_FORBIDDEN_ENV, makeClaudeSpawner, readLaunchEnvelope, serveNative } from "@guuey/worker";
import { loadAgent, systemPrompt, mcpEndpoints, withHistory } from "./agent-config.js";

/**
 * The model credential (guuey#2139). A platform launch delivers it privately
 * on a descriptor (`readLaunchEnvelope`, read once, here, before anything is
 * spawned); otherwise it comes from this process's environment, as before.
 * Either way the Claude CLI receives it only on its own private descriptor
 * (`makeClaudeSpawner`), never in its environment or argv, so the CLI's Bash
 * and tool children never inherit it.
 */
const envelope = await readLaunchEnvelope();
const modelKey =
  envelope?.model?.token ?? (process.env.ANTHROPIC_AUTH_TOKEN || undefined) ?? (process.env.ANTHROPIC_API_KEY || undefined);

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
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let endInput!: () => void;
    const inputDone = new Promise<void>((resolve) => (endInput = resolve));
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      await gate;
      yield { type: "user", message: { role: "user", content: withHistory(invoke) }, parent_tool_use_id: null };
      await inputDone;
    }
    const q = query({
      prompt: prompt(),
      options: {
        ...(agent.model ? { model: agent.model } : {}),
        ...(systemPrompt(invoke, agent) ? { systemPrompt: systemPrompt(invoke, agent) } : {}),
        // Same posture as `@guuey/host`'s `buildOptions` (options.ts):
        // - allowedTools: the snapshot allowlist verbatim, else every tool
        //   from every declared server (`mcp__<server>` prefix match) — MCP
        //   calls would otherwise hit the SDK's interactive ask stage, which
        //   nothing answers headless, so they'd be silently denied.
        // - tools: [] — purely MCP-driven; no Bash/file/search built-ins.
        // - settingSources: [] — never load the machine's ~/.claude or
        //   project settings into this worker (a dev box's logged-in Claude
        //   Code MCPs/plugins would leak into the tool catalog).
        // - strictMcpConfig: true — the snapshot's servers only; ignore
        //   .mcp.json / user settings / plugins.
        allowedTools: agent.tools?.allowlist ?? Object.keys(mcpServers).map((s) => `mcp__${s}`),
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        env: cliEnv(),
        ...(modelKey ? { spawnClaudeCodeProcess: makeClaudeSpawner({ key: modelKey, secrets: headerValues }) } : {}),
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
      await q.setMcpServers(mcpServers);
      const readyBy = Date.now() + MCP_READY_DEADLINE_MS;
      while (Date.now() < readyBy && (await q.mcpServerStatus()).some((s) => s.status === "pending")) {
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
    openGate();
    await messages;
    endInput();
    return result;
  },
  { framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk" }
);
