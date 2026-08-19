import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(__dirname, "..", "dist", "templates");

/** Files every assembled (template × framework) tree must contain. */
const SHARED_LAYOUT = [
  "package.json",
  "guuey.json",
  "guuey.app.json",
  "guuey.app.schema.json",
  "src/worker.ts",
  "src/agent-config.ts",
  "prompts/system.md",
  "mcps/todo/src/server.ts",
  "ggui/ggui.json",
  "scripts/dev.mjs",
  "scripts/bootstrap.mjs",
  ".env.example",
  "pnpm-workspace.yaml",
  "AGENTS.md",
  // The shared web app (@guuey/chat tier).
  "web/package.json",
  "web/src/main.tsx",
  "web/src/config.ts",
  "web/src/routes.ts",
  "web/src/components/AgentChat.tsx",
  "web/src/components/BootstrapGate.tsx",
  "web/src/pages/Landing.tsx",
  "web/src/pages/Login.tsx",
  "web/src/pages/Home.tsx",
];

describe("assembled templates", () => {
  it.each(["claude-agent-sdk", "openai-agents-sdk"])(
    "base/%s tree contains the layout contract",
    (fw) => {
      const root = join(dist, "base", fw);
      for (const p of [...SHARED_LAYOUT, "web/src/pages/Chat.tsx"])
        expect(existsSync(join(root, p)), p).toBe(true);
      // Nothing agentic leaks into base.
      expect(existsSync(join(root, "web/src/components/AppShell.tsx"))).toBe(false);
      expect(existsSync(join(root, ".overlay-remove"))).toBe(false);
    }
  );

  it.each(["claude-agent-sdk", "openai-agents-sdk"])(
    "agentic-app/%s tree = base + shell overlay − the standalone chat page",
    (fw) => {
      const root = join(dist, "agentic-app", fw);
      for (const p of [
        ...SHARED_LAYOUT,
        "web/src/components/AppShell.tsx",
        "web/src/pages/Dashboard.tsx",
        "web/src/pages/TalkOnMobile.tsx",
        "web/src/styles-app.css",
      ])
        expect(existsSync(join(root, p)), p).toBe(true);
      // .overlay-remove is an assembly manifest, never shipped; the page it
      // removes is gone; the overlay's routes.ts won.
      expect(existsSync(join(root, ".overlay-remove"))).toBe(false);
      expect(existsSync(join(root, "web/src/pages/Chat.tsx"))).toBe(false);
      const routes = readFileSync(join(root, "web/src/routes.ts"), "utf8");
      expect(routes).toContain('CHAT_PATH = "/app"');
      // The chat-rail shell (guuey#303): the rail IS the chat surface.
      const shell = readFileSync(join(root, "web/src/components/AppShell.tsx"), "utf8");
      expect(shell).toContain("agent-rail");
      expect(shell).toContain("demo:render-complete");
    }
  );

  it("stamps a real model (no placeholder) and pinned internal versions", () => {
    const guuey = JSON.parse(readFileSync(join(dist, "base", "claude-agent-sdk", "guuey.json"), "utf8"));
    expect(guuey.agent.model).not.toMatch(/PLACEHOLDER/);
    const pkg = JSON.parse(readFileSync(join(dist, "base", "claude-agent-sdk", "package.json"), "utf8"));
    expect(pkg.dependencies["@guuey/worker"]).toMatch(/^\d/); // exact pin, no workspace:*
    const webPkg = JSON.parse(
      readFileSync(join(dist, "base", "claude-agent-sdk", "web", "package.json"), "utf8"),
    );
    expect(webPkg.dependencies["@guuey/chat"]).toMatch(/^\d/); // exact pin from versions.json
  });

  it.each(["claude-agent-sdk", "openai-agents-sdk"])(
    "base/%s mcps/todo is a complete server (mcp-base + todo overlay, name resolved)",
    (fw) => {
      const todoDir = join(dist, "base", fw, "mcps", "todo");
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
