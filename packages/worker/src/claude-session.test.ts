/**
 * guuey#3550: the ONE thread-resume sequence (`applyClaudeSession`), the builder worker's gate, and serveNative's
 * `claudeSession` opt-in. The isolation terms T1-T4 are pinned here:
 *  - T1: the id and environment checks read no file (an fs counter asserts zero reads);
 *  - T2: the hello block is the builder's claim; nothing here grants a folder, a thread or an app;
 *  - T3: the stored session is read under the cwd's real path only;
 *  - T4: with the platform's variables absent, no CLAUDE_CONFIG_DIR and no persistSession reach the turn.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloCliSession, Invoke, InvokeCliSession } from "./protocol.js";
import type { NativeEmit, NativeHandler } from "./serve-native.js";
import type { WorkerClaudeSession } from "./claude-session.js";

/** Every node:fs read the session code can make, counted (T1). */
const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const counted =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      reads.count += 1;
      return fn(...args);
    };
  return {
    ...real,
    realpathSync: counted(real.realpathSync),
    lstatSync: counted(real.lstatSync),
    readdirSync: counted(real.readdirSync),
    readFileSync: counted(real.readFileSync),
    openSync: counted(real.openSync),
    fstatSync: counted(real.fstatSync),
  };
});

const {
  applyClaudeSession,
  cliSessionNotAppliedMessage,
  cliSessionUnconfirmedMessage,
  workerClaudeSessionGate,
  CLAUDE_CLI_CONFIG_DIR_ENV,
  CLI_SESSION_ID_NOT_UUID,
  CLI_SESSION_PROMPT_NOT_STRING,
} = await import("./claude-session.js");
const { claudeSessionBlock, CLI_SESSION_CWD_MISSING, CLI_SESSION_NO_OWN_TEXT, CLI_SESSION_PATH_TOO_LONG } = await import(
  "./claude-session-block.js"
);
const { hashSystemPrompt, hashUserBlocks, hashUserText, sha256OfFields } = await import("./cli-session-hash.js");
const { serveNativeOn } = await import("./serve-native.js");
const { CLAUDE_CODE_EXECUTABLE_ENV } = await import("./claude-spawn.js");
const { drained } = await import("./fixtures/drained.js");
const { CLI_SESSION_CAPABILITY, CLI_SESSION_HASH_VERSION, CLI_SESSION_RESUME_FAILED } = await import("./protocol.js");

const ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const ROOT = mkdtempSync(join(tmpdir(), "worker-claude-session-"));
const CONFIG = join(ROOT, "config");
const CWD = join(ROOT, "session");
mkdirSync(CONFIG);
mkdirSync(CWD);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  reads.count = 0;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const SYSTEM = "the agent's prompt";
const CONTENT = [
  { type: "text" as const, text: "<turn_context>\nPlatform data for this turn.\n" },
  { type: "text" as const, text: "the user's words" },
];
const HEADER = {
  model: "claude-opus-5-5",
  canUseTool: () => undefined,
  tools: ["b", "a"],
  allowedTools: ["mcp__todo"],
  disallowedTools: ["mcp__todo__drop"],
};
const SERVERS = { todo: { type: "http", url: "https://todo.example/mcp" }, local: { type: "stdio" } };

function turn(session: InvokeCliSession, hello: (block: HelloCliSession) => void = () => undefined) {
  return { session, systemPrompt: SYSTEM, header: HEADER, servers: SERVERS, content: CONTENT, configDir: CONFIG, cwd: CWD, hello };
}

/** cto's read (F2): the refusal texts are pinned once, here, as the words a builder and a Router read. */
describe("the refusal texts", () => {
  it("each constant says exactly this", () => {
    expect(CLI_SESSION_ID_NOT_UUID).toBe("guuey: cliSession.id must be a UUID");
    expect(CLI_SESSION_PROMPT_NOT_STRING).toBe("guuey: the system prompt must be one string to resume a CLI session");
    expect(CLI_SESSION_PATH_TOO_LONG).toBe("guuey: the session directory's path is too long to resume a CLI session in");
    expect(CLI_SESSION_CWD_MISSING).toBe("guuey: the turn's working directory does not exist, so no CLI session can be resumed in it");
    expect(CLI_SESSION_NO_OWN_TEXT).toBe("guuey: the turn's message must end with its own text block");
    expect(cliSessionNotAppliedMessage("why")).toBe("cli_session_resume_failed: not applied (why)");
  });
});

