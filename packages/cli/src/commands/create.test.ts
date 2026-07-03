import { describe, it, expect } from "vitest";
import { buildScaffoldOptions } from "./create.js";

describe("buildScaffoldOptions", () => {
  it("maps positional target + flags to ScaffoldOptions", () => {
    expect(
      buildScaffoldOptions("my-app", {
        framework: "openai-agents-sdk",
        scope: "acme",
        "no-git": true,
        force: true,
      })
    ).toEqual({
      targetDir: "my-app",
      name: "my-app",
      framework: "openai-agents-sdk",
      scope: "acme",
      git: false,
      force: true,
      install: false,
    });
  });
  it("accepts --agent as an alias for --framework and rejects unknown frameworks", () => {
    expect(buildScaffoldOptions("x", { agent: "claude-agent-sdk" }).framework).toBe(
      "claude-agent-sdk"
    );
    expect(() => buildScaffoldOptions("x", { framework: "google-adk" })).toThrow(/framework/);
  });
  it("--name overrides the target-derived name", () => {
    expect(
      buildScaffoldOptions("./apps/thing", { name: "thing", framework: "claude-agent-sdk" }).name
    ).toBe("thing");
  });
});
