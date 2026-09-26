/**
 * MCP Apps (SEP-1865) tool visibility on the OpenAI and ADK adapters: a tool
 * whose `_meta.ui.visibility` does not include "model" (or cannot be read) is
 * never in the model's catalog. The rule is tested on its own, then THROUGH
 * each SDK's real listing path, so an SDK upgrade that stops handing the
 * listed tool's `_meta` to the filter reds here instead of re-offering the
 * app's tools to the model.
 */
import { describe, expect, it, vi } from "vitest";
import { createEmitter, modelMayCallTool, modelVisibleToolFilter, type WorkerEvent } from "@guuey/worker";
import { modelToolFilterFor } from "./mcp-tool-gates.js";
import type { HostInvoke } from "./frameworks/claude.js";

const appOnly = { name: "ggui_runtime_submit_action", inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false }, _meta: { ui: { visibility: ["app"] } } };
const modelAndApp = { name: "ggui_render", inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false }, _meta: { ui: { resourceUri: "ui://x", visibility: ["model", "app"] } } };
const plain = { name: "ggui_handshake", inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false } };

describe("modelMayCallTool — the SEP-1865 rule", () => {
  it("absent _meta, ui or visibility is the default: the model may call it", () => {
    expect(modelMayCallTool(plain)).toBe(true);
    expect(modelMayCallTool({ name: "t", _meta: {} })).toBe(true);
    expect(modelMayCallTool({ name: "t", _meta: { ui: { resourceUri: "ui://x" } } })).toBe(true);
    expect(modelMayCallTool({ name: "t", _meta: { "ai.ggui/other": 1 } })).toBe(true);
  });

  it("a visibility that includes model keeps it; one that omits model hides it", () => {
    expect(modelMayCallTool(modelAndApp)).toBe(true);
    expect(modelMayCallTool({ name: "t", _meta: { ui: { visibility: ["model"] } } })).toBe(true);
    expect(modelMayCallTool(appOnly)).toBe(false);
    expect(modelMayCallTool({ name: "t", _meta: { ui: { visibility: [] } } })).toBe(false);
  });

  it("modelVisibleToolFilter (the code-mode worker's callable) applies the same rule", async () => {
    expect(await modelVisibleToolFilter({}, appOnly)).toBe(false);
    expect(await modelVisibleToolFilter({}, modelAndApp)).toBe(true);
    expect(await modelVisibleToolFilter({}, plain)).toBe(true);
  });

  it("a visibility that cannot be read hides it (never read as the default)", () => {
    expect(modelMayCallTool({ name: "t", _meta: { ui: { visibility: "model" } } })).toBe(false);
    expect(modelMayCallTool({ name: "t", _meta: { ui: { visibility: ["model", 7] } } })).toBe(false);
    expect(modelMayCallTool({ name: "t", _meta: { ui: "model" } })).toBe(false);
    expect(modelMayCallTool({ name: "t", _meta: { ui: ["model"] } })).toBe(false);
  });
});

describe("modelToolFilterFor — visibility first, then the gates and withholds", () => {
  it("is a filter for every server, gated or not", () => {
    const keep = modelToolFilterFor("ggui", undefined);
    expect(keep(plain.name, plain)).toBe(true);
    expect(keep(appOnly.name, appOnly)).toBe(false);
  });

  it("an allowlist cannot re-admit an app-only tool; a denylist still removes a model tool", () => {
    const allow = modelToolFilterFor("ggui", { allowlist: ["ggui.*"] });
    expect(allow(appOnly.name, appOnly)).toBe(false);
    const named = modelToolFilterFor("ggui", { allowlist: ["ggui.ggui_runtime_submit_action"] });
    expect(named(appOnly.name, appOnly)).toBe(false);
    const deny = modelToolFilterFor("ggui", { denylist: ["ggui.ggui_render"] });
    expect(deny(modelAndApp.name, modelAndApp)).toBe(false);
    expect(deny(plain.name, plain)).toBe(true);
    const withheld = modelToolFilterFor("ggui", undefined, [{ server: "ggui", tool: "ggui_handshake" }]);
    expect(withheld(plain.name, plain)).toBe(false);
  });
});

