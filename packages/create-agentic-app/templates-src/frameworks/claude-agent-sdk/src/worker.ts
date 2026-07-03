/**
 * agentic-app-template's code-mode worker entry (Claude Agent SDK). Reads the
 * resolved agent snapshot + MCP endpoints via `./agent-config.js`, drives one
 * `query()` per invoke, and streams every native SDK message to the Router
 * via `emit.native` (the field spellings below — `mcpServers`/`systemPrompt`/
 * `allowedTools`/`maxTurns`, and the `type === "result" && subtype ===
 * "success"` result-detection — mirror `@guuey/host`'s `buildOptions` /
 * `runInvoke`, the platform's own consumer of this exact snapshot shape).
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { serveNative } from "@guuey/worker";
import { loadAgent, systemPrompt, mcpEndpoints, withHistory } from "./agent-config.js";

await serveNative(
  async (invoke, emit) => {
    const agent = loadAgent(invoke);
    const mcpServers = Object.fromEntries(
      Object.entries(mcpEndpoints(invoke, agent)).map(([name, ep]) => [
        name,
        { type: ep.transport, url: ep.url, headers: ep.headers },
      ])
    );
    let result = "";
    for await (const message of query({
      prompt: withHistory(invoke),
      options: {
        ...(agent.model ? { model: agent.model } : {}),
        ...(systemPrompt(invoke, agent) ? { systemPrompt: systemPrompt(invoke, agent) } : {}),
        mcpServers,
        ...(agent.tools?.allowlist ? { allowedTools: agent.tools.allowlist } : {}),
        ...(agent.runtime?.maxTurns ? { maxTurns: agent.runtime.maxTurns } : {}),
      },
    })) {
      emit.native(JSON.parse(JSON.stringify(message)));
      if (message.type === "result" && message.subtype === "success") result = message.result;
    }
    return result;
  },
  { framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk" }
);
