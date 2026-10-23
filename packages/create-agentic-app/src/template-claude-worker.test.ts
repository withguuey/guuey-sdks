/**
 * guuey#2139: the Claude code-mode worker the scaffold ships
 * (`templates-src/frameworks/claude-agent-sdk/src/worker.ts`) hands the model
 * key to the CLI only through the private-descriptor spawner and its MCP
 * servers only over stdin (`setMcpServers`): the query options carry no
 * credential in `env`, no `mcpServers` (the SDK would put their headers on the
 * CLI's argv), and the user message waits for the servers.
 *
 * Driven for real like the OpenAI template test: `serveNative` is replaced to
 * capture the handler and the Claude Agent SDK's `query` to capture what the
 * worker hands it. Synthetic values only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GuueyAgent } from "@guuey/config";
import type { ClaudeSpawnRequest, ClaudeSpawnedProcess, Invoke, NativeEmit, NativeHandler, WithheldTool } from "@guuey/worker";

/** The slice of the SDK's query options this test reads. */
interface CapturedOptions {
  env?: Record<string, string>;
  mcpServers?: object;
  persistSession?: boolean;
  spawnClaudeCodeProcess?: (request: ClaudeSpawnRequest) => ClaudeSpawnedProcess;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  canUseTool?: (toolName: string, input: { k: string }) => Promise<{ behavior: string; message?: string }>;
}

interface CapturedQuery {
  options: CapturedOptions;
  setMcpServers: Array<Record<string, { headers?: Record<string, string> }>>;
  promptPulledAfterSet: boolean;
  messageSent: boolean;
  closed: boolean;
}

const h = vi.hoisted(() => ({
  handler: undefined as NativeHandler | undefined,
  queries: [] as CapturedQuery[],
  /** `hang`: the CLI never answers `setMcpServers` (a CLI that started but answers nothing). */
  mode: "answer" as "answer" | "hang",
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { prompt: AsyncIterable<object>; options: CapturedOptions }) => {
    const captured: CapturedQuery = {
      options: params.options,
      setMcpServers: [],
      promptPulledAfterSet: false,
      messageSent: false,
      closed: false,
    };
    h.queries.push(captured);
    return {
      setMcpServers: (servers: Record<string, { headers?: Record<string, string> }>) => {
        captured.setMcpServers.push(servers);
        if (h.mode === "hang") return new Promise<never>(() => {});
        return Promise.resolve({ added: Object.keys(servers), removed: [], errors: {} });
      },
      mcpServerStatus: async () => [],
      close: () => {
        captured.closed = true;
      },
      async *[Symbol.asyncIterator]() {
        for await (const _message of params.prompt) {
          captured.messageSent = true;
          captured.promptPulledAfterSet = captured.setMcpServers.length === 1;
          yield { type: "result", subtype: "success", result: "ok" };
        }
      },
    };
  },
}));

vi.mock("@guuey/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@guuey/worker")>()),
  serveNative: async (handler: NativeHandler) => {
    h.handler = handler;
  },
}));

const WORKER_ENTRY = new URL("../templates-src/frameworks/claude-agent-sdk/src/worker.ts", import.meta.url).href;
const agent: GuueyAgent = { mcpServers: {} };
const dirs: string[] = [];
const emit: NativeEmit = { native: () => {}, text: () => {}, suspend: () => "not_offered", endThread: () => "not_offered" };

