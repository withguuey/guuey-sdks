/**
 * Behavioural test for the OpenAI code-mode worker the scaffold ships
 * (`templates-src/frameworks/openai-agents-sdk/src/worker.ts`). That worker
 * builds its own `MCPServerStreamableHttp` per endpoint, so it (not the host)
 * must apply the turn's tool withholds (`Invoke.withheldTools`): each server's
 * `toolFilter` drops the tools withheld on THAT server, on top of MCP Apps
 * visibility.
 *
 * The worker entry is driven for real: `serveNative` is replaced to capture
 * its handler, `@openai/agents` is replaced to capture each server's options,
 * and an invoke is run through the captured handler with a credential
 * directory on disk (the platform's way of naming the servers). Everything
 * else in `@guuey/worker` is the real code.
 *
 * `@openai/agents` is the scaffolded app's dependency, not this package's, so
 * the entry is imported by URL: this package's `tsc` does not compile it here.
 * The scaffold smoke type-checks and builds the template against the real SDK.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuueyAgent } from "@guuey/config";
import type { Invoke, NativeEmit, NativeHandler, WithheldTool } from "@guuey/worker";

/** A listed MCP tool, as the Agents SDK hands it to a `toolFilter`. */
interface ListedTool {
  name: string;
  inputSchema: { type: "object" };
  _meta?: { ui: { visibility: string[] } };
}

/** The `MCPServerStreamableHttp` options this test reads. */
interface ServerOptions {
  name: string;
  url: string;
  toolFilter?: (context: object, tool: ListedTool) => Promise<boolean>;
}

const h = vi.hoisted(() => ({
  handler: undefined as NativeHandler | undefined,
  servers: [] as ServerOptions[],
  defaultKeys: [] as string[],
}));

vi.mock("@openai/agents", () => ({
  MCPServerStreamableHttp: class {
    constructor(options: ServerOptions) {
      h.servers.push(options);
    }
    async connect(): Promise<void> {}
    async close(): Promise<void> {}
  },
  Agent: class {},
  MaxTurnsExceededError: class extends Error {},
  setDefaultOpenAIKey: (key: string) => {
    h.defaultKeys.push(key);
  },
  run: async () => ({
    async *[Symbol.asyncIterator]() {},
    completed: Promise.resolve(),
    finalOutput: "ok",
  }),
}));

vi.mock("@guuey/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@guuey/worker")>()),
  serveNative: async (handler: NativeHandler) => {
    h.handler = handler;
  },
}));

const WORKER_ENTRY = new URL(
  "../templates-src/frameworks/openai-agents-sdk/src/worker.ts",
  import.meta.url
).href;

const agent: GuueyAgent = { mcpServers: {} };

const consume: ListedTool = { name: "ggui_consume", inputSchema: { type: "object" } };
const render: ListedTool = {
  name: "ggui_render",
  inputSchema: { type: "object" },
  _meta: { ui: { visibility: ["model", "app"] } },
};
const appOnly: ListedTool = {
  name: "ggui_runtime_submit_action",
  inputSchema: { type: "object" },
  _meta: { ui: { visibility: ["app"] } },
};

const dirs: string[] = [];
const emit: NativeEmit = { native: () => {}, text: () => {}, suspend: () => "not_offered", endThread: () => "not_offered" };

