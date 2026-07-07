/**
 * Graceful-mode tests: entry containment, default-export loading, agent
 * materialization (factory + plain + WARN), GuueyContext completeness, and a
 * full on-disk graceful turn through the google-adk runner (fixture ADK copy
 * in the worker tree — proving the single-copy rule end to end).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { GuueyContext } from "@guuey/config";
import type { Emitter, JsonValue, StopReason } from "@guuey/worker";
import { loadAgentEntry, materializeAgent, resolveAgentEntry } from "./agent-entry.js";
import { buildGuueyContext, createRunner } from "./frameworks/google-adk.js";
import type { HostTurn } from "./index.js";

const TURN: HostTurn = {
  input: "what's next?",
  identity: { userId: "u-7", authMode: "authenticated" },
  fs: { app: "/mnt/app", home: "/mnt/home", session: "/mnt/session" },
  history: [
    { role: "user", text: "hi" },
    { role: "agent", text: "hello!" },
  ],
  priorMemory: [{ key: "name", value: "Ada" }, { value: "unkeyed-fact" }],
  priorState: { step: 2 },
};

// ── containment ──────────────────────────────────────────────────────────────

describe("resolveAgentEntry — strict worker-root containment", () => {
  it("resolves a relative entry under the root", () => {
    expect(resolveAgentEntry("dist/agent.js", "/worker")).toBe("/worker/dist/agent.js");
  });
  it("rejects traversal that escapes the root", () => {
    expect(() => resolveAgentEntry("../outside.js", "/worker")).toThrow(/escapes the worker root/);
    expect(() => resolveAgentEntry("dist/../../etc/passwd", "/worker")).toThrow(/escapes the worker root/);
  });
  it("rejects absolute entries", () => {
    expect(() => resolveAgentEntry("/etc/passwd", "/worker")).toThrow(/must be a path relative/);
  });
});

// ── loading + materialization ────────────────────────────────────────────────

describe("loadAgentEntry / materializeAgent", () => {
  const base = mkdtempSync(join(tmpdir(), "agent-entry-test-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const ctxWith = (toolsets: unknown[]): GuueyContext =>
    buildGuueyContext({ model: "gemini-3.5-flash" }, TURN, "instr", toolsets);

  it("loads a default export; rejects a module without one", async () => {
    const good = join(base, "good.mjs");
    writeFileSync(good, "export default { marker: 'agent' };\n");
    expect(await loadAgentEntry(good)).toEqual({ marker: "agent" });

    const bad = join(base, "bad.mjs");
    writeFileSync(bad, "export const notDefault = 1;\n");
    await expect(loadAgentEntry(bad)).rejects.toThrow(/no default export/);
  });

  it("factory form: invoked (and awaited) with the GuueyContext", async () => {
    let seen: GuueyContext | undefined;
    const factory = async (guuey: GuueyContext) => {
      seen = guuey;
      return { built: true };
    };
    const agent = await materializeAgent(factory, ctxWith(["ts-1"]), () => undefined);
    expect(agent).toEqual({ built: true });
    expect(seen?.mcpToolsets).toEqual(["ts-1"]);
  });

  it("plain form: used as-is; WARNs once when MCP servers are configured", async () => {
    const warns: string[] = [];
    const agent = { plain: true };
    expect(await materializeAgent(agent, ctxWith(["ts-1"]), (m) => warns.push(m))).toBe(agent);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/NOT auto-injected.*factory/s);
    // no servers → no warn
    warns.length = 0;
    await materializeAgent(agent, ctxWith([]), (m) => warns.push(m));
    expect(warns).toHaveLength(0);
  });

  it("rejects a factory returning a non-object and a non-object export", async () => {
    await expect(materializeAgent(() => "nope", ctxWith([]), () => undefined)).rejects.toThrow(
      /factory returned string/,
    );
    await expect(materializeAgent(42, ctxWith([]), () => undefined)).rejects.toThrow(/default export is number/);
  });
});

// ── GuueyContext completeness ────────────────────────────────────────────────

describe("buildGuueyContext — every platform field populated", () => {
  it("carries model, instruction, toolsets, user, files, history, memory, workingState", () => {
    const ctx = buildGuueyContext(
      { model: "gemini-3.5-pro", systemPrompt: "be kind" },
      TURN,
      "PREAMBLED be kind",
      ["toolset-a"],
    );
    expect(ctx).toEqual({
      model: "gemini-3.5-pro",
      instruction: "PREAMBLED be kind",
      mcpToolsets: ["toolset-a"],
      user: { id: "u-7", authMode: "authenticated" },
      files: { app: "/mnt/app", home: "/mnt/home", session: "/mnt/session" },
      history: [
        { role: "user", text: "hi" },
        { role: "agent", text: "hello!" },
      ],
      memory: [{ key: "name", value: "Ada" }, { value: "unkeyed-fact" }],
      workingState: { step: 2 },
    });
  });
  it("defaults the model when the snapshot has none", () => {
    expect(buildGuueyContext({}, TURN, "i", []).model).toBe("gemini-3.5-flash");
  });
});

// ── the full graceful turn (on-disk fixture, single-copy proven) ─────────────

describe("graceful turn end-to-end (fixture worker tree)", () => {
  const base = mkdtempSync(join(tmpdir(), "graceful-e2e-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  afterEach(() => {
    delete process.env.GUUEY_AGENT_ENTRY;
    delete process.env.GUUEY_WORKER_ROOT;
  });

  function fakeEmitter() {
    const got = {
      hello: [] as Array<{ sdkVersion: string | null }>,
      native: [] as JsonValue[],
      done: [] as Array<{ result: string; stopReason: StopReason | undefined }>,
      error: [] as string[],
    };
    const emit: Emitter = {
      text: () => undefined,
      done: (result, stopReason) => got.done.push({ result, stopReason }),
      error: (m) => got.error.push(m),
      native: (_f, e) => got.native.push(e),
      hello: (_f, _n, sdkVersion) => got.hello.push({ sdkVersion }),
    };
    return { emit, got };
  }

  it("imports the dev factory, drives the ENTRY tree's ADK copy, emits its events", async () => {
    const worker = join(base, "worker");
    const adkDir = join(worker, "node_modules", "@google", "adk");
    mkdirSync(adkDir, { recursive: true });
    // The fixture ADK copy: a functioning InMemoryRunner + marker LlmAgent.
    writeFileSync(
      join(adkDir, "package.json"),
      JSON.stringify({ name: "@google/adk", version: "7.7.7-fixture", main: "./index.js", type: "module" }),
    );
    writeFileSync(
      join(adkDir, "index.js"),
      [
        "export class LlmAgent { constructor(p) { this.p = p; this.copy = 'entry-tree'; } }",
        "export class MCPToolset { constructor(p) { this.p = p; } }",
        "export class InMemoryRunner {",
        "  constructor({ agent }) { this.agent = agent; this.appName = 'fixture-app';",
        "    this.sessionService = { createSession: async ({ userId }) => ({ id: 'sess-' + userId }) }; }",
        "  async *runAsync({ newMessage }) {",
        "    yield { content: { parts: [{ text: 'echo:' + newMessage.parts[0].text + ':role=' + newMessage.role + ':agent=' + this.agent.copy } ] } };",
        "  }",
        "}",
      ].join("\n"),
    );
    // The dev's graceful module: a factory composing the platform context.
    writeFileSync(
      join(worker, "agent.mjs"),
      [
        "import { LlmAgent } from '@google/adk';",
        "export default (guuey) => new LlmAgent({ model: guuey.model, instruction: guuey.instruction, tools: guuey.mcpToolsets });",
      ].join("\n"),
    );

    process.env.GUUEY_AGENT_ENTRY = "agent.mjs";
    process.env.GUUEY_WORKER_ROOT = worker;
    const { emit, got } = fakeEmitter();
    await createRunner().runTurn({ model: "gemini-3.5-flash", systemPrompt: "sys" }, TURN, emit);

    expect(got.error).toEqual([]);
    expect(got.hello[0]?.sdkVersion).toBe("7.7.7-fixture"); // the ENTRY tree's copy, not the host's 1.3.0
    expect(got.done[0]?.result).toBe("echo:what's next?:role=user:agent=entry-tree");
  });
});
