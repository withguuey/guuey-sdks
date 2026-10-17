/**
 * guuey#2139: the real pinned Claude CLI, driven by
 * the real host turn loop (`runInvoke` + the SDK's `query`), against a fake
 * Anthropic upstream and a fake MCP server on loopback. Synthetic sentinels
 * only (`SENTINEL-2139-<random>`); assertions read booleans and counts, never
 * values, and no assertion message prints one.
 *
 *  - the key reaches the upstream (`x-api-key`), but no sentinel is in
 *    the CLI's argv, the CLI's initial environment (Linux), or the environment
 *    of the Bash child the CLI starts; no `.api_key` file appears; the CLI
 *    does not leave the key descriptor open as a regular file (Linux).
 *  - the MCP header reaches the fake MCP server, never the CLI argv,
 *    and the MCP tools are in the FIRST model request (turn-1 presence: a
 *    `deferConnect` flip fails here, not in production).
 *  - no sentinel in any file the turn left under the session dir
 *    (the credential directory excepted: that is the defined channel) or on
 *    the host's stderr.
 *  - an MCP server that never completes `initialize` — the turn goes on
 *    without it (the pinned CLI answers `setMcpServers` once its own 30 s MCP
 *    timeout marks the server failed, the same wait the old `--mcp-config`
 *    path had; the host's MCP-ready deadline, unit-tested in claude.test.ts,
 *    bounds a CLI that connects after answering), with exactly one CLI
 *    process, gone at the end, and no user message before the decision.
 *
 * Linux-only sub-assertions (procfs) are skipped elsewhere with that reason;
 * everything else runs on every platform the pinned CLI ships for.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { query as realQuery, type Options, type SDKUserMessage, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { createEmitter, type WorkerEvent } from "@guuey/worker";
import { runInvoke, type HostInvoke, type QueryFn, type QueryHandle } from "./claude.js";

const LINUX = process.platform === "linux";
const LINUX_ONLY = "procfs reads need Linux (/proc/<pid>/environ, /proc/<pid>/fd); macOS has no procfs";
const FIXTURE = fileURLToPath(new URL("./__fixtures__/bash-report.mjs", import.meta.url));
const MAIN_MARKER = "FAKE-UPSTREAM-MAIN-2139";
const TURN_BUDGET_MS = 90_000;

const sentinel = (): string => `SENTINEL-2139-${randomBytes(12).toString("hex")}`;

interface UpstreamRequest {
  path: string;
  main: boolean;
  apiKeyMatches: boolean;
  authorizationPresent: boolean;
  toolNames: string[];
  at: number;
}

interface MessagesBody {
  stream?: boolean;
  system?: unknown;
  tools?: Array<{ name?: string }>;
  messages?: Array<{ role: string; content: unknown }>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function hasToolResult(body: MessagesBody): boolean {
  return (body.messages ?? []).some(
    (m) => Array.isArray(m.content) && m.content.some((b: { type?: string }) => b.type === "tool_result"),
  );
}

function sse(res: ServerResponse, events: Array<{ event: string; data: object }>): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  res.end();
}

function messageStart(): { event: string; data: object } {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: `msg_${randomBytes(6).toString("hex")}`,
        type: "message",
        role: "assistant",
        model: "claude-fake",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  };
}

function textTurn(text: string): Array<{ event: string; data: object }> {
  return [
    messageStart(),
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

function bashTurn(command: string): Array<{ event: string; data: object }> {
  return [
    messageStart(),
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2139", name: "Bash", input: {} } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command, description: "report" }) } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

/** A fake Anthropic API. The main conversation (marked system prompt) runs the Bash report once, then answers. */
async function startFakeUpstream(key: string, bashCommand: string | undefined): Promise<{
  url: string;
  requests: UpstreamRequest[];
  close: () => Promise<void>;
}> {
  const requests: UpstreamRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const path = req.url ?? "";
      const apiKey = req.headers["x-api-key"];
      if (req.method === "GET" && path.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }));
        return;
      }
      if (path.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (!path.startsWith("/v1/messages")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(raw) as MessagesBody;
      const main = JSON.stringify(body.system ?? "").includes(MAIN_MARKER);
      requests.push({
        path,
        main,
        apiKeyMatches: apiKey === key,
        authorizationPresent: req.headers.authorization !== undefined,
        toolNames: (body.tools ?? []).map((t) => t.name ?? ""),
        at: Date.now(),
      });
      const events = main && bashCommand !== undefined && !hasToolResult(body) ? bashTurn(bashCommand) : textTurn("done");
      if (body.stream === true) {
        sse(res, events);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_plain",
          type: "message",
          role: "assistant",
          model: "claude-fake",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake upstream has no TCP address");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A fake Streamable-HTTP MCP server with one tool, `probe`. `hang` never answers `initialize`. */
async function startFakeMcp(header: string, mode: { delayMs: number; hang?: boolean }): Promise<{
  url: string;
  authMatches: () => boolean;
  initializeSeen: () => boolean;
  close: () => Promise<void>;
}> {
  let matched = false;
  let initialize = false;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      if (req.headers.authorization === `Bearer ${header}`) matched = true;
      const message = JSON.parse(await readBody(req)) as { id?: number | string; method?: string };
      if (message.method === "initialize") {
        initialize = true;
        if (mode.hang === true) return; // never answered
        await new Promise((r) => setTimeout(r, mode.delayMs));
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-2139" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } } }));
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "probe", description: "probe", inputSchema: { type: "object", properties: {} } }] } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake MCP has no TCP address");
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    authMatches: () => matched,
    initializeSeen: () => initialize,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Every file under `root` (recursively), the `.guuey/credentials` channel excluded. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (path === join(root, ".guuey", "credentials")) continue;
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) out.push(path);
    }
  };
  walk(root);
  return out;
}

