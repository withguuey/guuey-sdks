/**
 * NAME_PLACEHOLDER-mcp — the copy-me starter MCP server for
 * @agentic-app-template.
 *
 * A minimal, stateless Streamable HTTP MCP server with a single example
 * tool (`echo`). Replace the example tool with your own real tools;
 * everything else (transport wiring, `/health` + `PORT` contract) stays the
 * same.
 *
 * Transport pattern mirrors guuey's canonical hosted-MCP scaffold
 * (`mcp-servers/_template` in the guuey monorepo): a fresh `McpServer` +
 * `StreamableHTTPServerTransport` are created **per request** and torn down
 * when the response closes. Stateless mode — the guuey proxy (and, locally,
 * whatever MCP client you point at this server) handles sessions, so this
 * server never keeps request state around between calls.
 *
 * Runtime contract when deployed via `guuey mcp deploy` (see this
 * directory's Dockerfile): the platform injects `PORT=8080` and probes
 * `GET /health` for both liveness and readiness. Locally, `pnpm dev` runs
 * this on `PORT=6782` when scaffolded as a workspace member of a guuey
 * project (see ../../scripts/dev.mjs there).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const SERVER_NAME = "NAME_PLACEHOLDER-mcp";

/** Wrap a structured result as both `structuredContent` and a text block. */
function toolResult(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: "0.0.0",
    description: "Example MCP server — replace the echo tool with your own.",
  });

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo a message back. Replace this with your own tool.",
      inputSchema: { message: z.string().min(1).describe("Message to echo back.") },
      outputSchema: { message: z.string() },
    },
    async ({ message }) => toolResult({ message }),
  );

  return server;
}

const PORT = Number(process.env.PORT ?? 6782);

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: "0.0.0" }));
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
  console.log(`${SERVER_NAME} listening on :${PORT}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received — shutting down`);
  httpServer.close(() => process.exit(0));
  // Force-exit if connections don't drain in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
