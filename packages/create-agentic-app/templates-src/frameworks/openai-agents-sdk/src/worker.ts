/**
 * agentic-app-template's code-mode worker entry (`@openai/agents`). Mirrors
 * `@guuey/host`'s `run-openai.ts` — the platform's own OpenAI wiring over this
 * exact snapshot shape: build an `Agent` from the resolved system prompt +
 * MCP endpoints, run it streamed, emit every raw `RunStreamEvent` to the
 * Router via `emit.native`, and resolve the turn's final text from
 * `stream.finalOutput`.
 *
 * `MaxTurnsExceededError` is swallowed here (unlike `run-openai.ts`, which
 * emits a `__host_error__` sentinel native event for its normalizer) —
 * `serveNative`'s handler contract has no such sentinel channel; the caught
 * error just becomes the turn's (empty) result, and `serveNative` itself
 * would otherwise turn an uncaught throw into a Worker Protocol `error` event.
 */
import { Agent, MaxTurnsExceededError, MCPServerStreamableHttp, run } from "@openai/agents";
import type { MCPServer } from "@openai/agents";
import { serveNative } from "@guuey/worker";
import { loadAgent, systemPrompt, mcpEndpoints, withHistory } from "./agent-config.js";

await serveNative(
  async (invoke, emit) => {
    const agent = loadAgent(invoke);
    const endpoints = mcpEndpoints(invoke, agent);
    const mcpServers: MCPServerStreamableHttp[] = Object.entries(endpoints).map(
      ([name, ep]) =>
        new MCPServerStreamableHttp({
          url: ep.url,
          name,
          ...(Object.keys(ep.headers).length > 0 ? { requestInit: { headers: ep.headers } } : {}),
        })
    );

    try {
      for (const server of mcpServers) {
        await server.connect();
      }

      const sdkAgent = new Agent({
        name: "guuey-agent",
        instructions: systemPrompt(invoke, agent) ?? "You are a helpful assistant.",
        mcpServers: mcpServers as MCPServer[],
        ...(agent.model ? { model: agent.model } : {}),
      });

      const stream = await run(sdkAgent, withHistory(invoke), {
        stream: true,
        ...(agent.runtime?.maxTurns ? { maxTurns: agent.runtime.maxTurns } : {}),
      });

      for await (const event of stream) {
        emit.native(JSON.parse(JSON.stringify(event)));
      }

      try {
        await stream.completed;
      } catch (err) {
        if (err instanceof MaxTurnsExceededError) return "";
        throw err;
      }

      return typeof stream.finalOutput === "string" ? stream.finalOutput : "";
    } finally {
      await Promise.allSettled(mcpServers.map((s) => s.close()));
    }
  },
  { framework: "openai-agents-sdk", sdkName: "@openai/agents" }
);