// ── ADK: the real MCPTool wrapper carries the listed tool the predicate reads ──
describe("ADK — the toolset predicate on real @google/adk MCPTool instances", () => {
  it("hides the app-only tool and keeps the others, reading the wrapper the SDK builds", async () => {
    const adk = await import("@google/adk");
    const { buildToolsets } = await import("./frameworks/google-adk.js");
    let predicate: ((tool: { readonly name: string }) => boolean) | undefined;
    buildToolsets(
      {
        MCPToolset: class {
          constructor(_params: object, toolFilter?: (tool: { readonly name: string }) => boolean) {
            predicate = toolFilter;
          }
        },
      },
      [{ name: "ggui", cred: { url: "https://mcp.example/apps/x", transport: "http", headers: {} } }],
    );
    if (predicate === undefined) throw new Error("every toolset must get the predicate");
    const sessions = new adk.MCPSessionManager({ type: "StreamableHTTPConnectionParams", url: "http://127.0.0.1:9/mcp" });
    const wrap = (tool: typeof appOnly | typeof modelAndApp | typeof plain) => new adk.MCPTool(tool, sessions, tool.name);
    expect(predicate(wrap(appOnly))).toBe(false);
    expect(predicate(wrap(modelAndApp))).toBe(true);
    expect(predicate(wrap(plain))).toBe(true);
    // A wrapper that does not expose the listed tool: visibility cannot be read, so it is kept from the model.
    expect(predicate({ name: "ggui_render" })).toBe(false);
  });
});

// ── OpenAI: the filter the adapter builds, through the SDK's own listing ──────
const h = vi.hoisted(() => ({ servers: [] as Array<{ toolFilter: unknown; server: object }> }));

vi.mock("@openai/agents", async (importOriginal) => {
  const real = await importOriginal<typeof import("@openai/agents")>();
  class ListingServer extends real.MCPServerStreamableHttp {
    constructor(options: ConstructorParameters<typeof real.MCPServerStreamableHttp>[0]) {
      super(options);
      h.servers.push({ toolFilter: options.toolFilter, server: this });
    }
    override async connect(): Promise<void> {}
    override async close(): Promise<void> {}
    /** The listing as the MCP SDK hands it to the Agents SDK: `_meta` included. */
    override async listTools(): Promise<Awaited<ReturnType<typeof real.MCPServerStreamableHttp.prototype.listTools>>> {
      return [appOnly, modelAndApp, plain];
    }
  }
  return { ...real, MCPServerStreamableHttp: ListingServer };
});

describe("OpenAI — the adapter's filter, applied by the Agents SDK's own tool listing", () => {
  it("the model's catalog omits the app-only tool and keeps the others", async () => {
    const agents = await import("@openai/agents");
    const { runInvokeOpenai } = await import("./frameworks/openai.js");
    h.servers.length = 0;
    const events: WorkerEvent[] = [];
    const emit = createEmitter({
      write(s: string) {
        for (const line of s.split("\n")) if (line.trim().length > 0) events.push(JSON.parse(line) as WorkerEvent);
      },
    });
    const invoke: HostInvoke = {
      input: "hi",
      identity: { userId: "u1", authMode: "anonymous" },
      fs: { app: "/fs/app", home: "/fs/home", session: "/fs/session" },
      history: [],
    };
    await runInvokeOpenai(
      { framework: "openai-agents-sdk", model: "gpt-4o-mini", systemPrompt: "SYS", mcpServers: {} },
      invoke,
      {
        apiKey: "sk-openai-test",
        listCredentials: () => [{ name: "ggui", cred: { url: "https://mcp.example/apps/x", transport: "http", headers: {} } }],
      },
      emit,
      () => Promise.resolve({ async *[Symbol.asyncIterator]() {}, completed: Promise.resolve(), finalOutput: "ok" }),
    );
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(h.servers).toHaveLength(1);
    const built = h.servers[0]!;
    if (!(built.server instanceof agents.MCPServerStreamableHttp)) throw new Error("not the SDK's server class");
    const tools = await agents.getAllMcpTools({
      mcpServers: [built.server],
      runContext: new agents.RunContext({}),
      agent: new agents.Agent({ name: "probe" }),
    });
    expect(tools.map((t) => t.name).sort()).toEqual(["ggui_handshake", "ggui_render"]);
  });
});
