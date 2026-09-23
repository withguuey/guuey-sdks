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
      template: "base",
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
  it("--template selects the app template, defaults to base, rejects unknown values", () => {
    expect(
      buildScaffoldOptions("x", { framework: "claude-agent-sdk", template: "agentic-app" }).template
    ).toBe("agentic-app");
    expect(buildScaffoldOptions("x", { framework: "claude-agent-sdk" }).template).toBe("base");
    expect(() =>
      buildScaffoldOptions("x", { framework: "claude-agent-sdk", template: "fancy" })
    ).toThrow(/template/);
  });
  it("--for personal|customers stamps builtFor; absent carries no key (guuey#1670)", () => {
    expect(buildScaffoldOptions("x", { framework: "claude-agent-sdk", for: "personal" }).builtFor).toBe(
      "personal"
    );
    expect(buildScaffoldOptions("x", { framework: "claude-agent-sdk", for: "customers" }).builtFor).toBe(
      "customers"
    );
    // Absent means absent, never a guessed default: guuey deploy asks instead.
    expect("builtFor" in buildScaffoldOptions("x", { framework: "claude-agent-sdk" })).toBe(false);
  });
  it("--for refuses an unknown or valueless value, naming both answers", () => {
    expect(() => buildScaffoldOptions("x", { framework: "claude-agent-sdk", for: "team" })).toThrow(
      /Unknown --for "team".*--for personal.*--for customers/
    );
    expect(() => buildScaffoldOptions("x", { framework: "claude-agent-sdk", for: true })).toThrow(
      /--for needs a value/
    );
  });
  it("--name overrides the target-derived name", () => {
    expect(
      buildScaffoldOptions("./apps/thing", { name: "thing", framework: "claude-agent-sdk" }).name
    ).toBe("thing");
  });
});
