import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgEvent } from "@silverprotocol/core";
import { startDevServer, lowerForDev, writeLocalCredentials, type DevServerHandle } from "./dev-server.js";

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
    expect(lowered.mcpServers?.todo).toEqual({
      kind: "external",
      url: "http://localhost:6782/mcp",
      transport: "http",
    });
  });

  it("leaves external without devPort unchanged", () => {
    const lowered = lowerForDev({
      mcpServers: { custom: { kind: "external", url: "https://example.com/mcp", transport: "http" } },
    });
    expect(lowered.mcpServers?.custom).toEqual({
      kind: "external",
      url: "https://example.com/mcp",
      transport: "http",
    });
  });

  it("drops colocated and proxied entries", () => {
    const lowered = lowerForDev({
      mcpServers: {
        stdio: { kind: "colocated", command: "node", args: ["server.js"] },
        saas: { kind: "proxied", connection: "conn_123" },
      },
    });
    expect(lowered.mcpServers?.stdio).toBeUndefined();
    expect(lowered.mcpServers?.saas).toBeUndefined();
  });

  it("injects the default local ggui server when none is declared", () => {
    const lowered = lowerForDev({});
    expect(lowered.mcpServers?.ggui).toEqual({
      kind: "external",
      url: "http://localhost:6781/mcp",
      transport: "http",
    });
  });

  it("does not override an explicitly declared ggui entry", () => {
    const lowered = lowerForDev({
      mcpServers: { ggui: { kind: "external", url: "https://mcp.ggui.ai", transport: "http" } },
    });
    expect(lowered.mcpServers?.ggui).toEqual({
      kind: "external",
      url: "https://mcp.ggui.ai",
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
