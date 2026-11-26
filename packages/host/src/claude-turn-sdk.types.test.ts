/**
 * @guuey/worker's runClaudeTurn takes the app's own `query` and reads the app's options type from it (it imports no SDK).
 * This file pins that against the REAL Claude Agent SDK this package installs (its devDependency): the call below is the
 * Claude template's turn, shape for shape, and `tsc --noEmit` on this package refuses it if the SDK's `query`, its
 * options or its server config stop fitting the helper's structural types. The body never runs: the SDK is not called.
 */
import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { runClaudeTurn, type Invoke, type NativeEmit } from "@guuey/worker";
import { describe, expect, it } from "vitest";

/** The Claude template's call, with the real SDK's `query` and server config. */
function templateShapedTurn(invoke: Invoke, emit: NativeEmit): Promise<string> {
  const servers: Record<string, McpServerConfig> = {
    todo: { type: "http", url: "http://127.0.0.1:6782/mcp", headers: { authorization: "Bearer x" }, alwaysLoad: true },
  };
  return runClaudeTurn({
    query,
    invoke,
    emit,
    systemPrompt: "be brief",
    servers,
    options: {
      model: "claude-haiku-5-5",
      allowedTools: ["mcp__todo"],
      disallowedTools: ["mcp__todo__delete"],
      canUseTool: (_toolName, input) => Promise.resolve({ behavior: "allow", updatedInput: input }),
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      maxTurns: 3,
      pathToClaudeCodeExecutable: "/app/claude",
    },
    credential: { key: "sk-type-only", keyKind: "api-key" },
    sessionRules: { allowedTools: ["mcp__todo"], disallowedTools: [] },
  });
}

describe("runClaudeTurn against the real Claude Agent SDK types", () => {
  it("the template's call typechecks (this package's tsc is the check; nothing runs)", () => {
    expect(typeof templateShapedTurn).toBe("function");
  });
});
