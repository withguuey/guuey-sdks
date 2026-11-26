/**
 * runClaudeTurn: one whole Claude turn behind one call (the Claude template's inline turn, guuey#3550's session
 * included). A fake `query` stands in for the SDK's: it records what it was handed, yields scripted messages, and
 * answers the two control requests. A fake emit stands in for serveNative's, with or without `claudeSession`.
 */
import { describe, expect, it, vi } from "vitest";
import type { WorkerClaudeSession, WorkerClaudeSessionTurn } from "./claude-session.js";
import { makeClaudeSpawner, type ClaudeSpawnedProcess, type ClaudeSpawnRequest } from "./claude-spawn.js";
import {
  runClaudeTurn,
  type ClaudeQueryHandle,
  type ClaudeTurnMessage,
  type ClaudeTurnOwnOptions,
  type ClaudeTurnServerStatus,
  type ClaudeTurnUserMessage,
} from "./claude-turn.js";
import { CLI_SESSION_RESUME_FAILED, type HelloCliSession, type Invoke, type JsonValue } from "./protocol.js";
import type { NativeEmit } from "./serve-native.js";

/** The options this file's fake SDK takes: the env the helper reads, the keys it writes, and the app posture read back. */
interface FakeOptions extends ClaudeTurnOwnOptions {
  model?: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  canUseTool?: (...args: never[]) => unknown;
  tools?: readonly string[];
  systemPrompt?: string;
  maxTurns?: number;
  persistSession?: boolean;
  sessionId?: string;
  resume?: string;
  pathToClaudeCodeExecutable?: string;
  spawnClaudeCodeProcess?: (request: ClaudeSpawnRequest) => ClaudeSpawnedProcess;
}

const START: Invoke = {
  type: "invoke",
  input: "and now?",
  identity: { userId: "u1", authMode: "anonymous" },
  fs: { app: "/app", home: "/home", session: "/session" },
  history: [
    { role: "user", text: "hello" },
    { role: "agent", text: "hi there" },
  ],
};
const SESSION_ID = "6f1c2b8e-3a4d-4c5e-9f60-7a8b9c0d1e2f";
const RESUME: Invoke = { ...START, cliSession: { mode: "resume", id: SESSION_ID } };
const STARTED: Invoke = { ...START, cliSession: { mode: "start", id: SESSION_ID } };

const INIT: ClaudeTurnMessage = { type: "system", subtype: "init", session_id: SESSION_ID };
const RESULT: ClaudeTurnMessage = { type: "result", subtype: "success", result: "the answer" };

interface FakeRun {
  readonly calls: { prompt: AsyncIterable<ClaudeTurnUserMessage>; options?: FakeOptions }[];
  readonly sent: ClaudeTurnUserMessage[];
  readonly closed: { count: number };
  readonly query: (args: { prompt: AsyncIterable<ClaudeTurnUserMessage>; options?: FakeOptions }) => ClaudeQueryHandle;
}

/**
 * A fake SDK `query`. It yields `before` at once (the CLI's own start messages), then reads the ONE user message the
 * prompt sends and yields `after`. `setMcp` and `statuses` script the control requests.
 */
function fakeQuery(opts: {
  before?: readonly ClaudeTurnMessage[];
  after?: readonly ClaudeTurnMessage[];
  setMcp?: () => Promise<object>;
  statuses?: (readonly ClaudeTurnServerStatus[])[];
}): FakeRun {
  const calls: FakeRun["calls"] = [];
  const sent: ClaudeTurnUserMessage[] = [];
  const closed = { count: 0 };
  const query: FakeRun["query"] = (args) => {
    calls.push(args);
    const statuses = [...(opts.statuses ?? [[{ status: "connected" }]])];
    let isClosed = false;
    async function* stream(): AsyncGenerator<ClaudeTurnMessage> {
      for (const m of opts.before ?? []) {
        if (isClosed) return;
        yield m;
      }
      for await (const m of args.prompt) {
        sent.push(m);
        break;
      }
      if (isClosed || sent.length === 0) return;
      for (const m of opts.after ?? [RESULT]) yield m;
    }
    const it = stream();
    return {
      [Symbol.asyncIterator]: () => it,
      setMcpServers: () => (opts.setMcp ?? (() => Promise.resolve({})))(),
      mcpServerStatus: () => Promise.resolve(statuses.length > 1 ? statuses.shift() ?? [] : statuses[0] ?? []),
      close: () => {
        isClosed = true;
        closed.count += 1;
      },
    };
  };
  return { calls, sent, closed, query };
}

