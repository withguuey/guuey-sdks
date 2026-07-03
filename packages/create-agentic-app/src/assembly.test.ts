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
});
