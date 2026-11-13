import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpareHandle } from "./claude-spare.js";

// The runner imports the SDK as a module namespace; these fakes stand in for it.
const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  prewarm: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);

import { createRunner } from "./claude-runner.js";

const TEMPLATE = JSON.stringify({
  identity: { userId: "template", authMode: "anonymous" },
  fs: { app: "/app", home: "/home", session: "/session" },
});

/** A spare that never answers a claim; only its close is observed. */
function idleSpare(): SpareHandle & { closes: number } {
  const spare = {
    closes: 0,
    claim: () => {
      throw new Error("not claimed in these tests");
    },
    claimed: new Promise<{ cwd: string; sessionId: string }>(() => undefined),
    exited: new Promise<void>(() => undefined),
    close() {
      spare.closes += 1;
    },
  };
  return spare;
}

const saved = { spare: process.env.GUUEY_CLAUDE_SPARE, baseUrl: process.env.ANTHROPIC_BASE_URL };
let stderr: string[];

beforeEach(() => {
  sdk.prewarm.mockReset();
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (saved.spare === undefined) delete process.env.GUUEY_CLAUDE_SPARE;
  else process.env.GUUEY_CLAUDE_SPARE = saved.spare;
  if (saved.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = saved.baseUrl;
});

describe("createRunner and the parked spare switch", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("starts nothing when GUUEY_CLAUDE_SPARE is %s", async (_label, value) => {
    if (value === undefined) delete process.env.GUUEY_CLAUDE_SPARE;
    else process.env.GUUEY_CLAUDE_SPARE = value;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9911";
    const runner = createRunner({ snapshot: {} });
    await runner.close?.();
    expect(sdk.prewarm).not.toHaveBeenCalled();
    expect(stderr.join("")).toBe("");
  });

  it.each([
    ["not JSON", "not json", "is not JSON"],
    ["an empty object", "{}", "GUUEY_CLAUDE_SPARE"],
  ])("refuses a template that is %s, and starts nothing", async (_label, value, said) => {
    process.env.GUUEY_CLAUDE_SPARE = value;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9911";
    const runner = createRunner({ snapshot: {} });
    await runner.close?.();
    expect(sdk.prewarm).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain("Claude spare not started");
    expect(stderr.join("")).toContain(said);
  });

  it("starts nothing without a model-egress base URL", async () => {
    process.env.GUUEY_CLAUDE_SPARE = TEMPLATE;
    delete process.env.ANTHROPIC_BASE_URL;
    const runner = createRunner({ snapshot: {} });
    await runner.close?.();
    expect(sdk.prewarm).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain("no model-egress base URL");
  });

  it("starts nothing without a boot snapshot", async () => {
    process.env.GUUEY_CLAUDE_SPARE = TEMPLATE;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9911";
    const runner = createRunner({});
    await runner.close?.();
    expect(sdk.prewarm).not.toHaveBeenCalled();
  });

  it("parks one spare at creation with a valid template, and closes it with the runner when no turn took it", async () => {
    process.env.GUUEY_CLAUDE_SPARE = TEMPLATE;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9911";
    const spare = idleSpare();
    sdk.prewarm.mockResolvedValue(spare);
    const runner = createRunner({ snapshot: {} });
    expect(sdk.prewarm).toHaveBeenCalledTimes(1);
    await runner.close?.();
    expect(spare.closes).toBe(1);
    expect(stderr.join("")).toContain("Claude spare not used: the host is shutting down");
  });
});
