/**
 * guuey#2139: the platform key reaches the
 * OpenAI and google-adk SDKs in memory only. Real `@google/adk` 2.1.0 (its
 * public model registry) and a fake Gemini endpoint on loopback; synthetic
 * sentinels only, reported as booleans and counts.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmitter, type WorkerEvent } from "@guuey/worker";
import { AdkModelKeyError, bindAdkModelKey, countBuilderModels } from "./adk-model-key.js";
import { createRunner as createAdkRunner, loadAdk } from "./google-adk.js";
import { createRunner as createOpenaiRunner } from "./openai-runner.js";

const FIXTURES = dirname(fileURLToPath(new URL("./__fixtures__/adk-graceful-agent.mjs", import.meta.url)));
const CHILD_ENV = join(FIXTURES, "adk-spawn-child-env.mjs");
const MODEL = "gemini-2.5-flash";
const REAL_ADK_BUDGET_MS = 30_000;
const KEY_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GEMINI_BASE_URL", "GUUEY_AGENT_ENTRY", "GUUEY_WORKER_ROOT", "GUUEY_BUILDER_KEY_LANE"] as const;
const sentinel = (): string => `SENTINEL-2139-${randomBytes(12).toString("hex")}`;

/** What a child of THIS process inherits: provider key variable names and a sentinel count. */
function childEnvReport(): { keyNames: string[]; sentinelCount: number } {
  return JSON.parse(execFileSync(process.execPath, [CHILD_ENV], { encoding: "utf8" })) as { keyNames: string[]; sentinelCount: number };
}

/** The `apiKey` a constructed Gemini client carries, compared, never printed. */
function carriesKey(llm: object, key: string): boolean {
  return (JSON.parse(JSON.stringify(llm)) as { apiKey?: string }).apiKey === key;
}

const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of KEY_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of KEY_VARS) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("bindAdkModelKey on the real ADK registry", () => {
  it("every string model resolves to a client keyed with the platform token; the environment stays empty", async () => {
    const adk = await loadAdk();
    const token = sentinel();
    const cls = bindAdkModelKey(adk, token, MODEL);
    expect(adk.LLMRegistry.resolve(MODEL)).toBe(cls);
    const { LlmAgent } = await import("@google/adk");
    const sub = new LlmAgent({ name: "sub", model: MODEL, instruction: "x" });
    const root = new LlmAgent({ name: "root", model: MODEL, instruction: "x", subAgents: [sub] });
    const inherits = new LlmAgent({ name: "inherits", instruction: "x" });
    new LlmAgent({ name: "parent", model: MODEL, instruction: "x", subAgents: [inherits] });
    for (const agent of [root, sub, inherits]) expect(carriesKey(agent.canonicalModel, token)).toBe(true);
    expect(childEnvReport()).toEqual({ keyNames: [], sentinelCount: 0 });
  });

  it("a later bind with another token rekeys the same class (one registration per registry)", async () => {
    const adk = await loadAdk();
    const first = sentinel();
    const second = sentinel();
    const cls = bindAdkModelKey(adk, first, MODEL);
    expect(bindAdkModelKey(adk, second, MODEL)).toBe(cls);
    const { LLMRegistry } = await import("@google/adk");
    expect(carriesKey(LLMRegistry.newLlm(MODEL), second)).toBe(true);
  });

  it("a registry that resolves the model to another class (a stale resolve-cache entry) refuses the binding by name", () => {
    class StaleGemini {
      static readonly supportedModels: Array<string | RegExp> = [/gemini-.*/];
      constructor(readonly params: { model: string; apiKey: string }) {}
    }
    const registered: object[] = [];
    // A pre-poisoned cache: resolve keeps answering with the class it cached first.
    const poisoned = { register: (cls: object) => void registered.push(cls), resolve: (): object => StaleGemini };
    expect(() => bindAdkModelKey({ Gemini: StaleGemini, LLMRegistry: poisoned }, sentinel(), MODEL)).toThrow(AdkModelKeyError);
    expect(registered).toHaveLength(1);
  });

  it("an unknown model name refuses the binding by name", async () => {
    const adk = await loadAdk();
    expect(() => bindAdkModelKey(adk, sentinel(), "not-a-gemini-model")).toThrow(AdkModelKeyError);
  });

  it("counts builder-constructed model instances, never reads them", async () => {
    const adk = await loadAdk();
    const { LlmAgent, Gemini } = await import("@google/adk");
    const own = new LlmAgent({ name: "own", model: new Gemini({ model: MODEL, apiKey: "builder-own" }), instruction: "x" });
    const plain = new LlmAgent({ name: "plain", model: MODEL, instruction: "x", subAgents: [own] });
    expect(countBuilderModels(plain, (value) => value instanceof adk.BaseLlm)).toBe(1);
  });
});

