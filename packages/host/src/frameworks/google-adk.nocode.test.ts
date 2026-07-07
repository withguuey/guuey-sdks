/**
 * No-code google-adk coverage (the production replacement for the deleted
 * Python host — review finding: previously only graceful mode was tested)
 * plus the review-driven regression pins: armed-env (the SDK actually reads
 * GEMINI_API_KEY), SSE streaming mode on runAsync, RUNNERS registry module
 * paths resolving, the graceful gate, and the import-condition (single-
 * INSTANCE) resolution.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Emitter, JsonValue, StopReason } from "@guuey/worker";
import { assertGracefulSupport, loadRunner, type HostTurn } from "../index.js";
import { createRunner, importConditionEntry, loadAdk } from "./google-adk.js";

function fakeEmitter() {
  const got = {
    hello: [] as Array<{ sdkName: string | null; sdkVersion: string | null }>,
    native: [] as JsonValue[],
    done: [] as Array<{ result: string; stopReason: StopReason | undefined }>,
    error: [] as string[],
  };
  const emit: Emitter = {
    text: () => undefined,
    done: (result, stopReason) => got.done.push({ result, stopReason }),
    error: (m) => got.error.push(m),
    native: (_f, e) => got.native.push(e),
    hello: (_f, sdkName, sdkVersion) => got.hello.push({ sdkName, sdkVersion }),
  };
  return { emit, got };
}

describe("no-code turn (createRunner without GUUEY_AGENT_ENTRY)", () => {
  const base = mkdtempSync(join(tmpdir(), "adk-nocode-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  afterEach(() => {
    delete process.env.GUUEY_AGENT_ENTRY;
  });

  it("constructs the LlmAgent from the snapshot (preambled instruction, cred toolsets, model), streams SSE, role-pinned", async () => {
    // A real cred file on disk — the production contract the broker writes.
    const session = join(base, "session");
    mkdirSync(join(session, ".guuey", "credentials"), { recursive: true });
    writeFileSync(
      join(session, ".guuey", "credentials", "todo.json"),
      JSON.stringify({ url: "https://mcp.dev/proxy/x/", transport: "http", headers: { authorization: "Bearer t" } }),
    );

    const captured: { agent?: unknown; runAsync?: unknown; toolsets: unknown[] } = { toolsets: [] };
    const fakeAdk = {
      LlmAgent: class {
        constructor(public readonly params: { name: string; model: string; instruction: string; tools: unknown[] }) {
          captured.agent = this;
        }
      },
      MCPToolset: class {
        constructor(public readonly params: unknown) {
          captured.toolsets.push(params);
        }
      },
      InMemoryRunner: class {
        readonly appName = "fake";
        readonly sessionService = {
          createSession: ({ userId }: { appName: string; userId: string }) => Promise.resolve({ id: `s-${userId}` }),
        };
        constructor(public readonly p: { agent: object }) {}
        async *runAsync(params: unknown): AsyncGenerator<JsonValue, void, undefined> {
          captured.runAsync = params;
          yield { content: { parts: [{ text: "streamed answer" }] } };
        }
      },
    };
    const runner = createRunner({ load: () => Promise.resolve(fakeAdk) });
    const { emit, got } = fakeEmitter();
    const turn: HostTurn = {
      input: "do the thing",
      identity: { userId: "u-1", authMode: "anonymous" },
      fs: { app: base, home: base, session },
      history: [{ role: "user", text: "earlier" }],
      priorMemory: [{ key: "k", value: 1 }],
      priorState: { s: true },
    };
    await runner.runTurn({ model: "gemini-3.5-pro", systemPrompt: "be terse" }, turn, emit);

    expect(got.error).toEqual([]);
    const agent = captured.agent as { params: { name: string; model: string; instruction: string; tools: unknown[] } };
    expect(agent.params.model).toBe("gemini-3.5-pro");
    // preamble AUTO-INJECTED (history + memory + state) even in no-code:
    expect(agent.params.instruction).toContain("<conversation_history>");
    expect(agent.params.instruction).toContain("<thread_memory>");
    expect(agent.params.instruction).toContain("<working_state>");
    expect(agent.params.instruction.endsWith("be terse")).toBe(true);
    expect(agent.params.tools).toHaveLength(1);
    expect(captured.toolsets[0]).toEqual({
      type: "StreamableHTTPConnectionParams",
      url: "https://mcp.dev/proxy/x/",
      transportOptions: { requestInit: { headers: { authorization: "Bearer t" } } },
    });
    // role pin + SSE streaming mode (Python-host parity) on the real call:
    expect(captured.runAsync).toEqual({
      userId: "u-1",
      sessionId: "s-u-1",
      newMessage: { role: "user", parts: [{ text: "do the thing" }] },
      runConfig: { streamingMode: "sse" },
    });
    expect(got.done[0]?.result).toBe("streamed answer");
  });

  it("an sse cred file fails the turn with the actionable transport error", async () => {
    const session = join(base, "sse-session");
    mkdirSync(join(session, ".guuey", "credentials"), { recursive: true });
    writeFileSync(
      join(session, ".guuey", "credentials", "legacy.json"),
      JSON.stringify({ url: "https://old.dev/sse", transport: "sse", headers: {} }),
    );
    const fakeAdk = {
      LlmAgent: class {
        constructor(_: { name: string; model: string; instruction: string; tools: unknown[] }) {}
      },
      MCPToolset: class {
        constructor(_: unknown) {}
      },
      // never reached — the sse rejection throws before agent construction
      InMemoryRunner: class {
        readonly appName = "unreached";
        readonly sessionService = {
          createSession: (_: { appName: string; userId: string }) => Promise.resolve({ id: "unreached" }),
        };
        constructor(_: { agent: object }) {}
        // eslint-disable-next-line require-yield
        async *runAsync(_: unknown): AsyncGenerator<JsonValue, void, undefined> {
          throw new Error("unreached");
        }
      },
    };
    const runner = createRunner({ load: () => Promise.resolve(fakeAdk) });
    const { emit, got } = fakeEmitter();
    await runner.runTurn({}, {
      input: "x",
      identity: { userId: "u", authMode: "anonymous" },
      fs: { app: session, home: session, session },
      history: [],
    }, emit);
    expect(got.error[0]).toMatch(/legacy.*sse.*Streamable-HTTP only/s);
    expect(got.done).toHaveLength(0);
  });
});

describe("armed-env (spec §2.1.6): the REAL @google/adk reads the pod's gemini pair", () => {
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
  });

  it("Gemini picks GEMINI_API_KEY from env (the buildWorkerEnv keySlot)", async () => {
    process.env.GEMINI_API_KEY = "opaque-broker-token";
    const adk = (await import("@google/adk")) as { Gemini: new (p: { model: string }) => object };
    const llm = new adk.Gemini({ model: "gemini-3.5-flash" });
    // `apiKey` is a private-typed but own enumerable property — inspect via
    // JSON round-trip (structural boundary, no type erasure of shaped data).
    const shape = JSON.parse(JSON.stringify(llm)) as { apiKey?: string };
    expect(shape.apiKey).toBe("opaque-broker-token");
  });

  it("GOOGLE_GENAI_API_KEY takes precedence when both are set (the SDK's || order)", async () => {
    process.env.GOOGLE_GENAI_API_KEY = "genai-first";
    process.env.GEMINI_API_KEY = "gemini-second";
    const adk = (await import("@google/adk")) as { Gemini: new (p: { model: string }) => object };
    const shape = JSON.parse(JSON.stringify(new adk.Gemini({ model: "gemini-3.5-flash" }))) as { apiKey?: string };
    expect(shape.apiKey).toBe("genai-first");
  });
});

describe("RUNNERS registry paths resolve for real (dist/module-name drift guard)", () => {
  afterEach(() => {
    delete process.env.GUUEY_AGENT_ENTRY;
  });
  it("every registered framework's runner module loads and returns a runner", async () => {
    for (const framework of ["claude-agent-sdk", "openai-agents-sdk", "google-adk"]) {
      const runner = await loadRunner(framework);
      expect(typeof runner.runTurn).toBe("function");
    }
  });
});

describe("assertGracefulSupport — 'non-goal' means rejected loudly, not ignored", () => {
  it("throws for claude/openai when GUUEY_AGENT_ENTRY is set", () => {
    expect(() => assertGracefulSupport("claude-agent-sdk", "agent.js")).toThrow(/not supported for framework "claude-agent-sdk"/);
    expect(() => assertGracefulSupport("openai-agents-sdk", "agent.js")).toThrow(/full worker/);
  });
  it("passes for google-adk with an entry, and for anyone without one", () => {
    expect(() => assertGracefulSupport("google-adk", "agent.js")).not.toThrow();
    expect(() => assertGracefulSupport("claude-agent-sdk", undefined)).not.toThrow();
    expect(() => assertGracefulSupport("claude-agent-sdk", "")).not.toThrow();
  });
});

describe("importConditionEntry — the single-INSTANCE rule (ESM/CJS dual-package hazard)", () => {
  const base = mkdtempSync(join(tmpdir(), "adk-cond-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("returns the exports '.' import target; loadAdk drives the ESM instance the dev's agent imports", async () => {
    const worker = join(base, "worker");
    const adkDir = join(worker, "node_modules", "@google", "adk");
    mkdirSync(join(adkDir, "dist"), { recursive: true });
    writeFileSync(
      join(adkDir, "package.json"),
      JSON.stringify({
        name: "@google/adk",
        version: "1.0.0-cond",
        type: "module",
        main: "./dist/cjs.cjs",
        exports: { ".": { import: "./dist/esm.js", require: "./dist/cjs.cjs" } },
      }),
    );
    writeFileSync(join(adkDir, "dist", "esm.js"), 'export const INSTANCE = "esm-import-condition";\n');
    writeFileSync(join(adkDir, "dist", "cjs.cjs"), 'module.exports = { INSTANCE: "cjs-require-condition" };\n');
    writeFileSync(join(worker, "agent.js"), "export default {};\n");

    const resolvedCjs = join(adkDir, "dist", "cjs.cjs");
    expect(importConditionEntry(resolvedCjs)).toBe(join(adkDir, "dist", "esm.js"));

    const mod = (await loadAdk(join(worker, "agent.js"))) as unknown as { INSTANCE?: string };
    expect(mod.INSTANCE).toBe("esm-import-condition");
  });

  it("falls back to the require resolution when the package has no exports map", () => {
    const plainDir = join(base, "plain", "node_modules", "@google", "adk");
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, "package.json"), JSON.stringify({ name: "@google/adk", version: "1", main: "./index.js" }));
    expect(importConditionEntry(join(plainDir, "index.js"))).toBeUndefined();
  });
});
