import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgEvent } from "@silverprotocol/core";
import { createServer as createHttpServer } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { startDevServer, lowerForDev, writeLocalCredentials, type DevServerHandle } from "./dev-server.js";
import { DEFAULT_AGENT_MCP_SERVERS } from "@guuey/config";

const echoFixture = join(__dirname, "fixtures", "echo-worker.mjs");
const errorFixture = join(__dirname, "fixtures", "error-worker.mjs");
const claudeNativeFixture = join(__dirname, "fixtures", "claude-native-worker.mjs");
const adkNativeFixture = join(__dirname, "fixtures", "adk-native-worker.mjs");

let srv: DevServerHandle | undefined;
let projectRoot: string | undefined;

afterEach(async () => {
  if (srv) {
    await srv.close();
    srv = undefined;
  }
  if (projectRoot) {
    rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

function freshProjectRoot(): string {
  projectRoot = mkdtempSync(join(tmpdir(), "guuey-dev-server-test-"));
  return projectRoot;
}

describe("startDevServer", () => {
  it("streams session/message/done frames for a turn (bypass)", async () => {
    srv = await startDevServer({
      port: 0,
      framework: "fixture",
      protocol: "bypass",
      workerCommand: process.execPath,
      workerArgs: [echoFixture],
      agentSnapshotJson: "{}",
      projectRoot: freshProjectRoot(),
    });
    const res = await fetch(`http://localhost:${srv.port}/agent/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    const text = await res.text();
    expect(text).toMatch(/^event: session\n/);
    // guuey#368: the session frame carries the thread identity (the same
    // id the /threads/:id/messages route is keyed by).
    const sess = /event: session\ndata: (\{[^\n]+\})/.exec(text);
    const sessData = JSON.parse(sess![1]!) as { sessionId: string; threadId: string };
    expect(sessData.threadId).toBe(sessData.sessionId);
    expect(text).toMatch(/event: message\ndata: \{"type":"native"/);
    expect(text).toMatch(/event: done\ndata: \{"stopReason":"end_turn"\}/);
  });

  it("reuses per-sessionId history across turns", async () => {
    srv = await startDevServer({
      port: 0,
      framework: "fixture",
      protocol: "bypass",
      workerCommand: process.execPath,
      workerArgs: [echoFixture],
      agentSnapshotJson: "{}",
      projectRoot: freshProjectRoot(),
    });
    const first = await fetch(`http://localhost:${srv.port}/agent/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "turn one" }),
    });
    const firstText = await first.text();
    const sessionId = /"sessionId":"([^"]+)"/.exec(firstText)?.[1];
    expect(sessionId).toBeTruthy();

    const second = await fetch(`http://localhost:${srv.port}/agent/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "turn two", sessionId }),
    });
    const secondText = await second.text();
    expect(secondText).toMatch(new RegExp(`"sessionId":"${sessionId}"`));
  });

  it("emits an error frame when the worker reports an error", async () => {
    srv = await startDevServer({
      port: 0,
      framework: "fixture",
      protocol: "bypass",
      workerCommand: process.execPath,
      workerArgs: [errorFixture],
      agentSnapshotJson: "{}",
      projectRoot: freshProjectRoot(),
    });
    const res = await fetch(`http://localhost:${srv.port}/agent/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "x" }),
    });
    const text = await res.text();
    expect(text).toMatch(
      /event: error\ndata: \{"code":"WORKER_ERROR","message":"worker error: worker blew up"\}/,
    );
  });

  it("normalizes to AgJSON on protocol silver", async () => {
    srv = await startDevServer({
      port: 0,
      framework: "claude-agent-sdk",
      protocol: "silver",
      workerCommand: process.execPath,
      workerArgs: [claudeNativeFixture],
      agentSnapshotJson: "{}",
      projectRoot: freshProjectRoot(),
    });
    const res = await fetch(`http://localhost:${srv.port}/agent/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    const text = await res.text();
    expect(text).toMatch(/^event: session\n/);
    // guuey#368: the session frame carries the thread identity (the same
    // id the /threads/:id/messages route is keyed by).
    const sess = /event: session\ndata: (\{[^\n]+\})/.exec(text);
    const sessData = JSON.parse(sess![1]!) as { sessionId: string; threadId: string };
    expect(sessData.threadId).toBe(sessData.sessionId);
    expect(text).toMatch(/event: done\ndata: \{"stopReason":"end_turn"\}/);

    const messageFrames = [...text.matchAll(/event: message\ndata: (\[.*?\])\n\n/g)].map((m) =>
      JSON.parse(m[1]!) as unknown[],
    );
    expect(messageFrames.length).toBeGreaterThan(0);
    const allEvents = messageFrames.flat();
    expect(allEvents.length).toBeGreaterThan(0);
    for (const e of allEvents) {
      expect(e).toHaveProperty("type");
      expect(e).toHaveProperty("seq");
    }
    // Never raw SDKMessage shapes on the wire in silver mode.
    expect(text).not.toMatch(/"type":"assistant"/);
    expect(text).not.toMatch(/"subtype":"success"/);
  });

  it("streams real AgJSON lifecycle events for a google-adk worker on protocol silver", async () => {
    // End-to-end through the REAL createAdkNormalizer(): the fixture worker
    // replays the captured ADK cassette (functionCall → functionResponse →
    // final text — see fixtures/adk-native-worker.mjs), and the SSE `message`
    // frames must carry the normalized AgJSON, not the raw ADK shapes.
    srv = await startDevServer({
      port: 0,
      framework: "google-adk",
      protocol: "silver",
      workerCommand: process.execPath,
      workerArgs: [adkNativeFixture],
      agentSnapshotJson: "{}",
      projectRoot: freshProjectRoot(),
    });
    const res = await fetch(`http://localhost:${srv.port}/agent/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    const text = await res.text();
    expect(text).toMatch(/^event: session\n/);
    // guuey#368: the session frame carries the thread identity (the same
    // id the /threads/:id/messages route is keyed by).
    const sess = /event: session\ndata: (\{[^\n]+\})/.exec(text);
    const sessData = JSON.parse(sess![1]!) as { sessionId: string; threadId: string };
    expect(sessData.threadId).toBe(sessData.sessionId);
    expect(text).toMatch(/event: done\ndata: \{"stopReason":"end_turn"\}/);

    const events = [...text.matchAll(/event: message\ndata: (\[.*?\])\n\n/g)].flatMap(
      (m) => JSON.parse(m[1]!) as AgEvent[],
    );
    // Tool turn: the captured functionCall/functionResponse pair came out as
    // AgJSON tool lifecycle under the REAL adk call id.
    const toolStarts = events.filter(
      (e): e is Extract<AgEvent, { type: "tool.start" }> => e.type === "tool.start",
    );
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]).toMatchObject({
      toolCallId: "adk-5e25963a-5f96-4847-83e1-49cff7dd4ea5",
      name: "echo",
    });
    const toolDones = events.filter(
      (e): e is Extract<AgEvent, { type: "tool.done" }> => e.type === "tool.done",
    );
    expect(toolDones).toHaveLength(1);
    expect(toolDones[0]).toMatchObject({
      toolCallId: "adk-5e25963a-5f96-4847-83e1-49cff7dd4ea5",
      outcome: "ok",
    });
    // Text turn: the streamed deltas reassemble the captured reply.
    const deltas = events.filter(
      (e): e is Extract<AgEvent, { type: "text.delta" }> => e.type === "text.delta",
    );
    expect(deltas.map((d) => d.delta).join("")).toBe(
      "The message 'conformance-probe' has been echoed back.",
    );
    expect(events.some((e) => e.type === "turn.done")).toBe(true);
    // Never raw ADK Event shapes on the wire in silver mode.
    expect(text).not.toMatch(/"invocationId"/);
    expect(text).not.toMatch(/"functionCall"/);
  });

  it("terminates with an error frame when silver has no normalizer for the framework", async () => {
    // Regression: makeNormalizer must throw INSIDE the invoke try block so the
    // stream still ends in the standard `event: error` frame (every invoke
    // that emitted `session` terminates) — not a dangling session-only stream.
    srv = await startDevServer({
      port: 0,
      framework: "fixture", // no @silverprotocol normalizer for this
      protocol: "silver",
      workerCommand: process.execPath,
      workerArgs: [echoFixture],
      agentSnapshotJson: "{}",
      projectRoot: freshProjectRoot(),
    });
    const res = await fetch(`http://localhost:${srv.port}/agent/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    const text = await res.text();
    expect(text).toMatch(/^event: session\n/);
    // guuey#368: the session frame carries the thread identity (the same
    // id the /threads/:id/messages route is keyed by).
    const sess = /event: session\ndata: (\{[^\n]+\})/.exec(text);
    const sessData = JSON.parse(sess![1]!) as { sessionId: string; threadId: string };
    expect(sessData.threadId).toBe(sessData.sessionId);
    expect(text).toMatch(
      /event: error\ndata: \{"code":"WORKER_ERROR","message":"AGJSON_NO_NORMALIZER:fixture"\}/,
    );
  });

  it("returns 204 for OPTIONS preflight and 200 for /healthz", async () => {
    srv = await startDevServer({
      port: 0,
      framework: "fixture",
      protocol: "bypass",
      workerCommand: process.execPath,
      workerArgs: [echoFixture],
      agentSnapshotJson: "{}",
      projectRoot: freshProjectRoot(),
    });
    const health = await fetch(`http://localhost:${srv.port}/healthz`);
    expect(health.status).toBe(200);

    const preflight = await fetch(`http://localhost:${srv.port}/agent/invoke`, {
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("lowerForDev", () => {
  it("rewrites hosted+devPort to external localhost", () => {
    const lowered = lowerForDev({
      mcpServers: { todo: { kind: "hosted", source: "./mcps/todo", devPort: 6782 } },
    });
    expect(lowered.agent.mcpServers?.todo).toEqual({
      kind: "external",
      url: "http://localhost:6782/mcp",
      transport: "http",
    });
    expect(lowered.colocatedNames.size).toBe(0);
  });

  it("leaves external without devPort unchanged", () => {
    const lowered = lowerForDev({
      mcpServers: { custom: { kind: "external", url: "https://example.com/mcp", transport: "http" } },
    });
    expect(lowered.agent.mcpServers?.custom).toEqual({
      kind: "external",
      url: "https://example.com/mcp",
      transport: "http",
    });
  });

  it("rewrites colocated+devPort to external localhost and records the name in colocatedNames", () => {
    const lowered = lowerForDev({
      mcpServers: { notes: { kind: "colocated", source: "./mcps/notes", devPort: 6783 } },
    });
    expect(lowered.agent.mcpServers?.notes).toEqual({
      kind: "external",
      url: "http://localhost:6783/mcp",
      transport: "http",
    });
    expect(lowered.colocatedNames).toEqual(new Set(["notes"]));
  });

  it("drops a colocated entry with no devPort, warning with the fix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lowered = lowerForDev({
      mcpServers: { notes: { kind: "colocated", source: "./mcps/notes" } },
    });
    expect(lowered.agent.mcpServers?.notes).toBeUndefined();
    expect(lowered.colocatedNames.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("add devPort to the colocated entry in guuey.json"));
    warn.mockRestore();
  });

  it("drops credential:'oauth' external entries (deploy-only broker path — warns, does not throw)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lowered = lowerForDev({
      mcpServers: {
        linear: { kind: "external", url: "https://mcp.linear.app/mcp", credential: "oauth" },
        plain: { kind: "external", url: "https://mcp.example.com/mcp" },
      },
    });
    expect(lowered.agent.mcpServers?.linear).toBeUndefined();
    expect(lowered.agent.mcpServers?.plain).toEqual({ kind: "external", url: "https://mcp.example.com/mcp" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropping MCP server "linear" (credential: oauth)'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("guuey deploy"));
    warn.mockRestore();
  });

  it("throws for a hosted registry-reuse entry (server, no devPort) instead of silently dropping it", () => {
    expect(() =>
      lowerForDev({
        mcpServers: { todo: { kind: "hosted", server: "srv_x" } },
      }),
    ).toThrow(/devPort/);
    expect(() =>
      lowerForDev({
        mcpServers: { todo: { kind: "hosted", server: "srv_x" } },
      }),
    ).toThrow(/guuey deploy/);
  });

  it("still lowers a hosted entry with devPort even when it carries `server` (registry write-back)", () => {
    const lowered = lowerForDev({
      mcpServers: { todo: { kind: "hosted", server: "srv_x", devPort: 6782 } },
    });
    expect(lowered.agent.mcpServers?.todo).toEqual({
      kind: "external",
      url: "http://localhost:6782/mcp",
      transport: "http",
    });
  });

  it("still lowers an external entry with devPort", () => {
    const lowered = lowerForDev({
      mcpServers: {
        custom: { kind: "external", url: "https://example.com/mcp", transport: "http", devPort: 6784 },
      },
    });
    expect(lowered.agent.mcpServers?.custom).toEqual({
      kind: "external",
      url: "http://localhost:6784/mcp",
      transport: "http",
    });
  });

  it("does not throw for a hosted entry with only `source` (build-only, not yet resolved) and no devPort — warns with the actionable fix and drops instead", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let lowered: ReturnType<typeof lowerForDev> | undefined;
    expect(() => {
      lowered = lowerForDev({
        mcpServers: { todo: { kind: "hosted", source: "./mcps/todo" } },
      });
    }).not.toThrow();
    expect(lowered?.agent.mcpServers?.todo).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("devPort"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("guuey deploy"));
    warn.mockRestore();
  });

  it("injects the default local ggui server when none is declared", () => {
    const lowered = lowerForDev({});
    expect(lowered.agent.mcpServers?.ggui).toEqual({
      kind: "external",
      url: "http://localhost:6781/mcp",
      transport: "http",
    });
  });

  it("does not override an explicitly declared CUSTOM ggui entry", () => {
    // Re-pinned for guuey#368: the platform-DEFAULT url now lowers to the
    // local dev endpoint (see the #368 block below) — what this pin
    // protects is a builder pointing ggui at their OWN server.
    const lowered = lowerForDev({
      mcpServers: { ggui: { kind: "external", url: "https://ggui.own.example/mcp", transport: "http" } },
    });
    expect(lowered.agent.mcpServers?.ggui).toEqual({
      kind: "external",
      url: "https://ggui.own.example/mcp",
      transport: "http",
    });
  });
});