beforeAll(async () => {
  vi.stubEnv("GUUEY_AGENT_SNAPSHOT", JSON.stringify(agent));
  vi.stubEnv("OPENAI_API_KEY", "legacy-env-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  await import(WORKER_ENTRY);
});

beforeEach(() => {
  h.servers.length = 0;
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** An invoke whose credential directory names two servers, `ggui` and `todo`. */
function invokeWith(withheldTools: WithheldTool[] | undefined): Invoke {
  const root = mkdtempSync(join(tmpdir(), "caa-openai-worker-"));
  dirs.push(root);
  const session = join(root, "session");
  const credentials = join(session, ".guuey", "credentials");
  mkdirSync(credentials, { recursive: true });
  for (const [name, url] of [
    ["ggui", "https://mcp.example/apps/app_1"],
    ["todo", "http://127.0.0.1:6782/mcp"],
  ]) {
    writeFileSync(
      join(credentials, `${name}.json`),
      JSON.stringify({ url, transport: "http", headers: {} }),
      "utf8"
    );
  }
  return {
    type: "invoke",
    input: "hello",
    identity: { userId: "u_1", authMode: "anonymous" },
    fs: { app: join(root, "app"), home: join(root, "home"), session },
    history: [],
    ...(withheldTools !== undefined ? { withheldTools } : {}),
  };
}

/** Runs one invoke through the worker and returns each built server's filter by name. */
async function builtFilters(
  invoke: Invoke
): Promise<Map<string, NonNullable<ServerOptions["toolFilter"]>>> {
  if (h.handler === undefined) throw new Error("the worker entry never called serveNative");
  expect(await h.handler(invoke, emit)).toBe("ok");
  const filters = new Map<string, NonNullable<ServerOptions["toolFilter"]>>();
  for (const server of h.servers) {
    if (server.toolFilter === undefined)
      throw new Error(`server ${server.name} was built without a toolFilter`);
    filters.set(server.name, server.toolFilter);
  }
  expect([...filters.keys()].sort()).toEqual(["ggui", "todo"]);
  return filters;
}

describe("OpenAI template worker: the turn's tool withholds", () => {
  it("drops ggui_consume from the ggui server when the invoke withholds it there", async () => {
    const filters = await builtFilters(invokeWith([{ server: "ggui", tool: "ggui_consume" }]));
    const ggui = filters.get("ggui");
    if (ggui === undefined) throw new Error("no ggui server");
    expect(await ggui({}, consume)).toBe(false);
    expect(await ggui({}, render)).toBe(true);
  });

  it("leaves a tool of the same name on another server", async () => {
    const filters = await builtFilters(invokeWith([{ server: "ggui", tool: "ggui_consume" }]));
    const todo = filters.get("todo");
    if (todo === undefined) throw new Error("no todo server");
    expect(await todo({}, consume)).toBe(true);
  });

  it("keeps the full catalog when nothing is withheld, and applies MCP Apps visibility either way", async () => {
    const open = await builtFilters(invokeWith(undefined));
    const ggui = open.get("ggui");
    if (ggui === undefined) throw new Error("no ggui server");
    expect(await ggui({}, consume)).toBe(true);
    expect(await ggui({}, appOnly)).toBe(false);

    const withheld = await builtFilters(invokeWith([{ server: "ggui", tool: "ggui_consume" }]));
    const gguiWithheld = withheld.get("ggui");
    if (gguiWithheld === undefined) throw new Error("no ggui server");
    expect(await gguiWithheld({}, appOnly)).toBe(false);
  });
});

describe("OpenAI template worker: the agent's tool gates (guuey#2585)", () => {
  const search: ListedTool = { name: "search", inputSchema: { type: "object" } };

  /** Runs one invoke with `tools` as the agent's gate block; returns the tools each server offers the model. */
  async function offeredWith(
    tools: GuueyAgent["tools"],
    withheldTools?: WithheldTool[]
  ): Promise<Record<string, string[]>> {
    vi.stubEnv("GUUEY_AGENT_SNAPSHOT", JSON.stringify({ ...agent, ...(tools !== undefined ? { tools } : {}) }));
    try {
      const filters = await builtFilters(invokeWith(withheldTools));
      const out: Record<string, string[]> = {};
      for (const [server, filter] of filters) {
        out[server] = [];
        for (const tool of [consume, render, appOnly, search]) {
          if (await filter({}, tool)) out[server].push(tool.name);
        }
      }
      return out;
    } finally {
      vi.stubEnv("GUUEY_AGENT_SNAPSHOT", JSON.stringify(agent));
    }
  }

  it("no gates: every model-visible tool on every server", async () => {
    expect(await offeredWith(undefined)).toEqual({
      ggui: ["ggui_consume", "ggui_render", "search"],
      todo: ["ggui_consume", "ggui_render", "search"],
    });
  });

  it("an allowlist narrows each server; a server the list never names keeps nothing", async () => {
    expect(await offeredWith({ allowlist: ["ggui.ggui_render", "search"] })).toEqual({
      ggui: ["ggui_render", "search"],
      todo: ["search"],
    });
  });

  it("the denylist subtracts and wins over the allowlist; withholds subtract too", async () => {
    expect(
      await offeredWith({ allowlist: ["ggui.*"], denylist: ["ggui.ggui_consume"] }, [{ server: "ggui", tool: "search" }])
    ).toEqual({ ggui: ["ggui_render"], todo: [] });
    expect(await offeredWith({ denylist: ["search", "todo.*"] })).toEqual({
      ggui: ["ggui_consume", "ggui_render"],
      todo: [],
    });
  });

  it('["@none"] offers nothing; a stored [] offers everything', async () => {
    expect(await offeredWith({ allowlist: ["@none"] })).toEqual({ ggui: [], todo: [] });
    expect(await offeredWith({ allowlist: [] })).toEqual({
      ggui: ["ggui_consume", "ggui_render", "search"],
      todo: ["ggui_consume", "ggui_render", "search"],
    });
  });

  it("an unreadable denylist entry offers nothing on any server and names the entry on stderr", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await offeredWith({ denylist: ["mcp__ggui__ggui_consume"] })).toEqual({ ggui: [], todo: [] });
      expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringMatching(/^\[guuey\] tools\.denylist entry "mcp__ggui__ggui_consume" cannot be read/),
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  it("MCP Apps visibility still applies under an allowlist that names the app-only tool", async () => {
    expect(await offeredWith({ allowlist: ["ggui.ggui_runtime_submit_action"] })).toEqual({ ggui: [], todo: [] });
  });
});

describe("OpenAI template worker: the model key (guuey#2139)", () => {
  it("applies the key in memory with setDefaultOpenAIKey (no launch envelope: the legacy env key)", () => {
    expect(h.defaultKeys).toEqual(["legacy-env-key"]);
  });
});