describe("applyClaudeSession: refusals read nothing (T1)", () => {
  // hardening's T1 names the threat: a traversal-shaped id never reaches a path.
  it.each(["not-a-uuid", "6f9619ff8b864011b42d00c04fc964ff", ` ${ID}`, "../x", `${ID}/../x`, `${ID}\n`])("%j: throws the id text, no hello, zero fs reads", (id) => {
    const hello = vi.fn();
    expect(() => applyClaudeSession(turn({ mode: "resume", id }, hello))).toThrow(
      `${CLI_SESSION_ID_NOT_UUID} (got ${JSON.stringify(id)}).`,
    );
    expect(hello).not.toHaveBeenCalled();
    expect(reads.count).toBe(0);
  });

  it("a system prompt that is not one string (a preset) throws, no hello, zero fs reads", () => {
    const hello = vi.fn();
    expect(() =>
      applyClaudeSession({ ...turn({ mode: "resume", id: ID }, hello), systemPrompt: { type: "preset", preset: "claude_code" } }),
    ).toThrow(CLI_SESSION_PROMPT_NOT_STRING);
    expect(hello).not.toHaveBeenCalled();
    expect(reads.count).toBe(0);
  });
});

describe("applyClaudeSession: the sequence", () => {
  it("start: creates the session under the Router's id, one hello with the block, never a stored read", () => {
    const hello = vi.fn();
    const applied = applyClaudeSession(turn({ mode: "start", id: ID }, hello));
    expect(applied.options).toEqual({ sessionId: ID });
    expect(hello).toHaveBeenCalledTimes(1);
    expect(hello).toHaveBeenCalledWith(applied.block);
    expect(applied.block.stored).toBeUndefined();
    expect(reads.count).toBe(0);
    expect(applied.confirmFirst({ type: "assistant" })).toBeUndefined();
  });

  it("resume: the stored session is measured under projects/<slug of the cwd's real path> (T3)", () => {
    const applied = applyClaudeSession(turn({ mode: "resume", id: ID }));
    expect(applied.options).toEqual({ resume: ID });
    expect(applied.block.stored).toMatchObject({ readError: "missing", walks: [], entries: [] });
    expect(reads.count).toBeGreaterThan(0);
  });

  it("a recorded resume the stored session does not match: the hello carried the block, then the refusal throws", () => {
    const hello = vi.fn();
    expect(() => applyClaudeSession(turn({ mode: "resume", id: ID, expectLastPromptSha: "0".repeat(64) }, hello))).toThrow(
      `${CLI_SESSION_RESUME_FAILED}: refused (unreadable)`,
    );
    expect(hello).toHaveBeenCalledTimes(1);
    expect(hello.mock.calls[0]?.[0]).toMatchObject({ stored: { readError: "missing" } });
  });

  it("a resume whose cwd does not exist: its own sentence, never a raw fs message (cto F3)", () => {
    const hello = vi.fn();
    expect(() => applyClaudeSession({ ...turn({ mode: "resume", id: ID }, hello), cwd: join(ROOT, "gone") })).toThrow(
      new Error(CLI_SESSION_CWD_MISSING),
    );
    expect(hello).not.toHaveBeenCalled();
  });

  it("a resume is confirmed only by the init of exactly the id sent (R14)", () => {
    const { confirmFirst } = applyClaudeSession(turn({ mode: "resume", id: ID }));
    expect(confirmFirst({ type: "system", subtype: "init", session_id: ID })).toBeUndefined();
    expect(confirmFirst({ type: "system", subtype: "init", session_id: "another" })).toBe(cliSessionUnconfirmedMessage("system/init"));
    expect(confirmFirst({ type: "result", subtype: "error_during_execution" })).toBe(
      `${CLI_SESSION_RESUME_FAILED}: the CLI's first message was result/error_during_execution, not the init of the session sent`,
    );
    expect(confirmFirst({ type: "assistant" })).toBe(cliSessionUnconfirmedMessage("assistant"));
  });
});

/**
 * The block's canonical form, restated field by field as @guuey/host computed it before guuey#3550 moved it here: the
 * host now calls this code, so this pins that the move kept every hash (and a builder worker hashes alike).
 */
