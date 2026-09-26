/**
 * The Router's per-turn `withheldTools` reach the OpenAI Agents SDK at the
 * ASSEMBLY: `runInvokeOpenai` builds each MCP server from the listed credential
 * files, and a server named by a withhold gets a static `toolFilter` that
 * blocks exactly those tools. The SDK applies `toolFilter` when it lists the
 * server's tools for the model (`getMcpToolsFromServer`).
 *
 * `MCPServerStreamableHttp` is the real class, subclassed only to record the
 * options it was built with and to skip the network on connect/close.
 */
import { describe, expect, it, vi } from "vitest";
import { createEmitter, type WorkerEvent } from "@guuey/worker";
import type { HostInvoke } from "./claude.js";

const h = vi.hoisted(() => ({ built: [] as Array<{ name: string | undefined; toolFilter: unknown }> }));

vi.mock("@openai/agents", async (importOriginal) => {
  const real = await importOriginal<typeof import("@openai/agents")>();
  class RecordingServer extends real.MCPServerStreamableHttp {
    constructor(options: ConstructorParameters<typeof real.MCPServerStreamableHttp>[0]) {
      super(options);
      h.built.push({ name: options.name, toolFilter: options.toolFilter });
    }
    override async connect(): Promise<void> {}
    override async close(): Promise<void> {}
  }
  return { ...real, MCPServerStreamableHttp: RecordingServer };
});

import { runInvokeOpenai, type OpenaiRunFn } from "./openai.js";

const gguiCred = { name: "ggui", cred: { url: "https://mcp.example/apps/x", transport: "http" as const, headers: {} } };
const snapshot = { framework: "openai-agents-sdk" as const, model: "gpt-4o-mini", systemPrompt: "SYS", mcpServers: {} };

function invoke(over: Partial<HostInvoke> = {}): HostInvoke {
  return {
    input: "hi",
    identity: { userId: "u1", authMode: "anonymous" },
    fs: { app: "/fs/app", home: "/fs/home", session: "/fs/session" },
    history: [],
    ...over,
  };
}

async function serversBuiltFor(
  over: Partial<HostInvoke>,
  tools?: { allowlist?: string[]; denylist?: string[] },
): Promise<Array<{ name: string | undefined; toolFilter: unknown }>> {
  h.built.length = 0;
  const events: WorkerEvent[] = [];
  const emit = createEmitter({
    write(s: string) {
      for (const line of s.split("\n")) {
        if (line.trim().length > 0) events.push(JSON.parse(line) as WorkerEvent);
      }
    },
  });
  const run: OpenaiRunFn = () =>
    Promise.resolve({
      async *[Symbol.asyncIterator]() {},
      completed: Promise.resolve(),
      finalOutput: "ok",
    });
  await runInvokeOpenai({ ...snapshot, ...(tools !== undefined ? { tools } : {}) }, invoke(over), { apiKey: "sk-openai-test", listCredentials: () => [gguiCred] }, emit, run);
  expect(events.some((e) => e.type === "error")).toBe(false);
  return [...h.built];
}

/** The tool names of `candidates` the built server's filter keeps (the SDK calls it with a context and the tool). */
async function keptBy(toolFilter: unknown, candidates: readonly string[] = ["ggui_render", "ggui_consume", "ggui_handshake"]): Promise<string[]> {
  if (typeof toolFilter !== "function") throw new Error(`expected a callable toolFilter, got ${JSON.stringify(toolFilter)}`);
  const kept: string[] = [];
  for (const name of candidates) {
    if ((await Reflect.apply(toolFilter, undefined, [{ serverName: "ggui" }, { name }])) === true) kept.push(name);
  }
  return kept;
}

describe("withheldTools — the Router's per-turn withholds reach the OpenAI MCP servers", () => {
  it("the named server blocks exactly the withheld tool", async () => {
    const built = await serversBuiltFor({ gguiAttached: true, withheldTools: [{ server: "ggui", tool: "ggui_consume" }] });
    expect(built.map((b) => b.name)).toEqual(["ggui"]);
    expect(await keptBy(built[0]!.toolFilter)).toEqual(["ggui_render", "ggui_handshake"]);
  });

  it("no withheld tools → the filter keeps every tool the model may call (today's catalog)", async () => {
    const built = await serversBuiltFor({ gguiAttached: true });
    expect(built.map((b) => b.name)).toEqual(["ggui"]);
    expect(await keptBy(built[0]!.toolFilter)).toEqual(["ggui_render", "ggui_consume", "ggui_handshake"]);
  });

  it("a withhold naming another server removes nothing here", async () => {
    const built = await serversBuiltFor({ withheldTools: [{ server: "elsewhere", tool: "ggui_consume" }] });
    expect(await keptBy(built[0]!.toolFilter)).toEqual(["ggui_render", "ggui_consume", "ggui_handshake"]);
  });
});

describe("the builder's tool gates reach the OpenAI MCP servers (guuey#1768), allowlist then denylist then withholds", () => {
  it("allowlist <server>.<tool>: that tool is the only one kept on its server", async () => {
    const built = await serversBuiltFor({}, { allowlist: ["ggui.ggui_render"] });
    expect(await keptBy(built[0]!.toolFilter)).toEqual(["ggui_render"]);
  });

  it("an allowlist that names only another server keeps nothing on this one", async () => {
    const built = await serversBuiltFor({}, { allowlist: ["other.ggui_render"] });
    expect(await keptBy(built[0]!.toolFilter)).toEqual([]);
  });

  it("allowlist <server>.* keeps the server whole; a bare name keeps that tool", async () => {
    expect(await keptBy((await serversBuiltFor({}, { allowlist: ["ggui.*"] }))[0]!.toolFilter)).toEqual(["ggui_render", "ggui_consume", "ggui_handshake"]);
    expect(await keptBy((await serversBuiltFor({}, { allowlist: ["ggui_consume"] }))[0]!.toolFilter)).toEqual(["ggui_consume"]);
  });

  it("denylist <server>.<tool> or a bare name removes that tool; <server>.* removes every tool", async () => {
    expect(await keptBy((await serversBuiltFor({}, { denylist: ["ggui.ggui_consume"] }))[0]!.toolFilter)).toEqual(["ggui_render", "ggui_handshake"]);
    expect(await keptBy((await serversBuiltFor({}, { denylist: ["ggui_consume"] }))[0]!.toolFilter)).toEqual(["ggui_render", "ggui_handshake"]);
    expect(await keptBy((await serversBuiltFor({}, { denylist: ["ggui.*"] }))[0]!.toolFilter)).toEqual([]);
  });

  it("the three compose: allowlist, then denylist, then this turn's withhold", async () => {
    const built = await serversBuiltFor(
      { withheldTools: [{ server: "ggui", tool: "ggui_handshake" }] },
      { allowlist: ["ggui.*"], denylist: ["ggui.ggui_consume"] },
    );
    expect(await keptBy(built[0]!.toolFilter)).toEqual(["ggui_render"]);
  });
});
