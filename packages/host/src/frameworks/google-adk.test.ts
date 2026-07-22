/**
 * Unit tests for the google-adk runner: cred→toolset mapping (incl. the sse
 * rejection), the adk-js#475 `role:"user"` pin, event pass-through ordering,
 * final-text extraction, the systemPrompt guard, the missing-peer error, and
 * the single-copy resolution order (loadAdk resolves from the agent entry's
 * own tree when given one).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BaseLlmConnection, LlmRequest, LlmResponse } from "@google/adk";
import type { Emitter, JsonValue, StopReason } from "@guuey/worker";
import type { HostTurn } from "../index.js";
import { withContextPreamble } from "../preamble.js";
import { buildToolsets, finalTextOf, loadAdk, runAdkTurn } from "./google-adk.js";

// ── fakes ────────────────────────────────────────────────────────────────────

interface Emitted {
  hello: Array<{ framework: string; sdkName: string | null; sdkVersion: string | null }>;
  native: Array<{ framework: string; event: JsonValue }>;
  done: Array<{ result: string; stopReason: StopReason | undefined }>;
  error: string[];
  order: string[];
}

function fakeEmitter(): { emit: Emitter; got: Emitted } {
  const got: Emitted = { hello: [], native: [], done: [], error: [], order: [] };
  const emit: Emitter = {
    text: () => {
      got.order.push("text");
    },
    done: (result, stopReason) => {
      got.done.push({ result, stopReason });
      got.order.push("done");
    },
    error: (message) => {
      got.error.push(message);
      got.order.push("error");
    },
    native: (framework, event) => {
      got.native.push({ framework, event });
      got.order.push("native");
    },
    hello: (framework, sdkName, sdkVersion) => {
      got.hello.push({ framework, sdkName, sdkVersion });
      got.order.push("hello");
    },
  };
  return { emit, got };
}

class FakeToolset {
  constructor(
    public readonly params: {
      type: string;
      url: string;
      transportOptions?: { requestInit?: { headers?: Record<string, string> } };
    },
  ) {}
}

function fakeAdk(events: JsonValue[], capture: { runAsyncParams?: unknown }) {
  return {
    InMemoryRunner: class {
      readonly appName = "fake-app";
      readonly sessionService = {
        createSession: (req: { appName: string; userId: string }) =>
          Promise.resolve({ id: `sess-${req.userId}` }),
      };
      constructor(public readonly params: { agent: object }) {}
      async *runAsync(params: unknown): AsyncGenerator<JsonValue, void, undefined> {
        capture.runAsyncParams = params;
        for (const e of events) yield e;
      }
    },
  };
}

const TURN: HostTurn = {
  input: "hi there",
  identity: { userId: "u-42", authMode: "anonymous" },
  fs: { app: "/tmp/nope-app", home: "/tmp/nope-home", session: "/tmp/nope-session" },
  history: [],
};

// ── toolset mapping ──────────────────────────────────────────────────────────

describe("buildToolsets — cred file → MCPToolset", () => {
  it("maps an http cred to StreamableHTTPConnectionParams with headers on transportOptions.requestInit", () => {
    const out = buildToolsets({ MCPToolset: FakeToolset }, [
      {
        name: "todo",
        cred: { url: "https://mcp.example/proxy/x/", transport: "http", headers: { authorization: "Bearer t-1" } },
      },
    ]);
    expect(out).toHaveLength(1);
    const ts = out[0] as FakeToolset;
    expect(ts.params.type).toBe("StreamableHTTPConnectionParams");
    expect(ts.params.url).toBe("https://mcp.example/proxy/x/");
    expect(ts.params.transportOptions?.requestInit?.headers).toEqual({ authorization: "Bearer t-1" });
  });

  it("REJECTS an sse cred with an actionable error naming the server", () => {
    expect(() =>
      buildToolsets({ MCPToolset: FakeToolset }, [
        { name: "legacy-sse", cred: { url: "https://old.example/sse", transport: "sse", headers: {} } },
      ]),
    ).toThrow(/legacy-sse.*sse.*Streamable-HTTP only/s);
  });
});

// ── the turn loop ────────────────────────────────────────────────────────────

describe("runAdkTurn — the wire contract", () => {
  it("pins role:'user' on newMessage (adk-js#475) and passes userId/sessionId through", async () => {
    const capture: { runAsyncParams?: unknown } = {};
    const adk = fakeAdk([], capture);
    const { emit } = fakeEmitter();
    await runAdkTurn(adk, {}, TURN, emit, "1.3.0");
    expect(capture.runAsyncParams).toEqual({
      userId: "u-42",
      sessionId: "sess-u-42",
      newMessage: { role: "user", parts: [{ text: "hi there" }] },
      runConfig: { streamingMode: "sse" },
    });
  });

  it("emits hello FIRST, every native event untouched, then done with the last non-thought text", async () => {
    const events: JsonValue[] = [
      { content: { parts: [{ thought: true, text: "thinking…" }] }, partial: true },
      { content: { parts: [{ functionCall: { name: "todo_create", args: { t: "x" } } }] } },
      { content: { parts: [{ text: "All done!" }] }, finishReason: "STOP" },
    ];
    const adk = fakeAdk(events, {});
    const { emit, got } = fakeEmitter();
    await runAdkTurn(adk, {}, TURN, emit, "1.3.0");
    expect(got.order).toEqual(["hello", "native", "native", "native", "done"]);
    expect(got.hello[0]).toEqual({ framework: "google-adk", sdkName: "@google/adk", sdkVersion: "1.3.0" });
    expect(got.native.map((n) => n.framework)).toEqual(["google-adk", "google-adk", "google-adk"]);
    expect(got.native[1]?.event).toEqual(events[1]);
    expect(got.done[0]).toEqual({ result: "All done!", stopReason: "end_turn" });
  });

  it("a runner throw becomes a terminal error event (hello still first, no done)", async () => {
    const adk = {
      InMemoryRunner: class {
        readonly appName = "x";
        readonly sessionService = {
          createSession: () => Promise.reject(new Error("boom at session")),
        };
        constructor(_: { agent: object }) {}
        // eslint-disable-next-line require-yield
        async *runAsync(): AsyncGenerator<JsonValue, void, undefined> {
          throw new Error("unreachable");
        }
      },
    };
    const { emit, got } = fakeEmitter();
    await runAdkTurn(adk, {}, TURN, emit, null);
    expect(got.order).toEqual(["hello", "error"]);
    expect(got.error[0]).toMatch(/boom at session/);
    expect(got.done).toHaveLength(0);
  });
});

// ── F7: instruction as function bypasses ADK's {var} substitution ──────────
//
// ADK's `canonicalInstruction` only routes a STRING instruction through
// `injectSessionState` (`requireStateInjection: true`, verified against the
// installed 1.3.0 source at agents/llm_agent.js +
// agents/processors/instructions_llm_request_processor.js); a function
// instruction (`InstructionProvider`) sets `requireStateInjection: false` and
// is never substituted. Our preamble embeds user-authored conversation
// content, so a STRING-instruction agent crashes on a turn whose input
// contains `{anything}`-shaped text. These tests drive the REAL @google/adk
// `LlmAgent` + `InMemoryRunner` runtime loop (a fake `BaseLlm` subclass
// stands in for the network call, so nothing here hits a real model) — the
// crash is reproducible in-harness, not just a type-level claim.

async function buildRealAgentWithInstruction(instruction: string | (() => string)): Promise<object> {
  const RealAdk = await import("@google/adk");
  class FakeLlm extends RealAdk.BaseLlm {
    async *generateContentAsync(_llmRequest: LlmRequest): AsyncGenerator<LlmResponse, void> {
      yield { content: { role: "model", parts: [{ text: "fake reply" }] } };
    }
    async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
      throw new Error("connect() not used in this test — streamingMode 'sse' never calls it");
    }
  }
  return new RealAdk.LlmAgent({
    name: "guuey",
    model: new FakeLlm({ model: "fake-model" }),
    instruction,
    tools: [],
  });
}

const BRACE_TURN: HostTurn = {
  ...TURN,
  input: "please format the answer as {anything} for me",
};
const BRACE_PREAMBLE = withContextPreamble(
  "Be terse.",
  [{ role: "user", text: "please format the answer as {anything} for me" }],
  undefined,
  undefined,
);

describe("F7 — instruction as function bypasses ADK's {var} substitution (real SDK)", () => {
  it("STRING instruction throws Context-variable-not-found on {anything} user content (RED)", async () => {
    const agent = await buildRealAgentWithInstruction(BRACE_PREAMBLE);
    const adk = await loadAdk();
    const { emit, got } = fakeEmitter();
    await runAdkTurn(adk, agent, BRACE_TURN, emit, "1.3.0");
    expect(got.error).toHaveLength(1);
    expect(got.error[0]).toMatch(/Context variable not found.*anything/);
    expect(got.done).toHaveLength(0);
  });

  it("FUNCTION instruction survives the same {anything} user content (GREEN)", async () => {
    const agent = await buildRealAgentWithInstruction(() => BRACE_PREAMBLE);
    const adk = await loadAdk();
    const { emit, got } = fakeEmitter();
    await runAdkTurn(adk, agent, BRACE_TURN, emit, "1.3.0");
    expect(got.error).toEqual([]);
    expect(got.done[0]?.result).toBe("fake reply");
  });
});

// ── final-text extraction ────────────────────────────────────────────────────

describe("finalTextOf", () => {
  it("skips thought parts and empty strings; keeps the last real text", () => {
    expect(finalTextOf({ content: { parts: [{ text: "a" }, { text: "b", thought: true }, { text: "c" }] } })).toBe(
      "c",
    );
    expect(finalTextOf({ content: { parts: [{ thought: true, text: "only thought" }] } })).toBe("");
    expect(finalTextOf({ content: null })).toBe("");
    expect(finalTextOf("not an object")).toBe("");
    expect(finalTextOf({ content: { parts: "nope" } })).toBe("");
  });
});

// ── single-copy resolution + missing peer ────────────────────────────────────

describe("loadAdk — resolution order", () => {
  const base = mkdtempSync(join(tmpdir(), "adk-copy-test-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("with an entryPath, resolves @google/adk from the ENTRY's own tree (the dev's copy wins)", async () => {
    // A fake worker tree: /worker/agent.js + /worker/node_modules/@google/adk
    const worker = join(base, "worker");
    const adkDir = join(worker, "node_modules", "@google", "adk");
    mkdirSync(adkDir, { recursive: true });
    writeFileSync(
      join(adkDir, "package.json"),
      JSON.stringify({ name: "@google/adk", version: "9.9.9-fixture", main: "./index.js", type: "module" }),
    );
    writeFileSync(join(adkDir, "index.js"), 'export const COPY_MARKER = "dev-tree-copy";\n');
    writeFileSync(join(worker, "agent.js"), "export default {};\n");

    const mod = (await loadAdk(join(worker, "agent.js"))) as unknown as { COPY_MARKER?: string };
    expect(mod.COPY_MARKER).toBe("dev-tree-copy");
  });

  it("with an entryPath whose tree cannot resolve the SDK, fails with the actionable missing-peer error", async () => {
    // A deterministic unresolvable: the package EXISTS but its exports map
    // points at a missing file — a FINAL resolution error under plain node
    // AND under vitest (whose resolver adds an ambient workspace fallback for
    // bare not-found specifiers that plain Node does not have).
    const bare = join(base, "bare");
    const broken = join(bare, "node_modules", "@google", "adk");
    mkdirSync(broken, { recursive: true });
    writeFileSync(
      join(broken, "package.json"),
      JSON.stringify({ name: "@google/adk", version: "0.0.0", exports: { ".": "./does-not-exist.js" } }),
    );
    writeFileSync(join(bare, "agent.js"), "export default {};\n");
    await expect(loadAdk(join(bare, "agent.js"))).rejects.toThrow(/optional peer.*Install @google\/adk/s);
  });
});