describe("the block equals the host's canonical form", () => {
  it("every field", () => {
    const block = claudeSessionBlock({ systemPrompt: SYSTEM, header: HEADER, servers: SERVERS, content: CONTENT, session: { mode: "start", id: ID }, configDir: CONFIG, cwd: CWD });
    expect(block).toEqual({
      hashVersion: CLI_SESSION_HASH_VERSION,
      systemPromptSha256: hashSystemPrompt(SYSTEM),
      headerShas: {
        model: sha256OfFields(["model", "claude-opus-5-5"]),
        permissionMode: sha256OfFields(["permissionMode", "canUseTool"]),
        tools: sha256OfFields(["tools", "a", "b", "allowed", "mcp__todo", "disallowed", "mcp__todo__drop"]),
        mcpConfig: sha256OfFields(["mcp", "local", "stdio", "", "todo", "http", "https://todo.example/mcp"]),
      },
      promptSha: hashUserBlocks(CONTENT),
      promptBytes: Buffer.byteLength(CONTENT.map((b) => b.text).join(""), "utf8"),
      lastPromptSha: hashUserText("the user's words"),
    });
  });

  it("a preset tools value hashes as no names; an explicit permissionMode wins over the callback", () => {
    const block = claudeSessionBlock({
      systemPrompt: SYSTEM,
      header: { tools: { type: "preset", preset: "claude_code" }, permissionMode: "bypassPermissions", canUseTool: () => undefined },
      servers: {},
      content: CONTENT,
      session: { mode: "start", id: ID },
      configDir: CONFIG,
      cwd: CWD,
    });
    expect(block.headerShas.tools).toBe(sha256OfFields(["tools", "allowed", "disallowed"]));
    expect(block.headerShas.permissionMode).toBe(sha256OfFields(["permissionMode", "bypassPermissions"]));
    expect(block.headerShas.mcpConfig).toBe(sha256OfFields(["mcp"]));
  });
});

describe("workerClaudeSessionGate: the platform set both (reads only the env)", () => {
  it.each([
    [{}, `${CLAUDE_CLI_CONFIG_DIR_ENV} is not set`],
    [{ [CLAUDE_CLI_CONFIG_DIR_ENV]: "" }, `${CLAUDE_CLI_CONFIG_DIR_ENV} is not set`],
    [{ [CLAUDE_CLI_CONFIG_DIR_ENV]: "home/.claude" }, `${CLAUDE_CLI_CONFIG_DIR_ENV} is not an absolute path`],
    [{ [CLAUDE_CLI_CONFIG_DIR_ENV]: "/home/.claude" }, `${CLAUDE_CODE_EXECUTABLE_ENV} is not set`],
  ])("%j: no session (%s)", (env, why) => {
    expect(workerClaudeSessionGate(env)).toEqual({ ok: false, why });
    expect(reads.count).toBe(0);
  });

  it("both set: the config root and the platform's binary", () => {
    expect(workerClaudeSessionGate({ [CLAUDE_CLI_CONFIG_DIR_ENV]: "/home/.claude", [CLAUDE_CODE_EXECUTABLE_ENV]: "/opt/claude" })).toEqual({
      ok: true,
      configDir: "/home/.claude",
      executable: "/opt/claude",
    });
  });
});

function invokeLine(cliSession?: InvokeCliSession, extra: Partial<Invoke> = {}): string {
  const invoke: Invoke = {
    type: "invoke",
    input: "the user's words",
    identity: { userId: "u1", authMode: "anonymous" },
    fs: { app: "/app", home: "/home", session: CWD },
    history: [],
    ...(cliSession !== undefined ? { cliSession } : {}),
    ...extra,
  };
  return JSON.stringify(invoke) + "\n";
}

async function serve(handler: NativeHandler, line: string, claudeSession = true) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveNativeOn(
    handler,
    {
      framework: "claude-agent-sdk",
      sdkName: "sdk",
      sdkVersion: "1.0.0",
      suspend: true,
      ...(claudeSession ? { claudeSession: true as const } : {}),
    },
    { input, output },
  );
  input.end(line);
  await done;
  const bytes = drained(output).trim();
  return bytes === "" ? [] : bytes.split("\n").map((l: string) => JSON.parse(l) as { type: string; [k: string]: unknown });
}