describe("the local credential broker (graceful mode)", () => {
  it("writeLocalCredentials writes the production cred-file contract (url/transport/empty headers)", () => {
    const dir = mkdtempSync(join(tmpdir(), "guuey-local-creds-"));
    writeLocalCredentials(dir, {
      todo: { url: "http://localhost:6782/mcp", transport: "http" },
      ggui: { url: "http://localhost:6781/mcp", transport: "http" },
    });
    const todo = JSON.parse(readFileSync(join(dir, ".guuey", "credentials", "todo.json"), "utf8")) as {
      url: string;
      transport: string;
      headers: Record<string, string>;
    };
    expect(todo).toEqual({ url: "http://localhost:6782/mcp", transport: "http", headers: {} });
    expect(readFileSync(join(dir, ".guuey", "credentials", "ggui.json"), "utf8")).toContain("6781");
  });

  it("writes a dev-identity bearer token for colocated-derived servers only, decodable via the REAL scopeFromAuthorization", async () => {
    const { scopeFromAuthorization, mcpIdFromResourceUrl } = await import("@guuey/state");
    const { colocatedResourceUrl } = await import("@guuey/config");

    const dir = mkdtempSync(join(tmpdir(), "guuey-local-creds-dev-identity-"));
    writeLocalCredentials(
      dir,
      {
        notes: { url: "http://localhost:6783/mcp", transport: "http" },
        todo: { url: "http://localhost:6782/mcp", transport: "http" },
      },
      { colocatedNames: new Set(["notes"]), devAppId: "app_abc123" },
    );

    const notes = JSON.parse(readFileSync(join(dir, ".guuey", "credentials", "notes.json"), "utf8")) as {
      headers: Record<string, string>;
    };
    const todo = JSON.parse(readFileSync(join(dir, ".guuey", "credentials", "todo.json"), "utf8")) as {
      headers: Record<string, string>;
    };

    // Non-colocated server: unchanged, empty headers.
    expect(todo.headers).toEqual({});

    // Colocated-derived server: a Bearer token the REAL scopeFromAuthorization
    // decodes to the dev-user scope, aud'd at the same colocatedResourceUrl
    // production's lowerColocated mints against.
    expect(notes.headers.authorization).toMatch(/^Bearer /);
    const scope = scopeFromAuthorization(notes.headers.authorization!);
    expect(scope.userId).toBe("dev-user");
    expect(scope.mcpId).toBe(mcpIdFromResourceUrl(colocatedResourceUrl("app_abc123", "notes")));
  });

  it("startDevServer writes cred files into the session dir BEFORE the worker runs", async () => {
    const root = freshProjectRoot();
    srv = await startDevServer({
      port: 0,
      framework: "fixture",
      protocol: "bypass",
      workerCommand: process.execPath,
      workerArgs: [echoFixture],
      agentSnapshotJson: "{}",
      projectRoot: root,
      localCredentials: { todo: { url: "http://localhost:6782/mcp", transport: "http" } },
    });
    const res = await fetch(`http://localhost:${srv.port}/agent/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "cred-sess" }),
    });
    await res.text();
    const credPath = join(root, ".guuey-dev", "sessions", "cred-sess", "session", ".guuey", "credentials", "todo.json");
    const cred = JSON.parse(readFileSync(credPath, "utf8")) as { url: string };
    expect(cred.url).toBe("http://localhost:6782/mcp");
  });
});

describe("GET /threads/:id/messages (guuey#110)", () => {
  async function bootAndRunTwoTurns(): Promise<{ port: number; sessionId: string }> {
    srv = await startDevServer({
      port: 0,
      framework: "fixture",
      protocol: "bypass",
      workerCommand: process.execPath,
      workerArgs: [echoFixture],
      agentSnapshotJson: "{}",
      projectRoot: freshProjectRoot(),
    });
    const first = await fetch(`http://localhost:${srv.port}/agent/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "turn one" }),
    });
    const sessionId = /"sessionId":"([^"]+)"/.exec(await first.text())?.[1];
    if (!sessionId) throw new Error("no sessionId in first turn");
    const second = await fetch(`http://localhost:${srv.port}/agent/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "turn two", sessionId }),
    });
    await second.text();
    return { port: srv.port, sessionId };
  }

  it("serves the session history in the read-plane row shape", async () => {
    const { port, sessionId } = await bootAndRunTwoTurns();
    const res = await fetch(`http://localhost:${port}/threads/${sessionId}/messages?limit=100`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ seq: number; at: string; kind: string; authorRole: string; text: string }>;
      nextToken: string | null;
    };
    expect(body.nextToken).toBeNull();
    expect(body.rows.map((r) => [r.seq, r.kind, r.authorRole, r.text])).toEqual([
      [1, "text", "user", "turn one"],
      [2, "text", "agent", "echo:turn one"],
      [3, "text", "user", "turn two"],
      [4, "text", "agent", "echo:turn two"],
    ]);
    for (const row of body.rows) {
      expect(Number.isNaN(Date.parse(row.at))).toBe(false);
    }
  });

  it("pages ascending with offset nextTokens", async () => {
    const { port, sessionId } = await bootAndRunTwoTurns();
    const page1 = (await (
      await fetch(`http://localhost:${port}/threads/${sessionId}/messages?limit=3`)
    ).json()) as { rows: Array<{ seq: number }>; nextToken: string | null };
    expect(page1.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(page1.nextToken).toBe("3");
    const page2 = (await (
      await fetch(
        `http://localhost:${port}/threads/${sessionId}/messages?limit=3&nextToken=${page1.nextToken}`,
      )
    ).json()) as { rows: Array<{ seq: number }>; nextToken: string | null };
    expect(page2.rows.map((r) => r.seq)).toEqual([4]);
    expect(page2.nextToken).toBeNull();
  });

  it("404s an unknown thread id (client's `gone` path on dev-server restart)", async () => {
    srv = await startDevServer({
      port: 0,
      framework: "fixture",
      protocol: "bypass",
      workerCommand: process.execPath,
      workerArgs: [echoFixture],
      agentSnapshotJson: "{}",
      projectRoot: freshProjectRoot(),
    });
    const res = await fetch(`http://localhost:${srv.port}/threads/nope/messages`);
    expect(res.status).toBe(404);
  });

  it("400s a malformed nextToken", async () => {
    const { port, sessionId } = await bootAndRunTwoTurns();
    const res = await fetch(
      `http://localhost:${port}/threads/${sessionId}/messages?nextToken=banana`,
    );
    expect(res.status).toBe(400);
  });

  it("answers the CORS preflight for the history route", async () => {
    srv = await startDevServer({
      port: 0,
      framework: "fixture",
      protocol: "bypass",
      workerCommand: process.execPath,
      workerArgs: [echoFixture],
      agentSnapshotJson: "{}",
      projectRoot: freshProjectRoot(),
    });
    const res = await fetch(`http://localhost:${srv.port}/threads/any/messages`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});

describe("lowerForDev — platform-default ggui entry (guuey#368)", () => {
  it("a ggui entry at EXACTLY the platform default lowers to the local ggui serve endpoint", () => {
    // The 0.11.x scaffolds shipped the platform default verbatim in
    // guuey.json — passed through un-dialable AND suppressing the default
    // injection, so out-of-box dev agents silently lost generative UI.
    const lowered = lowerForDev({
      mcpServers: {
        ggui: { kind: "external", url: "https://mcp.ggui.ai", transport: "http" },
      },
    });
    expect(lowered.agent.mcpServers?.ggui).toEqual({
      kind: "external",
      url: "http://localhost:6781/mcp",
      transport: "http",
    });
  });

  it("a CUSTOM external ggui url stays untouched — the builder pointed at a real server", () => {
    const lowered = lowerForDev({
      mcpServers: {
        ggui: { kind: "external", url: "https://ggui.mycorp.example/mcp", transport: "http" },
      },
    });
    expect(lowered.agent.mcpServers?.ggui).toEqual({
      kind: "external",
      url: "https://ggui.mycorp.example/mcp",
      transport: "http",
    });
  });

  it("the mirrored platform-default url matches @guuey/config's real default (sync pin)", () => {
    const defaultGgui = DEFAULT_AGENT_MCP_SERVERS["ggui"];
    if (defaultGgui === undefined || defaultGgui.kind !== "external") {
      throw new Error("config default ggui entry changed shape — update lowerForDev's mirror");
    }
    // The lowering must fire for exactly the config default: lower it and
    // assert the rewrite happened (the mirror string matching is IMPLIED).
    const lowered = lowerForDev({ mcpServers: { ggui: defaultGgui } });
    expect(lowered.agent.mcpServers?.ggui).toEqual({
      kind: "external",
      url: "http://localhost:6781/mcp",
      transport: "http",
    });
  });
});

// ─── The local pod door (guuey#368 residual) ──────────────────────────────
describe("GET /agent/ui-resource — the local pod door", () => {
  /** A minimal streamable-HTTP MCP producer serving one ui:// resource. */
  async function startFixtureMcp(): Promise<{ port: number; close: () => Promise<void> }> {
    const httpServer = createHttpServer((req, res) => {
      void (async () => {
        const mcp = new McpServer({ name: "fixt", version: "0.0.0" });
        mcp.registerResource("card", "ui://fixt/card/1", { mimeType: "text/html" }, async () => ({
          contents: [
            { uri: "ui://fixt/card/1", mimeType: "text/html", text: "<p>fixture card</p>" },
          ],
        }));
        // The shape is annotated at the WIDE constraint (ZodRawShape) so the
        // SDK's registerTool generic instantiates at the base type — the
        // narrow inference blows TS2589 when a zod-3 instance is hoisted
        // beside the SDK's zod-4 types (cross-instance generics; build- and
        // install-state sensitive, platform's #477 bisect). The cli's own
        // zod ^4.3.6 devDep fixes the RESOLUTION; this keeps the fixture
        // immune to any tree's hoist state.
        const toggleShape: z.ZodRawShape = { id: z.string() };
        mcp.registerTool(
          "toggle",
          { description: "toggle a todo", inputSchema: toggleShape },
          async (args) => ({
            content: [{ type: "text", text: JSON.stringify({ toggled: args.id }) }],
          }),
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close().catch(() => undefined);
          void mcp.close().catch(() => undefined);
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    return {
      port,
      close: () =>
        new Promise((resolve) => {
          // The dev server's cached client is closed by srv.close() in
          // afterEach — but this fixture may outlive it in the failure
          // path; destroy stragglers rather than wait on them.
          httpServer.closeAllConnections();
          httpServer.close(() => resolve());
        }),
    };
  }

  it("resolves a live locator through the producing server: authority segment → lowered entry → resources/read", { timeout: 20_000 }, async () => {
    const fixt = await startFixtureMcp();
    try {
      srv = await startDevServer({
        port: 0,
        framework: "fixture",
        protocol: "bypass",
        workerCommand: process.execPath,
        workerArgs: [echoFixture],
        agentSnapshotJson: JSON.stringify({
          mcpServers: {
            fixt: { kind: "external", url: `http://localhost:${fixt.port}/mcp`, transport: "http" },
          },
        }),
        projectRoot: freshProjectRoot(),
      });
      const res = await fetch(
        `http://localhost:${srv.port}/agent/ui-resource?uri=${encodeURIComponent("ui://fixt/card/1")}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        uri: "ui://fixt/card/1",
        mimeType: "text/html",
        text: "<p>fixture card</p>",
      });

      // The client CACHES per server: a second read reuses the session.
      const again = await fetch(
        `http://localhost:${srv.port}/agent/ui-resource?uri=${encodeURIComponent("ui://fixt/card/1")}`,
      );
      expect(again.status).toBe(200);
    } finally {
      await fixt.close();
    }
  });

  it("POST /agent/ui-action relays the in-card click as a real tools/call (guuey#477 — the read door's twin)", { timeout: 20_000 }, async () => {
    const fixt = await startFixtureMcp();
    try {
      srv = await startDevServer({
        port: 0,
        framework: "fixture",
        protocol: "bypass",
        workerCommand: process.execPath,
        workerArgs: [echoFixture],
        agentSnapshotJson: JSON.stringify({
          mcpServers: {
            fixt: { kind: "external", url: `http://localhost:${fixt.port}/mcp`, transport: "http" },
          },
        }),
        projectRoot: freshProjectRoot(),
      });
      // The docs repro's exact first failure: the OPTIONS preflight 404'd,
      // so the browser reported CORS. It must answer 204 with the headers.
      const preflight = await fetch(`http://localhost:${srv.port}/agent/ui-action`, {
        method: "OPTIONS",
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBeTruthy();

      const res = await fetch(`http://localhost:${srv.port}/agent/ui-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: "ui://fixt/card/1", name: "toggle", arguments: { id: "t1" } }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { content: Array<{ type: string; text: string }> };
      // The tool result comes back VERBATIM (the relay narrows it host-side).
      expect(result.content[0]).toMatchObject({ type: "text", text: '{"toggled":"t1"}' });

      // Misses stay the deny==miss contract: unknown authority + bad body.
      const unknown = await fetch(`http://localhost:${srv.port}/agent/ui-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: "ui://nobody/x", name: "toggle" }),
      });
      expect(unknown.status).toBe(404);
      const badBody = await fetch(`http://localhost:${srv.port}/agent/ui-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(badBody.status).toBe(404);
    } finally {
      await fixt.close();
    }
  });

  it("misses are 404, the reader's fall-through contract: unknown authority, non-ui uri, missing param", async () => {
    srv = await startDevServer({
      port: 0,
      framework: "fixture",
      protocol: "bypass",
      workerCommand: process.execPath,
      workerArgs: [echoFixture],
      agentSnapshotJson: JSON.stringify({
        mcpServers: {
          fixt: { kind: "external", url: "http://localhost:1/mcp", transport: "http" },
        },
      }),
      projectRoot: freshProjectRoot(),
    });
    const base = `http://localhost:${srv.port}/agent/ui-resource`;
    expect((await fetch(`${base}?uri=${encodeURIComponent("ui://nobody/x")}`)).status).toBe(404);
    expect((await fetch(`${base}?uri=https%3A%2F%2Fevil.example`)).status).toBe(404);
    expect((await fetch(base)).status).toBe(404);
    // A named server that cannot be reached is a MISS (and the next read
    // reconnects fresh), never a hang or a 500.
    expect((await fetch(`${base}?uri=${encodeURIComponent("ui://fixt/card/1")}`)).status).toBe(404);
  });
});
