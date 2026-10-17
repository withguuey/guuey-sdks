/**
 * guuey#2139: a local run of the scaffold's Claude code-mode worker with only
 * a Claude OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`, no API key, no launch
 * envelope) keeps its CLI authenticated: the token is stripped from the CLI's
 * environment and handed over on the CLI's OAuth descriptor input instead.
 *
 * The SDK's `query` is replaced to capture the spawner the worker builds; the
 * spawner is then run for real against `@guuey/worker`'s fake-CLI fixture,
 * which reads the descriptor the way the pinned CLI does and reports booleans.
 * Synthetic values only; no assertion prints one.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GuueyAgent } from "@guuey/config";
import type { ClaudeSpawnRequest, ClaudeSpawnedProcess, Invoke, NativeEmit, NativeHandler } from "@guuey/worker";

interface CapturedOptions {
  env?: Record<string, string>;
  spawnClaudeCodeProcess?: (request: ClaudeSpawnRequest) => ClaudeSpawnedProcess;
}

const h = vi.hoisted(() => ({
  handler: undefined as NativeHandler | undefined,
  options: [] as CapturedOptions[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { prompt: AsyncIterable<object>; options: CapturedOptions }) => {
    h.options.push(params.options);
    return {
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      mcpServerStatus: async () => [],
      close: () => undefined,
      async *[Symbol.asyncIterator]() {
        for await (const _message of params.prompt) yield { type: "result", subtype: "success", result: "ok" };
      },
    };
  },
}));

vi.mock("@guuey/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@guuey/worker")>()),
  serveNative: async (handler: NativeHandler) => {
    h.handler = handler;
  },
}));

const WORKER_ENTRY = new URL("../templates-src/frameworks/claude-agent-sdk/src/worker.ts", import.meta.url).href;
const FAKE_CLI = fileURLToPath(new URL("../../worker/src/__fixtures__/fake-claude-cli.mjs", import.meta.url));
const OAUTH_TOKEN = `SENTINEL-2139-${randomBytes(12).toString("hex")}`;
const agent: GuueyAgent = { mcpServers: {} };
const emit: NativeEmit = { native: () => {}, text: () => {} };
const root = mkdtempSync(join(tmpdir(), "caa-claude-oauth-"));

interface FakeReport {
  keyVar: string;
  keyFdIsSocket: boolean;
  keyMatches: boolean;
  envCarriesKey: boolean;
  hasIpc: boolean;
}

beforeAll(async () => {
  vi.stubEnv("GUUEY_AGENT_SNAPSHOT", JSON.stringify(agent));
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  vi.stubEnv("GUUEY_LAUNCH_ENVELOPE_FD", undefined);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", OAUTH_TOKEN);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await import(WORKER_ENTRY);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Claude template worker: OAuth-token-only local run (guuey#2139)", () => {
  it("strips the token from the CLI env and hands it over on the CLI's OAuth descriptor", async () => {
    if (h.handler === undefined) throw new Error("the worker entry never called serveNative");
    const session = join(root, "session");
    mkdirSync(join(session, ".guuey", "credentials"), { recursive: true });
    const invoke: Invoke = {
      type: "invoke",
      input: "hello",
      identity: { userId: "u_1", authMode: "anonymous" },
      fs: { app: join(root, "app"), home: join(root, "home"), session },
      history: [],
    };
    expect(await h.handler(invoke, emit)).toBe("ok");
    const options = h.options.at(-1);
    if (options === undefined) throw new Error("no query");
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(Object.values(options.env ?? {}).some((value) => value.includes(OAUTH_TOKEN))).toBe(false);
    const spawner = options.spawnClaudeCodeProcess;
    if (spawner === undefined) throw new Error("no spawner: the OAuth-only run would leave the CLI unauthenticated");

    const child = spawner({
      command: process.execPath,
      args: [FAKE_CLI],
      env: { PATH: process.env.PATH ?? "", EXPECT_SHA256: createHash("sha256").update(OAUTH_TOKEN).digest("hex") },
      signal: new AbortController().signal,
    });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    const report = JSON.parse(out) as FakeReport;
    expect(report).toEqual({
      keyVar: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      keyFdIsSocket: true,
      keyMatches: true,
      envCarriesKey: false,
      hasIpc: false,
    });
  });
});
