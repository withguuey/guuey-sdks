import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(__dirname, "..", "dist", "templates");

describe("assembled templates", () => {
  it.each(["claude-agent-sdk", "openai-agents-sdk"])(
    "%s tree contains the layout contract",
    (fw) => {
      const root = join(dist, fw);
      for (const p of [
        "package.json",
        "guuey.json",
        "src/worker.ts",
        "src/agent-config.ts",
        "prompts/system.md",
        "mcps/todo/src/server.ts",
        "ggui/ggui.json",
        "web/src/useAgentChat.ts",
        "scripts/dev.mjs",
        ".env.example",
        "pnpm-workspace.yaml",
      ])
        expect(existsSync(join(root, p)), p).toBe(true);
    }
  );

  it("stamps a real model (no placeholder) and pinned internal versions", () => {
    const guuey = JSON.parse(readFileSync(join(dist, "claude-agent-sdk", "guuey.json"), "utf8"));
    expect(guuey.agent.model).not.toMatch(/PLACEHOLDER/);
    const pkg = JSON.parse(readFileSync(join(dist, "claude-agent-sdk", "package.json"), "utf8"));
    expect(pkg.dependencies["@guuey/worker"]).toMatch(/^\d/); // exact pin, no workspace:*
  });

  it.each(["claude-agent-sdk", "openai-agents-sdk"])(
    "%s mcps/todo is a complete server (mcp-base + todo overlay, name resolved)",
    (fw) => {
      const todoDir = join(dist, fw, "mcps", "todo");
      for (const p of ["package.json", "tsconfig.json", "Dockerfile", "src/server.ts"])
        expect(existsSync(join(todoDir, p)), p).toBe(true);

      const pkg = JSON.parse(readFileSync(join(todoDir, "package.json"), "utf8"));
      expect(pkg.name).toBe("@agentic-app-template/todo-mcp");

      const server = readFileSync(join(todoDir, "src/server.ts"), "utf8");
      for (const tool of ["todo_list", "todo_create", "todo_toggle", "todo_delete"])
        expect(server, tool).toContain(tool);
      expect(server).not.toContain("NAME_PLACEHOLDER");

      const dockerfile = readFileSync(join(todoDir, "Dockerfile"), "utf8");
      expect(dockerfile).not.toContain("NAME_PLACEHOLDER");
      expect(dockerfile).toContain("todo-mcp");
      expect(dockerfile).toContain("cd mcps/todo");
    }
  );

  it("emits dist/templates/mcp-base with the NAME_PLACEHOLDER token unresolved", () => {
    const mcpBaseDir = join(dist, "mcp-base");
    for (const p of ["package.json", "tsconfig.json", "Dockerfile", "src/server.ts"])
      expect(existsSync(join(mcpBaseDir, p)), p).toBe(true);

    const pkg = JSON.parse(readFileSync(join(mcpBaseDir, "package.json"), "utf8"));
    expect(pkg.name).toBe("@agentic-app-template/NAME_PLACEHOLDER-mcp");
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toMatch(/^\^/); // still pinned via versions.json rules

    const server = readFileSync(join(mcpBaseDir, "src/server.ts"), "utf8");
    expect(server).toContain("NAME_PLACEHOLDER");
    expect(server).toContain("echo");
    // the todo-specific tools must NOT leak into the shared base
    for (const tool of ["todo_list", "todo_create", "todo_toggle", "todo_delete"])
      expect(server).not.toContain(tool);
  });
});
