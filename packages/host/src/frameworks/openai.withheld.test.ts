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

async function serversBuiltFor(over: Partial<HostInvoke>): Promise<Array<{ name: string | undefined; toolFilter: unknown }>> {
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
  await runInvokeOpenai(snapshot, invoke(over), { apiKey: "sk-openai-test", listCredentials: () => [gguiCred] }, emit, run);
  expect(events.some((e) => e.type === "error")).toBe(false);
  return [...h.built];
}

describe("withheldTools — the Router's per-turn withholds reach the OpenAI MCP servers", () => {
  it("the named server blocks exactly the withheld tool", async () => {
    const built = await serversBuiltFor({ gguiAttached: true, withheldTools: [{ server: "ggui", tool: "ggui_consume" }] });
    expect(built).toEqual([{ name: "ggui", toolFilter: { blockedToolNames: ["ggui_consume"] } }]);
  });

  it("no withheld tools → the server is built with no filter (today's catalog)", async () => {
    const built = await serversBuiltFor({ gguiAttached: true });
    expect(built).toEqual([{ name: "ggui", toolFilter: undefined }]);
  });

  it("a withhold naming another server leaves this one unfiltered", async () => {
    const built = await serversBuiltFor({ withheldTools: [{ server: "elsewhere", tool: "ggui_consume" }] });
    expect(built).toEqual([{ name: "ggui", toolFilter: undefined }]);
  });
});
