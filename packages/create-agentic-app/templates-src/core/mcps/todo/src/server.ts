/**
 * todo-mcp — the copy-me example MCP server for @agentic-app-template.
 *
 * A minimal, stateless Streamable HTTP MCP server: four tools over an
 * in-memory todo list. Swap the `Map` for a real database when you outgrow
 * a single replica; everything else (transport wiring, tool shape) stays
 * the same.
 *
 * Transport pattern mirrors guuey's canonical hosted-MCP scaffold
 * (`mcp-servers/_template` in the guuey monorepo): a fresh `McpServer` +
 * `StreamableHTTPServerTransport` are created **per request** and torn down
 * when the response closes. Stateless mode — the guuey proxy (and, locally,
 * whatever MCP client you point at this server) handles sessions, so this
 * server never keeps request state around between calls.
 *
 * Runtime contract when deployed via `guuey mcp deploy` (see mcps/todo's
 * Dockerfile): the platform injects `PORT=8080` and probes `GET /health`
 * for both liveness and readiness. Locally, `pnpm dev` runs this on
 * `PORT=6782` (see ../../scripts/dev.mjs). Run alongside the agent, it
 * listens on the unix socket named by `GUUEY_MCP_SOCKET` instead (see the
 * listen call at the bottom).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

interface Todo {
  id: string;
  title: string;
  done: boolean;
}

const todos = new Map<string, Todo>();

/**
 * Largest number of array elements plus object members one `tools/call`
 * `arguments` payload may carry. The SDK counts them before zod parses the
 * input and answers a bigger payload with an `isError` result, so the tool
 * handler never runs. The largest real input here is one field
 * (`todo_create.title`, `todo_toggle.id` or `todo_delete.id`); 16 leaves room
 * for a client that sends a few extra keys, which zod strips. Re-derive this
 * number when you add a tool that takes lists or nested objects, and give
 * every `z.array()` in an input schema a `.max()` (zod walks every element of
 * an unbounded array).
 */
export const MAX_TOOL_INPUT_ELEMENTS = 16;

/**
 * Largest HTTP request body `/mcp` accepts, in bytes. A bigger body gets HTTP
 * 413 from the transport before any JSON is parsed. The largest real request
 * is a `todo_create` call: a ~300-byte JSON-RPC envelope around a one-line
 * title (even 1,000 characters written as `\uXXXX` escapes is ~6 KB), and
 * `initialize` is 1-3 KB. 64 KiB is ten times that, and far below the SDK's
 * 4 MiB default. Raise it only when a tool really takes a larger input.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

const todoShape = {
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
};

/** Wrap a structured result as both `structuredContent` and a text block. */
function toolResult(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function buildMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "todo-mcp",
      version: "0.0.0",
      description: "Create, list, toggle, and delete todos.",
    },
    { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );

  server.registerTool(
    "todo_list",
    {
      title: "List todos",
      description: "List every todo, in creation order.",
      inputSchema: {},
      outputSchema: { todos: z.array(z.object(todoShape)) },
    },
    async () => toolResult({ todos: [...todos.values()] }),
  );

  server.registerTool(
    "todo_create",
    {
      title: "Create todo",
      description: "Create a new todo item.",
      inputSchema: { title: z.string().min(1).describe("Todo title.") },
      outputSchema: todoShape,
    },
    async ({ title }) => {
      const todo: Todo = { id: randomUUID(), title, done: false };
      todos.set(todo.id, todo);
      // Spread into a fresh object literal — `toolResult` takes
      // `Record<string, unknown>`, and a named interface like `Todo` isn't
      // structurally assignable to that without an (unwanted) index
      // signature of its own; a fresh literal is.
      return toolResult({ ...todo });
    },
  );

  server.registerTool(
    "todo_toggle",
    {
      title: "Toggle todo",
      description: "Flip a todo's done state.",
      inputSchema: { id: z.string().describe("Todo id.") },
      outputSchema: todoShape,
    },
    async ({ id }) => {
      const todo = todos.get(id);
      if (!todo) throw new Error(`todo not found: ${id}`);
      todo.done = !todo.done;
      return toolResult({ ...todo }); // fresh literal — see the create() comment above
    },
  );

  server.registerTool(
    "todo_delete",
    {
      title: "Delete todo",
      description: "Delete a todo by id.",
      inputSchema: { id: z.string().describe("Todo id.") },
      outputSchema: { id: z.string(), deleted: z.boolean() },
    },
    async ({ id }) => {
      const deleted = todos.delete(id);
      return toolResult({ id, deleted });
    },
  );

  return server;
}

const PORT = Number(process.env.PORT ?? 6782);

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "todo-mcp", version: "0.0.0" }));
    return;
  }

  if (req.url !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" }).end(
      JSON.stringify({ error: "not found" }),
    );
    return;
  }

  // Fresh server + transport per request (stateless mode) — see module doc.
  const mcp = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });

  res.on("close", () => {
    transport.close().catch(() => undefined);
    mcp.close().catch(() => undefined);
  });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("mcp_handle_failed", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
    }
  }
});

/**
 * Where to listen. When the platform runs this server alongside your agent
 * (a `"kind": "colocated"` server in guuey.json), it names a unix socket in
 * `GUUEY_MCP_SOCKET`: serve HTTP on that socket and nothing else. Never bind
 * both the socket and PORT. Everywhere else (`guuey mcp deploy`, `pnpm dev`)
 * the server listens on PORT.
 */
const MCP_SOCKET = process.env.GUUEY_MCP_SOCKET;
if (MCP_SOCKET !== undefined && MCP_SOCKET !== "") {
  httpServer.listen(MCP_SOCKET, () => {
    console.log(`todo-mcp listening on ${MCP_SOCKET}`);
  });
} else {
  httpServer.listen(PORT, () => {
    console.log(`todo-mcp listening on :${PORT}`);
  });
}

function shutdown(signal: string): void {
  console.log(`${signal} received — shutting down`);
  httpServer.close(() => process.exit(0));
  // Force-exit if connections don't drain in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