const sessionTurn = { systemPrompt: SYSTEM, header: HEADER, servers: SERVERS, content: CONTENT, cwd: CWD };
const platformEnv = (): void => {
  vi.stubEnv(CLAUDE_CLI_CONFIG_DIR_ENV, CONFIG);
  vi.stubEnv(CLAUDE_CODE_EXECUTABLE_ENV, "/opt/platform/claude");
};

describe("serveNative claudeSession", () => {
  it("T4: without the platform's variables, a start applies nothing and the hello is plain", async () => {
    vi.stubEnv(CLAUDE_CLI_CONFIG_DIR_ENV, undefined);
    vi.stubEnv(CLAUDE_CODE_EXECUTABLE_ENV, undefined);
    let answer: unknown = "unset";
    const events = await serve((_invoke, emit) => {
      answer = emit.claudeSession?.(sessionTurn);
    }, invokeLine({ mode: "start", id: ID }));
    expect(answer).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["hello", "done"]);
    expect(events[0]).not.toHaveProperty("capabilities");
    expect(events[0]).not.toHaveProperty("cliSession");
    expect(reads.count).toBe(0);
  });

  it("T4 + cto Q1: without them a RESUME refuses (it carries no history to answer from); zero fs reads", async () => {
    vi.stubEnv(CLAUDE_CLI_CONFIG_DIR_ENV, undefined);
    vi.stubEnv(CLAUDE_CODE_EXECUTABLE_ENV, undefined);
    const events = await serve((_invoke, emit) => {
      emit.claudeSession?.(sessionTurn);
      return "an answer without memory";
    }, invokeLine({ mode: "resume", id: ID }));
    expect(events).toEqual([
      { type: "hello", framework: "claude-agent-sdk", sdkName: "sdk", sdkVersion: "1.0.0" },
      { type: "error", message: `cli_session_resume_failed: not applied (${CLAUDE_CLI_CONFIG_DIR_ENV} is not set)` },
    ]);
    expect(reads.count).toBe(0);
  });

  it("with both set: the hello carries the capability and block; options run the platform's binary and persist", async () => {
    platformEnv();
    let answer: WorkerClaudeSession | undefined;
    const events = await serve((_invoke, emit) => {
      answer = emit.claudeSession?.(sessionTurn);
      emit.native({ type: "system", subtype: "init", session_id: ID });
    }, invokeLine({ mode: "start", id: ID }));
    expect(answer).toMatchObject({
      options: { sessionId: ID, persistSession: true, pathToClaudeCodeExecutable: "/opt/platform/claude" },
      env: { CLAUDE_CONFIG_DIR: CONFIG },
    });
    expect(events.map((e) => e.type)).toEqual(["hello", "native", "done"]);
    expect(events[0]).toMatchObject({ capabilities: [CLI_SESSION_CAPABILITY], cliSession: { hashVersion: CLI_SESSION_HASH_VERSION } });
    expect(answer?.block).toEqual(events[0]?.cliSession);
  });

  it("a resume's stored session is read under the config root and the cwd's real path", async () => {
    platformEnv();
    let answer: WorkerClaudeSession | undefined;
    await serve((_invoke, emit) => {
      answer = emit.claudeSession?.(sessionTurn);
    }, invokeLine({ mode: "resume", id: ID }));
    expect(answer?.options).toMatchObject({ resume: ID });
    expect(answer?.block.stored).toMatchObject({ readError: "missing" });
  });

  it("a malformed id: a plain hello, then the error; zero fs reads (T1)", async () => {
    platformEnv();
    const events = await serve((_invoke, emit) => {
      emit.claudeSession?.(sessionTurn);
    }, invokeLine({ mode: "start", id: "not-a-uuid" }));
    expect(events).toEqual([
      { type: "hello", framework: "claude-agent-sdk", sdkName: "sdk", sdkVersion: "1.0.0" },
      { type: "error", message: 'guuey: cliSession.id must be a UUID (got "not-a-uuid").' },
    ]);
    expect(reads.count).toBe(0);
  });

  it("an invoke with no session: a plain hello, no stderr line", async () => {
    platformEnv();
    let answer: unknown = "unset";
    const events = await serve((_invoke, emit) => {
      answer = emit.claudeSession?.(sessionTurn);
    }, invokeLine());
    expect(answer).toBeUndefined();
    expect(events[0]).toEqual({ type: "hello", framework: "claude-agent-sdk", sdkName: "sdk", sdkVersion: "1.0.0" });
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it("a preset system prompt: nothing applied, a plain hello", async () => {
    platformEnv();
    let answer: unknown = "unset";
    const events = await serve((_invoke, emit) => {
      answer = emit.claudeSession?.({ ...sessionTurn, systemPrompt: { type: "preset", preset: "claude_code" } });
    }, invokeLine({ mode: "start", id: ID }));
    expect(answer).toBeUndefined();
    expect(events[0]).not.toHaveProperty("cliSession");
  });

  it("a resume after the hello has gone refuses", async () => {
    platformEnv();
    const events = await serve((_invoke, emit) => {
      emit.text("first");
      emit.claudeSession?.(sessionTurn);
    }, invokeLine({ mode: "resume", id: ID }));
    expect(events.map((e) => e.type)).toEqual(["hello", "text", "error"]);
    expect(events[2]).toEqual({ type: "error", message: "cli_session_resume_failed: not applied (the hello was already sent)" });
  });

  it("after the hello has gone, claudeSession applies nothing", async () => {
    platformEnv();
    let answer: unknown = "unset";
    const events = await serve((_invoke, emit) => {
      emit.text("first");
      answer = emit.claudeSession?.(sessionTurn);
    }, invokeLine({ mode: "start", id: ID }));
    expect(answer).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["hello", "text", "done"]);
    expect(events[0]).not.toHaveProperty("cliSession");
  });

  it("without the opt-in the hello goes first, as before, and claudeSession applies nothing", async () => {
    platformEnv();
    let answer: unknown = "unset";
    const events = await serve(
      (_invoke, emit) => {
        answer = emit.claudeSession?.(sessionTurn);
      },
      invokeLine({ mode: "start", id: ID }),
      false,
    );
    expect(answer).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["hello", "done"]);
    expect(events[0]).not.toHaveProperty("cliSession");
  });
});