beforeAll(async () => {
  vi.stubEnv("GUUEY_AGENT_SNAPSHOT", JSON.stringify(agent));
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "legacy-env-token");
  vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=64");
  vi.spyOn(console, "log").mockImplementation(() => {});
  await import(WORKER_ENTRY);
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function invokeWithServer(servers: readonly string[] = ["todo"], withheldTools?: WithheldTool[]): Invoke {
  const root = mkdtempSync(join(tmpdir(), "caa-claude-worker-"));
  dirs.push(root);
  const session = join(root, "session");
  const credentials = join(session, ".guuey", "credentials");
  mkdirSync(credentials, { recursive: true });
  for (const name of servers) {
    writeFileSync(
      join(credentials, `${name}.json`),
      JSON.stringify({ url: "http://127.0.0.1:6782/mcp", transport: "http", headers: { authorization: "Bearer mcp-header" } }),
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

describe("Claude template worker: private key and MCP delivery (guuey#2139)", () => {
  it("passes no credential or inspector variable in env, no mcpServers option, a spawner, and the servers over stdin first", async () => {
    if (h.handler === undefined) throw new Error("the worker entry never called serveNative");
    expect(await h.handler(invokeWithServer(), emit)).toBe("ok");
    const q = h.queries.at(-1);
    if (q === undefined) throw new Error("no query");
    expect(q.options.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(q.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(q.options.env?.NODE_OPTIONS).toBeUndefined();
    expect(Object.values(q.options.env ?? {})).not.toContain("legacy-env-token");
    expect(q.options.mcpServers).toBeUndefined();
    expect(q.options.spawnClaudeCodeProcess).toBeTypeOf("function");
    expect(Object.keys(q.setMcpServers[0] ?? {})).toEqual(["todo"]);
    expect(q.promptPulledAfterSet).toBe(true);
  });

  it("turns off CLI session persistence, so no transcript lands in the end user's durable home", async () => {
    if (h.handler === undefined) throw new Error("the worker entry never called serveNative");
    expect(await h.handler(invokeWithServer(), emit)).toBe("ok");
    const q = h.queries.at(-1);
    if (q === undefined) throw new Error("no query");
    expect(q.options.persistSession).toBe(false);
  });

  it("a CLI that never answers setMcpServers fails the turn at the startup deadline: query closed, no user message", async () => {
    if (h.handler === undefined) throw new Error("the worker entry never called serveNative");
    vi.useFakeTimers();
    h.mode = "hang";
    try {
      const turn = Promise.resolve(h.handler(invokeWithServer(), emit));
      const outcome = turn.then(
        () => "resolved",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      await vi.advanceTimersByTimeAsync(59_999);
      const q = h.queries.at(-1);
      if (q === undefined) throw new Error("no query");
      expect(q.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toContain("no answer to setMcpServers within 60000 ms");
      expect(q.closed).toBe(true);
      expect(q.messageSent).toBe(false);
    } finally {
      h.mode = "answer";
      vi.useRealTimers();
    }
  });
});

describe("Claude template worker: the agent's tool gates reach query() (guuey#2585)", () => {
  /** Runs one invoke with `tools` as the agent's gate block and returns the options handed to query(). */
  async function optionsFor(tools: GuueyAgent["tools"], withheldTools?: WithheldTool[]): Promise<CapturedOptions> {
    if (h.handler === undefined) throw new Error("the worker entry never called serveNative");
    vi.stubEnv("GUUEY_AGENT_SNAPSHOT", JSON.stringify({ ...agent, ...(tools !== undefined ? { tools } : {}) }));
    try {
      expect(await h.handler(invokeWithServer(["ggui", "todo"], withheldTools), emit)).toBe("ok");
    } finally {
      vi.stubEnv("GUUEY_AGENT_SNAPSHOT", JSON.stringify(agent));
    }
    const q = h.queries.at(-1);
    if (q === undefined) throw new Error("no query");
    return q.options;
  }

  async function verdict(options: CapturedOptions, tool: string): Promise<string | undefined> {
    if (options.canUseTool === undefined) throw new Error("no canUseTool");
    return (await options.canUseTool(tool, { k: "v" })).behavior;
  }

  it("no gates: every server allowed whole, nothing disallowed, every pick allowed (never the ask stage)", async () => {
    const options = await optionsFor(undefined);
    expect(options.allowedTools).toEqual(["mcp__ggui", "mcp__todo"]);
    expect(options.disallowedTools).toBeUndefined();
    expect(options.permissionMode).toBeUndefined();
    expect(await verdict(options, "mcp__todo__add")).toBe("allow");
  });

  it("an allowlist is translated into SDK rules (never passed verbatim), and an unlisted pick is denied", async () => {
    const options = await optionsFor({ allowlist: ["todo.add", "ggui.*"] });
    expect(options.allowedTools).toEqual(["mcp__todo__add", "mcp__ggui"]);
    expect(await verdict(options, "mcp__todo__clear")).toBe("deny");
  });

  it("a stored allowlist: [] keeps its every-tool meaning", async () => {
    const options = await optionsFor({ allowlist: [] });
    expect(options.allowedTools).toEqual(["mcp__ggui", "mcp__todo"]);
    expect(await verdict(options, "mcp__todo__clear")).toBe("allow");
  });

  it("the denylist and the turn's withholds ride disallowedTools: deny wins over the allowlist", async () => {
    const options = await optionsFor(
      { allowlist: ["todo.*"], denylist: ["todo.clear"] },
      [{ server: "todo", tool: "export" }],
    );
    expect(options.allowedTools).toEqual(["mcp__todo"]);
    expect(options.disallowedTools).toEqual(["mcp__todo__clear", "mcp__todo__export"]);
  });

  it("an unreadable denylist entry: no MCP tool, a denial naming the entry, and one [guuey] line on stderr", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const options = await optionsFor({ denylist: ["mcp__todo__clear"] });
      expect(options.allowedTools).toEqual([]);
      expect(options.disallowedTools).toEqual(["mcp__ggui", "mcp__todo"]);
      if (options.canUseTool === undefined) throw new Error("no canUseTool");
      const denied = await options.canUseTool("mcp__todo__add", { k: "v" });
      expect(denied.behavior).toBe("deny");
      expect(denied.message).toContain('"mcp__todo__clear"');
      expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringMatching(/^\[guuey\] tools\.denylist entry "mcp__todo__clear" cannot be read/),
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  it('["@none"]: no MCP allow rule, every server disallowed, every pick denied', async () => {
    const options = await optionsFor({ allowlist: ["@none"] });
    expect(options.allowedTools).toEqual([]);
    expect(options.disallowedTools).toEqual(["mcp__ggui", "mcp__todo"]);
    expect(await verdict(options, "mcp__todo__add")).toBe("deny");
  });
});
