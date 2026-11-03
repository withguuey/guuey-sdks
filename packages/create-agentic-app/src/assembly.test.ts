import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GUUEY_DEFAULT_SYSTEM_PROMPT } from "@guuey/config";

const dist = join(__dirname, "..", "dist", "templates");

/** Files every assembled (template × framework) tree must contain. */
const SHARED_LAYOUT = [
  "package.json",
  "guuey.json",
  "guuey.app.json",
  "guuey.app.schema.json",
  "theme.json",
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

describe("assembled manage-only template (guuey#581 pt 5)", () => {
  const agentDir = join(dist, "agent");
  it("emits flat (no framework axis): declarative manifest, stamped model, pinned CLI, stamped prompt", () => {
    const guuey = JSON.parse(readFileSync(join(agentDir, "guuey.json"), "utf8"));
    expect(guuey.agent.mode).toBe("declarative");
    expect(guuey.agent.model).not.toContain("PLACEHOLDER"); // resolved to the platform default
    const pkg = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8"));
    expect(pkg.devDependencies["@guuey/cli"]).not.toBe("0.0.0"); // versions.json stamped
    // NO web app in the manage-only repo — that's the persona split.
    expect(existsSync(join(agentDir, "apps"))).toBe(false);
  });

  it("ships the runtime default prompt, not core's: no todo tool it does not have, and pull still knows it", () => {
    const prompt = readFileSync(join(agentDir, "prompts", "system.md"), "utf8");
    expect(prompt).toBe(`${GUUEY_DEFAULT_SYSTEM_PROMPT}\n`);
    expect(prompt).not.toMatch(/todo/i);
    // No template name in it, so the scaffold's rename cannot change a byte.
    expect(prompt).not.toContain("agentic-app-template");
  });

  it("installs cleanly on pnpm 10/11 and npm 11: esbuild's postinstall is allowlisted for each", () => {
    const ws = readFileSync(join(agentDir, "pnpm-workspace.yaml"), "utf8");
    expect(ws).toMatch(/^allowBuilds:\n {2}esbuild: true$/m); // pnpm 11
    expect(ws).toMatch(/^onlyBuiltDependencies:\n {2}- esbuild$/m); // pnpm 10
    expect(ws).not.toMatch(/^packages:/m); // one package, not a workspace
    const pkg = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8"));
    expect(pkg.allowScripts).toEqual({ esbuild: true }); // npm 11
  });

  it("every script is a manage-only verb: no dead `dev`, status is what is live, never `guuey deploy`", () => {
    const { scripts } = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8"));
    expect(scripts).toEqual({
      login: "guuey login",
      pull: "guuey pull",
      apply: "guuey agent apply",
      status: "guuey agent status",
      open: "guuey open",
    });
  });

  it("ships AGENTS.md steering a coding agent to apply (plan first), never deploy or dev", () => {
    const steering = readFileSync(join(agentDir, "AGENTS.md"), "utf8");
    expect(steering).toContain("guuey agent apply --dry-run");
    expect(steering).toContain('"appId"');
    expect(steering).toMatch(/\*\*Never\*\* run `guuey deploy`/);
    // The scaffold fills the runner; the shipped file still carries the placeholder.
    expect(steering).toContain("PNPM_PLACEHOLDER apply");
  });

  // A repo bound to a console-made app holds the template's prompt until it
  // pulls; the loop and the README both put pull before the first apply.
  it("puts pull before the first apply in the AGENTS.md loop and the README loop", () => {
    for (const file of ["AGENTS.md", "README.md"]) {
      const text = readFileSync(join(agentDir, file), "utf8");
      const pull = text.indexOf("PNPM_PLACEHOLDER pull");
      const apply = text.indexOf("PNPM_PLACEHOLDER apply");
      expect(pull, file).toBeGreaterThan(-1);
      expect(pull, file).toBeLessThan(apply);
    }
  });

  it("names guuey eject, one-way and run by the user in their own terminal, as the road from a live app to code", () => {
    const steering = readFileSync(join(agentDir, "AGENTS.md"), "utf8");
    expect(steering).toContain("guuey eject --app-id <id>");
    expect(steering).toContain("one-way");
    expect(steering).toContain("run it themselves in their own terminal");
    expect(steering).toContain("never pass `--yes`");
  });
});