/**
 * cto's read (D4): with the opt-in, EVERY write to fd 3 passes through the one hello, so the hello is always the
 * first event. The table is typed over NativeEmit's keys and checked against the emit the handler receives, so a new
 * emit fails here until it is listed. endThread writes nothing (its request rides `done`); claudeSession is the
 * hello's own door.
 */
describe("every fd-3 write passes through the one hello", () => {
  const writes = {
    native: (emit) => emit.native({ type: "assistant" }),
    text: (emit) => emit.text("words"),
    suspend: (emit) => emit.suspend('{"run":"state"}', ["ask_1"]),
  } satisfies Record<Exclude<keyof NativeEmit, "endThread" | "claudeSession">, (emit: NativeEmit) => unknown>;

  it("the table names every emit", async () => {
    let keys: string[] = [];
    await serve((_invoke, emit) => {
      keys = Object.keys(emit).sort();
    }, invokeLine());
    expect(keys).toEqual([...Object.keys(writes), "claudeSession", "endThread"].sort());
  });

  // The suspend offer rides every invoke here, so `suspend` really writes through the suspend writer.
  it.each(Object.entries(writes))("%s first: the hello leads", async (name, write) => {
    const events = await serve((_invoke, emit) => {
      write(emit);
    }, invokeLine(undefined, { suspend: { maxEnvelopeBytes: 1024 } }));
    expect(events.map((e) => e.type)).toContain(name);
    expect(events[0]?.type).toBe("hello");
    expect(events.filter((e) => e.type === "hello")).toHaveLength(1);
  });

  it("done first (the handler wrote nothing): the hello leads", async () => {
    const events = await serve(() => "result", invokeLine());
    expect(events.map((e) => e.type)).toEqual(["hello", "done"]);
  });

  it("error first (the handler threw at once): the hello leads", async () => {
    const events = await serve(() => {
      throw new Error("boom");
    }, invokeLine());
    expect(events.map((e) => e.type)).toEqual(["hello", "error"]);
  });

  it("endThread writes nothing on its own", async () => {
    const events = await serve((_invoke, emit) => {
      emit.endThread({ code: "FULL", message: "This chat is full." });
      throw new Error("stop");
    }, invokeLine());
    expect(events.map((e) => e.type)).toEqual(["hello", "error"]);
  });
});
