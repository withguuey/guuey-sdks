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
import type { ClaudeSpawnRequest, ClaudeSpawnedProcess, Invoke, NativeEmit, NativeHandler } from "@guuey/worker";

/** The slice of the SDK's query options this test reads. */
interface CapturedOptions {
  env?: Record<string, string>;
  mcpServers?: object;
  spawnClaudeCodeProcess?: (request: ClaudeSpawnRequest) => ClaudeSpawnedProcess;
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
const emit: NativeEmit = { native: () => {}, text: () => {} };

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

function invokeWithServer(): Invoke {
  const root = mkdtempSync(join(tmpdir(), "caa-claude-worker-"));
  dirs.push(root);
  const session = join(root, "session");
  const credentials = join(session, ".guuey", "credentials");
  mkdirSync(credentials, { recursive: true });
  writeFileSync(
    join(credentials, "todo.json"),
    JSON.stringify({ url: "http://127.0.0.1:6782/mcp", transport: "http", headers: { authorization: "Bearer mcp-header" } }),
  );
  return {
    type: "invoke",
    input: "hello",
    identity: { userId: "u_1", authMode: "anonymous" },
    fs: { app: join(root, "app"), home: join(root, "home"), session },
    history: [],
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