/** A fake emit. `session` makes it a serveNative-like emit with `claudeSession`; `seen` records what that was handed. */
function fakeEmit(session?: WorkerClaudeSession | "none"): { emit: NativeEmit; natives: JsonValue[]; seen: WorkerClaudeSessionTurn[] } {
  const natives: JsonValue[] = [];
  const seen: WorkerClaudeSessionTurn[] = [];
  const emit: NativeEmit = {
    native: (e) => void natives.push(e),
    text: () => undefined,
    suspend: () => "not_offered",
    endThread: () => "not_offered",
    ...(session === undefined
      ? {}
      : {
          claudeSession: (turn: WorkerClaudeSessionTurn) => {
            seen.push(turn);
            return session === "none" ? undefined : session;
          },
        }),
  };
  return { emit, natives, seen };
}

/** A hello block as the session would carry it; the helper never reads it (serveNative sends it). */
const SHA = "0".repeat(64);
const BLOCK: HelloCliSession = {
  hashVersion: 1,
  systemPromptSha256: SHA,
  headerShas: { model: SHA, permissionMode: SHA, tools: SHA, mcpConfig: SHA },
  promptSha: SHA,
  promptBytes: 8,
  lastPromptSha: SHA,
};

function appliedSession(kind: "start" | "resume", confirm: (m: ClaudeTurnMessage) => string | undefined = () => undefined): WorkerClaudeSession {
  return {
    options: {
      ...(kind === "start" ? { sessionId: SESSION_ID } : { resume: SESSION_ID }),
      persistSession: true,
      pathToClaudeCodeExecutable: "/platform/claude",
    },
    env: { CLAUDE_CONFIG_DIR: "/platform/cli-config" },
    block: BLOCK,
    confirmFirst: confirm,
  };
}

const APP_OPTIONS: FakeOptions = {
  model: "claude-haiku-5-5",
  allowedTools: ["mcp__todo"],
  disallowedTools: ["mcp__todo__delete"],
  canUseTool: () => true,
  tools: [],
  env: { APP_VAR: "kept" },
  // A real spawner object (it spawns nothing until the CLI is started): the app's own, as an older worker passes it.
  spawnClaudeCodeProcess: makeClaudeSpawner({ key: "sk-app-own-spawner", keyKind: "api-key" }),
  maxTurns: 3,
  pathToClaudeCodeExecutable: "/app/claude",
};
const SERVERS = { todo: { type: "http", url: "http://127.0.0.1:6782/mcp" } };

/** The text of the one user message the turn sent. */
function sentText(run: FakeRun): string {
  const block = run.sent[0]?.message.content.at(-1);
  return block !== undefined && block.type === "text" ? block.text : "";
}

