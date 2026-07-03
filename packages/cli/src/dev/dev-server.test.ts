import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { startDevServer, lowerForDev, type DevServerHandle } from "./dev-server.js";

const echoFixture = join(__dirname, "fixtures", "echo-worker.mjs");
const errorFixture = join(__dirname, "fixtures", "error-worker.mjs");
const claudeNativeFixture = join(__dirname, "fixtures", "claude-native-worker.mjs");

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
      url: "http://localhost:6782",
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
      url: "http://localhost:6781",
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
