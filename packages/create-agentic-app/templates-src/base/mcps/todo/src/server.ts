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
 * `PORT=6782` (see ../../scripts/dev.mjs).
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
  const server = new McpServer({
    name: "todo-mcp",
    version: "0.0.0",
    description: "Create, list, toggle, and delete todos.",
  });

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
      return toolResult(todo);
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
      return toolResult(todo);
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
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

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

httpServer.listen(PORT, () => {
  console.log(`todo-mcp listening on :${PORT}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received — shutting down`);
  httpServer.close(() => process.exit(0));
  // Force-exit if connections don't drain in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