describe("runClaudeTurn: a start", () => {
  it("without a session: history in the text, persistSession false, the app's options and env, the result returned", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit, natives } = fakeEmit();
    const text = await runClaudeTurn({ query: run.query, invoke: START, emit, systemPrompt: "be brief", servers: SERVERS, options: APP_OPTIONS });
    expect(text).toBe("the answer");
    expect(sentText(run)).toContain("<conversation_history>\nUser: hello\nAssistant: hi there\n</conversation_history>");
    expect(sentText(run).endsWith("and now?")).toBe(true);
    const o = run.calls[0]?.options;
    expect(o?.persistSession).toBe(false);
    expect(o?.env).toEqual({ APP_VAR: "kept" });
    expect(o?.systemPrompt).toBe("be brief");
    expect(o?.pathToClaudeCodeExecutable).toBe("/app/claude");
    expect(o?.maxTurns).toBe(3);
    expect(o && "sessionId" in o).toBe(false);
    expect(o && "resume" in o).toBe(false);
    expect(natives).toEqual([INIT, RESULT]);
  });

  it("an emit whose claudeSession applies nothing runs the same plain start", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit } = fakeEmit("none");
    await runClaudeTurn({ query: run.query, invoke: STARTED, emit, systemPrompt: "be brief", servers: SERVERS, options: APP_OPTIONS });
    expect(run.calls[0]?.options?.persistSession).toBe(false);
    expect(run.calls[0]?.options?.env).toEqual({ APP_VAR: "kept" });
  });

  it("with a session: its env over the app's, its id, persistSession true, and the platform's CLI over the app's path", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit } = fakeEmit(appliedSession("start"));
    await runClaudeTurn({ query: run.query, invoke: STARTED, emit, systemPrompt: "be brief", servers: SERVERS, options: APP_OPTIONS });
    const o = run.calls[0]?.options;
    expect(o?.sessionId).toBe(SESSION_ID);
    expect(o?.persistSession).toBe(true);
    expect(o?.pathToClaudeCodeExecutable).toBe("/platform/claude");
    expect(o?.env).toEqual({ APP_VAR: "kept", CLAUDE_CONFIG_DIR: "/platform/cli-config" });
    expect(sentText(run)).toContain("<conversation_history>");
  });

  it("an empty system prompt passes none to query() and none to the session", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit, seen } = fakeEmit("none");
    await runClaudeTurn({ query: run.query, invoke: START, emit, systemPrompt: "", servers: SERVERS, options: APP_OPTIONS });
    expect(run.calls[0]?.options && "systemPrompt" in run.calls[0].options).toBe(false);
    expect(seen[0]?.systemPrompt).toBeUndefined();
  });

  it("a custom history shapes the start's text", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit } = fakeEmit();
    await runClaudeTurn({
      query: run.query, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS,
      history: (inv) => `custom:${inv.history.length}`,
    });
    expect(sentText(run)).toBe("custom:2");
  });

  it("a result that is not a success returns an empty text", async () => {
    const run = fakeQuery({ before: [INIT], after: [{ type: "result", subtype: "error_max_turns" }] });
    const { emit } = fakeEmit();
    expect(await runClaudeTurn({ query: run.query, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS })).toBe("");
  });
});

describe("runClaudeTurn: a resume", () => {
  it("with a session: no history in the text (the session holds it), and the resume id passes", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit } = fakeEmit(appliedSession("resume"));
    await runClaudeTurn({ query: run.query, invoke: RESUME, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS });
    expect(sentText(run)).toBe("and now?");
    expect(run.calls[0]?.options?.resume).toBe(SESSION_ID);
  });

  it("without a session it throws the not-applied reason, and query() is never called", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit } = fakeEmit("none");
    await expect(
      runClaudeTurn({ query: run.query, invoke: RESUME, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS }),
    ).rejects.toThrow(`${CLI_SESSION_RESUME_FAILED}: not applied`);
    expect(run.calls).toHaveLength(0);
  });

  it("on an emit with no claudeSession at all it throws the same, before query()", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit } = fakeEmit();
    await expect(
      runClaudeTurn({ query: run.query, invoke: RESUME, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS }),
    ).rejects.toThrow("this serve loop has no claudeSession");
    expect(run.calls).toHaveLength(0);
  });

  it("a refused first-message confirm: nothing forwarded, no user message sent, the query closed, the reason thrown", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit, natives } = fakeEmit(appliedSession("resume", () => "cli_session_resume_failed: not confirmed"));
    await expect(
      runClaudeTurn({ query: run.query, invoke: RESUME, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS }),
    ).rejects.toThrow("cli_session_resume_failed: not confirmed");
    expect(natives).toEqual([]);
    expect(run.sent).toHaveLength(0);
    expect(run.closed.count).toBeGreaterThanOrEqual(1);
  });
});

