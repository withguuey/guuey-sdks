/**
 * Behavioural test for WHERE the scaffolded MCP servers listen
 * (`templates-src/core/mcps/todo/src/server.ts` and
 * `templates-src/mcp-base/src/server.ts`).
 *
 * Run alongside the agent (a `"kind": "colocated"` server), the platform names
 * a unix socket in `GUUEY_MCP_SOCKET` and may set PORT too. The server must then
 * serve HTTP on the socket and NOT bind PORT: a server that binds both races
 * the platform for the socket path. Without `GUUEY_MCP_SOCKET` it listens on
 * PORT, which the templates' input-limit suites already run against.
 *
 * The socket's file mode is the platform's to set, not the template's: it starts a
 * colocated server so the socket it creates is connectable by the platform's own
 * process. The templates therefore set no umask and call no chmod; do not add one.
 * (This suite runs as one user, so it cannot show that cross-user part.)
 *
 * Each server is the template's own entry file (it listens on import), so the
 * suite runs it as a child process (Node strips the TypeScript types).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const TEMPLATES = join(__dirname, "..", "templates-src");

/** Spawning a server and talking to it runs past vitest's 5 s default on a 2-vCPU runner (guuey#867). */
const SERVER_BUDGET_MS = 30_000;

const SERVERS = [
  {
    name: "todo",
    path: join(TEMPLATES, "core", "mcps", "todo", "src", "server.ts"),
    banner: "todo-mcp listening",
  },
  { name: "mcp-base", path: join(TEMPLATES, "mcp-base", "src", "server.ts"), banner: "listening" },
] as const;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("probe server has no TCP address"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

/** Starts a server with `env` on top of this process's env (minus any inherited socket name); resolves on its banner. */
function start(
  path: string,
  banner: string,
  env: { [name: string]: string }
): Promise<{ child: ChildProcess; stdout: () => string }> {
  const inherited: { [name: string]: string | undefined } = { ...process.env };
  delete inherited.GUUEY_MCP_SOCKET;
  const child = spawn(process.execPath, [path], {
    env: { ...inherited, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes(banner)) resolve({ child, stdout: () => out });
    });
    child.once("exit", (code) =>
      reject(new Error(`${path} exited (${code}) before listening: ${err}`))
    );
  });
}

/** One HTTP request over a unix socket: the status and body. */
function overSocket(
  socketPath: string,
  method: string,
  path: string,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        headers:
          body === undefined
            ? {}
            : { "content-type": "application/json", accept: "application/json, text/event-stream" },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.once("error", reject);
    req.end(body);
  });
}

/** Whether anything accepts a TCP connect on 127.0.0.1:`port`. */
function tcpAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

let running: ChildProcess | undefined;
let scratch: string | undefined;

afterEach(() => {
  running?.kill("SIGKILL");
  running = undefined;
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe.each(SERVERS)("$name server: where it listens", ({ path, banner }) => {
  it(
    "with GUUEY_MCP_SOCKET set, serves HTTP on that socket and does not bind PORT, even when PORT is set",
    async () => {
      scratch = mkdtempSync(join(tmpdir(), "mcp-sock-"));
      const socketPath = join(scratch, "mcp.sock");
      const port = await freePort();
      const { child, stdout } = await start(path, banner, {
        GUUEY_MCP_SOCKET: socketPath,
        PORT: String(port),
      });
      running = child;

      expect(stdout()).toContain(socketPath);
      const health = await overSocket(socketPath, "GET", "/health");
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toMatchObject({ status: "ok" });

      const tools = await overSocket(
        socketPath,
        "POST",
        "/mcp",
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      );
      expect(tools.status).toBe(200);
      expect(tools.body).toContain('"tools"');

      expect(await tcpAccepts(port)).toBe(false);
    },
    SERVER_BUDGET_MS
  );

  it(
    "without GUUEY_MCP_SOCKET (or with it empty), listens on PORT",
    async () => {
      const port = await freePort();
      const { child } = await start(path, banner, { GUUEY_MCP_SOCKET: "", PORT: String(port) });
      running = child;

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    },
    SERVER_BUDGET_MS
  );
});
