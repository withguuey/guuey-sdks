// `dev-server.test.ts` Task 8 integration fixture — a colocated MCP server
// dev-loop stand-in, spawned by `spawnColocatedDev` (Task 7) exactly like a
// real scaffolded colocated MCP's own `pnpm dev` would be.
//
// Hand-rolled Streamable-HTTP MCP transport (no SDK — same "fake the wire
// shape a real client speaks" style as the sibling `*-worker.mjs` fixtures):
// a single `POST /mcp` endpoint speaking the 3 JSON-RPC methods a real MCP
// client round-trips for one tool call — `initialize`, `tools/list`,
// `tools/call` — with a single synchronous JSON response per request (the
// Streamable-HTTP spec allows a plain `application/json` reply instead of an
// SSE stream when the server has nothing further to push; that's all this
// fixture ever needs).
//
// Exposes one tool, `whoami`, that proves a colocated MCP server receives
// real per-request identity locally: it reads the inbound `authorization`
// header and decodes it through the REAL `scopeFromAuthorization` from
// `@guuey/state` (not reimplemented/faked here) — the same helper a real
// colocated MCP handler imports in production. No header → `{ userId: null }`
// rather than throwing, so the "unauthenticated" path is also observable.
import { createServer } from "node:http";
import { scopeFromAuthorization } from "@guuey/state";

const port = Number(process.env.PORT ?? 0);

function whoami(authorizationHeader) {
  if (typeof authorizationHeader !== "string" || authorizationHeader.length === 0) {
    return { userId: null };
  }
  const scope = scopeFromAuthorization(authorizationHeader);
  return { userId: scope.userId, mcpId: scope.mcpId };
}

function handleRpc(method, params, authorizationHeader) {
  if (method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "colocated-state-mcp-fixture", version: "0.0.0" },
      capabilities: { tools: {} },
    };
  }
  if (method === "tools/list") {
    return {
      tools: [
        {
          name: "whoami",
          description: "Returns the caller's identity, derived from the inbound Authorization header.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  }
  if (method === "tools/call") {
    const toolName = params && typeof params === "object" ? params.name : undefined;
    if (toolName !== "whoami") {
      throw new Error(`unknown tool: ${String(toolName)}`);
    }
    const result = whoami(authorizationHeader);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  throw new Error(`unknown method: ${String(method)}`);
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }),
      );
      return;
    }
    try {
      const result = handleRpc(body.method, body.params, req.headers.authorization);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  });
});

server.listen(port, "127.0.0.1");

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