describe("runClaudeTurn: the session header (cto H1)", () => {
  it("is a closed pick: never the env, the spawner or any other option", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit, seen } = fakeEmit("none");
    await runClaudeTurn({ query: run.query, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS });
    const header = seen[0]?.header ?? {};
    expect(Object.keys(header).sort()).toEqual(["allowedTools", "canUseTool", "disallowedTools", "model", "tools"]);
    expect(JSON.stringify(header)).not.toContain("kept");
    expect(Object.values(header)).not.toContain(APP_OPTIONS.spawnClaudeCodeProcess);
  });

  it("takes the conversation's rules when given, not the turn's", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit, seen } = fakeEmit("none");
    await runClaudeTurn({
      query: run.query, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS,
      sessionRules: { allowedTools: ["mcp__todo"], disallowedTools: [] },
    });
    expect(seen[0]?.header.disallowedTools).toEqual([]);
    expect(run.calls[0]?.options?.disallowedTools).toEqual(["mcp__todo__delete"]);
  });

  it("hands the session the turn's servers and the same content blocks the query sends", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit, seen } = fakeEmit("none");
    await runClaudeTurn({ query: run.query, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS });
    expect(seen[0]?.servers).toBe(SERVERS);
    expect(seen[0]?.content).toEqual(run.sent[0]?.message.content);
  });
});

describe("runClaudeTurn: the MCP startup", () => {
  it("a setMcpServers error is the turn's error: the query closed, no user message sent", async () => {
    const run = fakeQuery({ before: [INIT], setMcp: () => Promise.reject(new Error("mcp down")) });
    const { emit } = fakeEmit();
    await expect(
      runClaudeTurn({ query: run.query, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS }),
    ).rejects.toThrow("mcp down");
    expect(run.closed.count).toBeGreaterThanOrEqual(1);
    expect(run.sent).toHaveLength(0);
  });

  it("waits while a server is pending, then sends", async () => {
    const run = fakeQuery({ before: [INIT], statuses: [[{ status: "pending" }], [{ status: "pending" }], [{ status: "connected" }]] });
    const { emit } = fakeEmit();
    const spy = vi.fn(run.query);
    expect(await runClaudeTurn({ query: spy, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS })).toBe("the answer");
    expect(run.sent).toHaveLength(1);
  });
});

describe("runClaudeTurn: the credential and the env", () => {
  const { env: _appEnv, spawnClaudeCodeProcess: _appSpawner, ...noEnvNoSpawner } = APP_OPTIONS;

  it("a credential: the helper builds the CLI's spawner itself", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit } = fakeEmit();
    await runClaudeTurn({
      query: run.query, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: noEnvNoSpawner,
      credential: { key: "sk-test-key", keyKind: "api-key" },
    });
    expect(typeof run.calls[0]?.options?.spawnClaudeCodeProcess).toBe("function");
  });

  it("no credential and no spawner: none is passed (the SDK finds its own)", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit } = fakeEmit();
    await runClaudeTurn({ query: run.query, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: noEnvNoSpawner });
    expect(run.calls[0]?.options && "spawnClaudeCodeProcess" in run.calls[0].options).toBe(false);
  });

  it("a credential AND an app spawner is refused before query()", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit } = fakeEmit();
    await expect(
      runClaudeTurn({
        query: run.query, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: APP_OPTIONS,
        credential: { key: "sk-test-key", keyKind: "api-key" },
      }),
    ).rejects.toThrow("not both");
    expect(run.calls).toHaveLength(0);
  });

  it("no app env: this process's env minus every credential variable", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-must-not-reach-the-cli");
    vi.stubEnv("GUUEY_TEST_PLAIN", "plain");
    try {
      const run = fakeQuery({ before: [INIT] });
      const { emit } = fakeEmit();
      await runClaudeTurn({ query: run.query, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: noEnvNoSpawner });
      const env = run.calls[0]?.options?.env ?? {};
      expect(env.GUUEY_TEST_PLAIN).toBe("plain");
      expect("ANTHROPIC_API_KEY" in env).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the spawner never reaches the session header", async () => {
    const run = fakeQuery({ before: [INIT] });
    const { emit, seen } = fakeEmit("none");
    await runClaudeTurn({
      query: run.query, invoke: START, emit, systemPrompt: "p", servers: SERVERS, options: noEnvNoSpawner,
      credential: { key: "sk-test-key", keyKind: "api-key" },
    });
    expect(Object.keys(seen[0]?.header ?? {})).not.toContain("spawnClaudeCodeProcess");
    expect(JSON.stringify(seen[0]?.header)).not.toContain("sk-test-key");
  });
});
