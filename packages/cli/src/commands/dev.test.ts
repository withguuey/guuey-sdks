import { describe, it, expect } from "vitest";
import { isSnapshotOnlyBoot } from "./dev.js";

/**
 * Truth table for the guuey#111 snapshot-only host boot. The command wiring
 * (spawning @guuey/host, credential brokering) rides the dev-server suite;
 * this pins the DECISION so a refactor can't silently re-require worker
 * boilerplate for snapshot-driven frameworks — or worse, silently ignore a
 * worker the builder wrote.
 */
describe("isSnapshotOnlyBoot (guuey#111)", () => {
  const base = {
    worker: undefined,
    agentEntry: undefined,
    framework: "claude-agent-sdk",
    defaultWorkerBuildExists: false,
  };

  it("boots snapshot-only: claude-agent-sdk, nothing declared, no build", () => {
    expect(isSnapshotOnlyBoot(base)).toBe(true);
  });

  it("boots snapshot-only for openai-agents-sdk too", () => {
    expect(isSnapshotOnlyBoot({ ...base, framework: "openai-agents-sdk" })).toBe(true);
  });

  it("a declared worker always wins", () => {
    expect(isSnapshotOnlyBoot({ ...base, worker: "dist/worker.js" })).toBe(false);
  });

  it("a build at the default path always wins (never ignore written worker code)", () => {
    expect(isSnapshotOnlyBoot({ ...base, defaultWorkerBuildExists: true })).toBe(false);
  });

  it("a declared agent.entry routes to entry-graceful handling, not snapshot-only", () => {
    expect(isSnapshotOnlyBoot({ ...base, agentEntry: "dist/agent.js" })).toBe(false);
  });

  it("google-adk never boots snapshot-only — its runner loads the agent module", () => {
    expect(isSnapshotOnlyBoot({ ...base, framework: "google-adk" })).toBe(false);
  });
});
