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

// ─────────────────────────────────────────────────────────────────────────
// Optional: per-user durable state via `@guuey/state`.
//
// Hosted (`kind: 'hosted'`) and colocated (`kind: 'colocated'`) MCP servers
// get `GUUEY_KV_URL` (and a per-request auth token) injected automatically —
// zero setup, state just works. A `dev-hosted` external server (your own
// `kind: 'external', federate: true` deployment reached over a real URL)
// sets `GUUEY_KV_URL` itself, per the package README.
//
// Uncomment to try it: `pnpm add @guuey/state` (not yet on npm as of this
// scaffold — developer preview, see the guuey monorepo's publish runbook —
// so it's commented rather than a hard dependency, to keep this starter
// installing cleanly out of the box), then uncomment the import + the
// `withGuueyContext(...)` wrapper below.
//
// import { withGuueyContext, scopeFromAuthorization, kv } from "@guuey/state";
// ─────────────────────────────────────────────────────────────────────────

const SERVER_NAME = "NAME_PLACEHOLDER-mcp";

/**
 * Largest number of array elements plus object members one `tools/call`
 * `arguments` payload may carry. The SDK counts them before any tool input
 * is parsed and answers a call over the cap with an `isError: true` result
 * naming this maximum, so a hostile payload never reaches zod or a handler
 * (GHSA-46jr-4wx8-v453).
 *
 * Derived from the largest real input: `echo` takes `{ message }`, which is
 * 1 element, and the commented `remember` example takes `{ key, value }`,
 * which is 2. 16 sits just above both with room for a few more scalar
 * fields. When you add a tool, re-derive this from your largest real
 * `arguments`: every array element and every object member counts, at any
 * depth, so a tool that takes a list of 50 items needs at least 51.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 16;

/**
 * Largest HTTP request body, in bytes, the MCP transport reads. The SDK
 * transport parses the body itself, so this is passed as its
 * `maxRequestBodySize` option; a larger body is answered with 413 before it
 * is parsed.
 *
 * Derived from the largest real request: the commented `remember` example
 * stores a key of at most 1 KiB and a JSON-encoded value of at most 64 KiB
 * (the `@guuey/state` caps), so one `tools/call` is about 66 KiB with the
 * JSON-RPC envelope. 256 KiB covers it with headroom and is a sixteenth of
 * the SDK's 4 MiB default. Raise it if your own tools take larger payloads.
 */
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

/** Wrap a structured result as both `structuredContent` and a text block. */
function toolResult(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

// To uncomment the `@guuey/state` example below, change this signature to
// `buildMcpServer(authHeader: string | undefined)` and pass
// `req.headers.authorization` at the one call site further down.
function buildMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: "0.0.0",
      description: "Example MCP server — replace the echo tool with your own.",
    },
    { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );

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

  // ── Example: a durable, per-user tool via `@guuey/state` (uncomment) ──
  //
  // server.registerTool(
  //   "remember",
  //   {
  //     title: "Remember",
  //     description: "Store a value under a key, scoped to the calling user.",
  //     inputSchema: {
  //       key: z.string().min(1).max(1024),
  //       value: z.string().max(64 * 1024),
  //     },
  //     outputSchema: { stored: z.boolean() },
  //   },
  //   async ({ key, value }) => {
  //     if (!authHeader) throw new Error("missing Authorization header");
  //     return withGuueyContext(scopeFromAuthorization(authHeader), async () => {
  //       await kv.set(key, value, { ttl: 60 * 60 * 24 * 7 }); // 7 days
  //       return toolResult({ stored: true });
  //     });
  //   },
  // );
  //
  // A companion "recall" tool would mirror this with `await kv.get(key)`.
  // See `@guuey/state`'s README for the full API (increment/decrement,
  // keys(), scope() usage quota, etc).

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
  // (`buildMcpServer(req.headers.authorization)` once the `@guuey/state`
  // example above is uncommented.)
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
