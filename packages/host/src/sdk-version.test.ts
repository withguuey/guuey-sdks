import { describe, expect, it } from "vitest";
import { resolveSdkVersion } from "./sdk-version.js";

describe("resolveSdkVersion", () => {
  it("resolves the REAL installed version of a real dependency (never a hardcoded literal)", () => {
    // Both are direct `@guuey/host` dependencies (package.json), so this reads
    // the actual installed version off node_modules — not a range/caret string.
    const claudeVersion = resolveSdkVersion("@anthropic-ai/claude-agent-sdk");
    expect(claudeVersion).not.toBeNull();
    expect(claudeVersion).toMatch(/^\d+\.\d+\.\d+/);

    const openaiVersion = resolveSdkVersion("@openai/agents");
    expect(openaiVersion).not.toBeNull();
    expect(openaiVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns null (tolerated) for a package that isn't installed", () => {
    expect(resolveSdkVersion("this-package-does-not-exist-anywhere")).toBeNull();
  });
});