interface SpawnRecord {
  exited: boolean;
}

/** The real SDK `query`, with the host's own spawner wrapped only to record the CLI process and its control calls. */
function recordingQuery(spawns: SpawnRecord[], log: { statusPending: number[]; promptPulledAt?: number }): QueryFn {
  return (params) => {
    const spawner = params.options.spawnClaudeCodeProcess;
    if (spawner === undefined) throw new Error("the host installed no spawner");
    const options: Options = {
      ...params.options,
      spawnClaudeCodeProcess: (request: SpawnOptions) => {
        const child = spawner(request);
        const record: SpawnRecord = { exited: false };
        child.once("exit", () => {
          record.exited = true;
        });
        spawns.push(record);
        return child;
      },
    };
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      for await (const message of params.prompt) {
        log.promptPulledAt ??= Date.now();
        yield message;
      }
    }
    const q = realQuery({ prompt: prompt(), options });
    const handle: QueryHandle = {
      setMcpServers: (servers) => q.setMcpServers(servers),
      mcpServerStatus: async () => {
        const statuses = await q.mcpServerStatus();
        if (statuses.some((s) => s.status === "pending")) log.statusPending.push(Date.now());
        return statuses;
      },
      close: () => q.close(),
      [Symbol.asyncIterator]: () => q[Symbol.asyncIterator](),
    };
    return handle;
  };
}