describe("graceful google-adk through the host runner, envelope-keyed", () => {
  it(
    "the scaffold-shaped agent (string models, a sub-agent, an AgentTool) runs keyed with the envelope token; no key in the env",
    { timeout: REAL_ADK_BUDGET_MS },
    async () => {
      const token = sentinel();
      let keyMatches = false;
      let requests = 0;
      const server = createServer((req, res) => {
        requests += 1;
        if (req.headers["x-goog-api-key"] === token) keyMatches = true;
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no TCP address");
      process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${String(address.port)}`;
      process.env.GUUEY_WORKER_ROOT = FIXTURES;
      process.env.GUUEY_AGENT_ENTRY = "adk-graceful-agent.mjs";
      const session = mkdtempSync(join(tmpdir(), "adk-graceful-"));
      roots.push(session);
      const events: WorkerEvent[] = [];
      const emit = createEmitter({
        write(s: string) {
          for (const line of s.split("\n")) if (line.trim().length > 0) events.push(JSON.parse(line) as WorkerEvent);
        },
      });
      try {
        await createAdkRunner({ envelope: { v: 1, model: { wire: "gemini", token } } }).runTurn(
          { model: MODEL, systemPrompt: "be terse" },
          { input: "hi", identity: { userId: "u-2139", authMode: "anonymous" }, fs: { app: session, home: session, session }, history: [] },
          emit,
        );
      } finally {
        await new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
      }
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(events.filter((e) => e.type === "done")).toHaveLength(1);
      expect(requests).toBeGreaterThan(0);
      expect(keyMatches).toBe(true);
      expect(childEnvReport()).toEqual({ keyNames: [], sentinelCount: 0 });
    },
  );
});

/** One graceful turn of `entry` through the real host runner against a fake Gemini endpoint; the key compared, never printed. */
async function gracefulTurn(
  entry: string,
  token: string,
  boot: { envelope?: { v: 1; model: { wire: "gemini"; token: string } } } = { envelope: { v: 1, model: { wire: "gemini", token } } },
): Promise<{ errors: number; done: number; requests: number; keyMatches: boolean }> {
  let keyMatches = false;
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (req.headers["x-goog-api-key"] === token) keyMatches = true;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${String(address.port)}`;
  process.env.GUUEY_WORKER_ROOT = FIXTURES;
  process.env.GUUEY_AGENT_ENTRY = entry;
  const session = mkdtempSync(join(tmpdir(), "adk-graceful-"));
  roots.push(session);
  const events: WorkerEvent[] = [];
  const emit = createEmitter({
    write(s: string) {
      for (const line of s.split("\n")) if (line.trim().length > 0) events.push(JSON.parse(line) as WorkerEvent);
    },
  });
  try {
    await createAdkRunner(boot).runTurn(
      { model: MODEL, systemPrompt: "be terse" },
      { input: "hi", identity: { userId: "u-2139", authMode: "anonymous" }, fs: { app: session, home: session, session }, history: [] },
      emit,
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
  return {
    errors: events.filter((e) => e.type === "error").length,
    done: events.filter((e) => e.type === "done").length,
    requests,
    keyMatches,
  };
}

describe("graceful google-adk on the graceful-legacy lane (the launcher's GUUEY_BUILDER_KEY_LANE marker)", () => {
  it(
    "a module that constructs its own Gemini at import time runs keyed with the envelope token; the key stays in this process's env for it",
    { timeout: REAL_ADK_BUDGET_MS },
    async () => {
      const token = sentinel();
      process.env.GUUEY_BUILDER_KEY_LANE = "legacy-env";
      expect(await gracefulTurn("adk-builder-llm-agent.mjs", token)).toEqual({ errors: 0, done: 1, requests: 1, keyMatches: true });
      expect(childEnvReport()).toEqual({ keyNames: ["GEMINI_API_KEY"], sentinelCount: 1 });
    },
  );

  it(
    "a module whose factory constructs its own Gemini each turn runs keyed on the lane, and the key stays for it",
    { timeout: REAL_ADK_BUDGET_MS },
    async () => {
      const token = sentinel();
      process.env.GUUEY_BUILDER_KEY_LANE = "legacy-env";
      expect(await gracefulTurn("adk-builder-llm-factory-agent.mjs", token)).toEqual({ errors: 0, done: 1, requests: 1, keyMatches: true });
      expect(childEnvReport()).toEqual({ keyNames: ["GEMINI_API_KEY"], sentinelCount: 1 });
    },
  );

  it(
    "a string-model module on the same lane: the key is withdrawn from the env once the agent holds no builder model",
    { timeout: REAL_ADK_BUDGET_MS },
    async () => {
      const token = sentinel();
      process.env.GUUEY_BUILDER_KEY_LANE = "legacy-env";
      const turn = await gracefulTurn("adk-graceful-agent.mjs", token);
      expect(turn).toMatchObject({ errors: 0, done: 1, keyMatches: true });
      expect(childEnvReport()).toEqual({ keyNames: [], sentinelCount: 0 });
    },
  );

  it(
    "without the marker (strict lane) an own-Gemini module finds no key: the turn fails before any model call, and nothing is in the env",
    { timeout: REAL_ADK_BUDGET_MS },
    async () => {
      const token = sentinel();
      expect(await gracefulTurn("adk-builder-llm-factory-agent.mjs", token)).toEqual({ errors: 1, done: 0, requests: 0, keyMatches: false });
      expect(childEnvReport()).toEqual({ keyNames: [], sentinelCount: 0 });
    },
  );

  it(
    "the marker without a launch envelope (a local run whose key is already in its env) never withdraws that key",
    { timeout: REAL_ADK_BUDGET_MS },
    async () => {
      const token = sentinel();
      process.env.GUUEY_BUILDER_KEY_LANE = "legacy-env";
      process.env.GEMINI_API_KEY = token;
      const turn = await gracefulTurn("adk-graceful-agent.mjs", token, {});
      expect(turn).toMatchObject({ errors: 0, done: 1, keyMatches: true });
      expect(childEnvReport()).toEqual({ keyNames: ["GEMINI_API_KEY"], sentinelCount: 1 });
    },
  );

  it(
    "a marker value other than legacy-env is the strict lane",
    { timeout: REAL_ADK_BUDGET_MS },
    async () => {
      process.env.GUUEY_BUILDER_KEY_LANE = "legacy";
      expect(await gracefulTurn("adk-builder-llm-factory-agent.mjs", sentinel())).toEqual({ errors: 1, done: 0, requests: 0, keyMatches: false });
      expect(childEnvReport()).toEqual({ keyNames: [], sentinelCount: 0 });
    },
  );
});

describe("OpenAI no-code, envelope-keyed", () => {
  it("the token is applied in memory; a child of the host inherits no OPENAI_API_KEY and no sentinel", () => {
    createOpenaiRunner({ envelope: { v: 1, model: { wire: "openai", token: sentinel() } } });
    expect(childEnvReport()).toEqual({ keyNames: [], sentinelCount: 0 });
  });
});
