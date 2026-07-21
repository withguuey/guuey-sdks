/**
 * Task 8 — local dev-loop integration proof for a colocated MCP server.
 *
 * Composes the pieces built across Tasks 1-7 the way a real `guuey dev`
 * session does:
 *
 *  1. `spawnColocatedDev` (Task 7, `colocated-dev.ts`) auto-spawns the
 *     fixture MCP server (`fixtures/colocated-state-mcp/index.mjs`) as a
 *     bare child process bound to a `devPort` — exactly the same call
 *     `commands/dev.ts` makes for every `kind: 'colocated'` entry.
 *  2. `writeLocalCredentials` (Task 6/7, `dev-server.ts`) mints the REAL
 *     dev-identity bearer token and writes the production-shaped credential
 *     file (`{ url, transport, headers }`) for the `colocatedNames`-marked
 *     server — the exact function `handleInvoke` calls before every worker
 *     spawn.
 *  3. The test itself plays the worker's role: it reads the cred file back
 *     (as `@guuey/host`'s `listCredentials` would) and POSTs a `tools/call`
 *     JSON-RPC request straight at the fixture's `/mcp` endpoint, carrying
 *     the cred file's `headers` verbatim — the same bytes a framework's MCP
 *     client would send per request once handed that `{ url, headers }`.
 *  4. The fixture's own handler decodes the inbound `authorization` header
 *     through the REAL `scopeFromAuthorization` (`@guuey/state`) and returns
 *     `{ userId, mcpId }` in the tool result — proving a colocated MCP
 *     server run entirely locally still receives real per-request identity.
 *
 * Proof shape chosen: this stops short of driving a full framework worker
 * (e.g. the real Claude Agent SDK's MCP client) through `startDevServer` —
 * no package under `oss/packages` hand-rolls an MCP client of its own (every
 * runner delegates that to the framework SDK), so standing one up here would
 * mean wiring a real `@silverprotocol/claude-agent-sdk` MCP session just to
 * prove a header round-trip it doesn't otherwise touch. Steps 1-4 above
 * exercise the exact same seam (auto-spawn → lowering's `devPort` URL →
 * real dev token → real header → real `scopeFromAuthorization`) without that
 * extra, unrelated moving part — see `dev-server.test.ts`'s existing
 * "writes a dev-identity bearer token..." test for the sibling proof that
 * stops one step earlier (decodes the minted token directly, no HTTP hop at
 * all); this test adds the missing HTTP+MCP hop on top of it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnColocatedDev, type ColocatedDevHandle } from "./colocated-dev.js";
import { writeLocalCredentials } from "./dev-server.js";

const projectRoot = __dirname;

let handle: ColocatedDevHandle | undefined;
let credRoot: string | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
  if (credRoot) {
    rmSync(credRoot, { recursive: true, force: true });
    credRoot = undefined;
  }
});

/** Poll the fixture's `/mcp` endpoint with a real `tools/list` call until it
 *  answers — the child has no IPC/ready signal (bare `stdio: ['ignore',
 *  'pipe','pipe']` spawn, matching `spawnColocatedDev`'s production shape),
 *  so this is the only honest signal that the server is actually listening. */
async function waitForMcpReady(url: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
      });
      if (res.ok) return;
    } catch {
      // ECONNREFUSED until the child's http.Server has bound the port.
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for colocated MCP fixture at ${url} to boot`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface JsonRpcToolCallResponse {
  result: { content: Array<{ type: string; text: string }> };
}

async function callWhoami(url: string, headers: Record<string, string>): Promise<{ userId: string | null; mcpId?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
  });
  const body = (await res.json()) as JsonRpcToolCallResponse;
  return JSON.parse(body.result.content[0]!.text) as { userId: string | null; mcpId?: string };
}

describe("colocated MCP local dev loop (Task 8 integration)", () => {
  it("auto-spawn + lowering's devPort URL + the real dev token + real scopeFromAuthorization compose end-to-end", async () => {
    const { scopeFromAuthorization, mcpIdFromResourceUrl } = await import("@guuey/state");
    const { colocatedResourceUrl } = await import("@guuey/config");

    const devPort = 34790;
    handle = spawnColocatedDev(
      [{ name: "notes", source: "fixtures/colocated-state-mcp", devPort }],
      projectRoot,
    );
    const url = `http://localhost:${devPort}/mcp`;
    await waitForMcpReady(url);

    // The exact lowered-URL contract `lowerForDev` produces for a colocated
    // entry with this `devPort` (see `dev-server.test.ts`'s `lowerForDev`
    // suite) — asserted here so this test would fail if that contract ever
    // drifted out from under it.
    expect(url).toBe(`http://localhost:${devPort}/mcp`);

    credRoot = mkdtempSync(join(tmpdir(), "guuey-colocated-mcp-integration-"));
    writeLocalCredentials(
      credRoot,
      { notes: { url, transport: "http" } },
      { colocatedNames: new Set(["notes"]), devAppId: "app_abc123" },
    );
    const cred = JSON.parse(
      readFileSync(join(credRoot, ".guuey", "credentials", "notes.json"), "utf8"),
    ) as { url: string; transport: string; headers: Record<string, string> };
    expect(cred.headers.authorization).toMatch(/^Bearer /);

    // Sanity: the same token, decoded directly (no HTTP hop) — pins that the
    // HTTP round-trip below isn't the thing making the scope come out right.
    const directScope = scopeFromAuthorization(cred.headers.authorization!);
    expect(directScope.userId).toBe("dev-user");

    const whoami = await callWhoami(cred.url, cred.headers);
    expect(whoami.userId).toBe("dev-user");
    expect(whoami.mcpId).toBe(mcpIdFromResourceUrl(colocatedResourceUrl("app_abc123", "notes")));
    expect(whoami.mcpId).toBe(directScope.mcpId);
  });

  it("the fixture returns userId: null for a caller with no Authorization header (no token faked/hardcoded)", async () => {
    const devPort = 34791;
    handle = spawnColocatedDev(
      [{ name: "notes", source: "fixtures/colocated-state-mcp", devPort }],
      projectRoot,
    );
    const url = `http://localhost:${devPort}/mcp`;
    await waitForMcpReady(url);

    const whoami = await callWhoami(url, {});
    expect(whoami).toEqual({ userId: null });
  });
});
