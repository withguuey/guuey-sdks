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
import { query } from "@anthropic-ai/claude-agent-sdk";
import { serveNative } from "@guuey/worker";
import { loadAgent, systemPrompt, mcpEndpoints, withHistory } from "./agent-config.js";

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
    const mcpServers = Object.fromEntries(
      Object.entries(mcpEndpoints(invoke, agent)).map(([name, ep]) => [
        name,
        // `alwaysLoad` — this agent's declared MCP servers ARE its tool
        // surface; without it the CLI defers MCP tools behind its ToolSearch
        // built-in (absent here — see `tools: []` below), leaving the model
        // tool-less.
        { type: ep.transport, url: ep.url, headers: ep.headers, alwaysLoad: true },
      ])
    );
    let result = "";
    for await (const message of query({
      prompt: withHistory(invoke),
      options: {
        ...(agent.model ? { model: agent.model } : {}),
        ...(systemPrompt(invoke, agent) ? { systemPrompt: systemPrompt(invoke, agent) } : {}),
        mcpServers,
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
        ...(agent.runtime?.maxTurns ? { maxTurns: agent.runtime.maxTurns } : {}),
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      },
    })) {
      emit.native(JSON.parse(JSON.stringify(message)));
      if (message.type === "result" && message.subtype === "success") result = message.result;
    }
    return result;
  },
  { framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk" }
);