function collector(): { events: WorkerEvent[]; emit: ReturnType<typeof createEmitter> } {
  const events: WorkerEvent[] = [];
  return {
    events,
    emit: createEmitter({
      write(s: string) {
        for (const line of s.split("\n")) if (line.trim().length > 0) events.push(JSON.parse(line) as WorkerEvent);
      },
    }),
  };
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function turnDirs(): { fs: HostInvoke["fs"]; root: string } {
  const root = mkdtempSync(join(tmpdir(), "claude-cli-"));
  roots.push(root);
  const fs = { app: join(root, "app"), home: join(root, "home"), session: join(root, "session") };
  for (const dir of Object.values(fs)) mkdirSync(dir, { recursive: true });
  return { fs, root };
}

function writeCredential(session: string, name: string, url: string, header: string): void {
  const dir = join(session, ".guuey", "credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ url, transport: "http", headers: { authorization: `Bearer ${header}` } }), { mode: 0o600 });
}

describe("real Claude CLI: private key + MCP delivery (guuey#2139)", () => {
  it(
    "delivers the key and the MCP header privately, with turn-1 MCP tools, and leaves no sentinel behind",
    { timeout: TURN_BUDGET_MS },
    async () => {
      const key = sentinel();
      const mcpHeader = sentinel();
      const { fs, root } = turnDirs();
      const reportPath = join(root, "report.json");
      const upstream = await startFakeUpstream(key, `${process.execPath} ${FIXTURE} ${reportPath}`);
      const mcp = await startFakeMcp(mcpHeader, { delayMs: 500 });
      writeCredential(fs.session, "fake", mcp.url, mcpHeader);
      const stderr: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      });
      const spawns: SpawnRecord[] = [];
      const log: { statusPending: number[]; promptPulledAt?: number } = { statusPending: [] };
      const { events, emit } = collector();
      try {
        await runInvoke(
          { systemPrompt: `${MAIN_MARKER}: run the report tool once, then answer.` },
          { input: "go", identity: { userId: "u-2139", authMode: "anonymous" }, fs, fsBound: true, history: [] },
          { baseUrl: upstream.url, authToken: key, listCredentials: () => [{ name: "fake", cred: { url: mcp.url, transport: "http", headers: { authorization: `Bearer ${mcpHeader}` } } }] },
          emit,
          recordingQuery(spawns, log),
        );
      } finally {
        await upstream.close();
        await mcp.close();
      }

      const terminal = events.filter((e) => e.type === "done" || e.type === "error").map((e) => e.type);
      expect(terminal).toEqual(["done"]);
      expect(spawns).toHaveLength(1);

      // The key reached the upstream as x-api-key, on every request.
      const main = upstream.requests.filter((r) => r.main);
      expect(main.length).toBeGreaterThanOrEqual(2);
      expect(upstream.requests.every((r) => r.apiKeyMatches)).toBe(true);
      // The MCP header reached the MCP server; turn-1 tools present.
      expect(mcp.authMatches()).toBe(true);
      expect(main[0]?.toolNames).toContain("mcp__fake__probe");

      // The Bash child's report (booleans and counts only).
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, boolean | number>;
      expect(report.cliFound).toBe(true);
      // Nothing on the CLI's (or any ancestor's) argv.
      expect(report.cliArgvSentinelCount).toBe(0);
      expect(report.ancestorArgvSentinelCount).toBe(0);
      // The Bash child holds no sentinel and no credential name.
      expect(report.childSentinelCount).toBe(0);
      expect(report.childHasAnthropicCredentialName).toBe(false);
      // The CLI took the socket branch and wrote no key file.
      const apiKeyFiles = [...filesUnder(fs.session), ...filesUnder(fs.home)].filter((p) => p.endsWith(".api_key"));
      expect(apiKeyFiles).toEqual([]);
      expect(existsSync("/home/claude/.claude/remote/.api_key")).toBe(false);

      // No sentinel in any file the turn left under the session/home dirs, nor on stderr.
      const residue = [...filesUnder(fs.session), ...filesUnder(fs.home)].filter((p) => {
        const text = readFileSync(p, "utf8");
        return text.includes(key) || text.includes(mcpHeader);
      });
      expect(residue).toHaveLength(0);
      expect(stderr.filter((line) => line.includes(key) || line.includes(mcpHeader))).toHaveLength(0);

      // The user message was sent only after no server was pending.
      expect(log.promptPulledAt).toBeDefined();
      expect(log.statusPending.every((at) => at <= (log.promptPulledAt ?? 0))).toBe(true);
    },
  );

  it.skipIf(!LINUX)(
    `on Linux: the CLI's initial environ has no sentinel and its key descriptor is not left open as a regular file — ${LINUX_ONLY}`,
    { timeout: TURN_BUDGET_MS },
    async () => {
      const key = sentinel();
      const { fs, root } = turnDirs();
      const reportPath = join(root, "report.json");
      const upstream = await startFakeUpstream(key, `${process.execPath} ${FIXTURE} ${reportPath}`);
      const spawns: SpawnRecord[] = [];
      const { events, emit } = collector();
      try {
        await runInvoke(
          { systemPrompt: `${MAIN_MARKER}: run the report tool once, then answer.` },
          { input: "go", identity: { userId: "u-2139", authMode: "anonymous" }, fs, fsBound: true, history: [] },
          { baseUrl: upstream.url, authToken: key, listCredentials: () => [] },
          emit,
          recordingQuery(spawns, { statusPending: [] }),
        );
      } finally {
        await upstream.close();
      }
      expect(events.some((e) => e.type === "done")).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, boolean | number>;
      expect(report.cliInitialEnvSentinelCount).toBe(0);
      expect(report.childInitialEnvSentinelCount).toBe(0);
      expect(report.cliFd3IsRegularFile).toBe(false);
    },
  );
});

describe("real Claude CLI: MCP-ready deadline (guuey#2139)", () => {
  it(
    "an MCP server that never completes initialize: the turn proceeds without it, one CLI process, gone at the end",
    { timeout: TURN_BUDGET_MS },
    async () => {
      const key = sentinel();
      const mcpHeader = sentinel();
      const { fs } = turnDirs();
      const upstream = await startFakeUpstream(key, undefined);
      const mcp = await startFakeMcp(mcpHeader, { delayMs: 0, hang: true });
      const stderr: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      });
      const spawns: SpawnRecord[] = [];
      const log: { statusPending: number[]; promptPulledAt?: number } = { statusPending: [] };
      const { events, emit } = collector();
      const started = Date.now();
      try {
        await runInvoke(
          { systemPrompt: `${MAIN_MARKER}: answer.` },
          { input: "go", identity: { userId: "u-2139", authMode: "anonymous" }, fs, history: [] },
          { baseUrl: upstream.url, authToken: key, listCredentials: () => [{ name: "stuck", cred: { url: mcp.url, transport: "http", headers: { authorization: `Bearer ${mcpHeader}` } } }] },
          emit,
          recordingQuery(spawns, log),
          { mcpReadyDeadlineMs: 2_000 },
        );
      } finally {
        await upstream.close();
        await mcp.close();
      }
      expect(events.filter((e) => e.type === "done").length).toBe(1);
      expect(spawns).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 200));
      expect(spawns.every((s) => s.exited)).toBe(true);
      expect(stderr.some((line) => line.includes('MCP server "stuck" not connected'))).toBe(true);
      // No user message before the decision: every pending status read precedes the prompt pull.
      expect(log.promptPulledAt).toBeDefined();
      expect(log.statusPending.every((at) => at <= (log.promptPulledAt ?? 0))).toBe(true);
      expect((log.promptPulledAt ?? 0) - started).toBeGreaterThanOrEqual(0);
    },
  );
});
