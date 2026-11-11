/**
 * Thread resume, the host's side (guuey#3407 B3 v1.9, wire v1.2): the invoke's `cliSession` on the SDK options, the
 * first hello's block, the positive resume check, and the bound root. A fake `query` records what the host hands the
 * SDK; no CLI runs here (the pinned CLI's behaviour is R7h's, measured in its harness).
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  anthropicUserContent,
  CLAUDE_CLI_FIXED_ROOT,
  CLAUDE_CLI_ROOT_ENV,
  CLI_SESSION_CAPABILITY,
  CLI_SESSION_HASH_VERSION,
  CLI_SESSION_RESUME_FAILED,
  createEmitter,
  type AnthropicUserBlock,
  type WorkerEvent,
  type WorkerHelloEvent,
} from "@guuey/worker";
import { isBoundRoot, runInvoke, type HostInvoke, type QueryFn, type QueryHandle } from "./claude.js";
import { buildOptions, claudeTurnContext } from "./claude-options.js";
import { hashSystemPrompt, hashUserBlocks, hashUserText } from "./cli-session-hash.js";

const SESSION = mkdtempSync(join(tmpdir(), "host-cli-session-"));
afterAll(() => rmSync(SESSION, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const HISTORY_LINE = "an earlier turn the Router replayed";

function invoke(over: Partial<HostInvoke> = {}): HostInvoke {
  return {
    input: "the user's words",
    identity: { userId: "u1", authMode: "authenticated" },
    fs: { app: "/fs/app", home: "/fs/home", session: SESSION },
    history: [{ role: "user", text: HISTORY_LINE }],
    ...over,
  };
}

/**
 * SDK message fixtures. `SDKMessage` is the SDK's frozen ~30-arm union (someone else's surface); the host reads only
 * `.type`, `.subtype`, `.session_id` and the result fields, so the fixtures carry those and are coerced, as
 * `claude.test.ts`'s are. Test-only.
 */
function initMessage(sessionId: string): SDKMessage {
  const msg: { type: "system"; subtype: "init"; session_id: string } = { type: "system", subtype: "init", session_id: sessionId };
  return msg as unknown as SDKMessage;
}
function resultMessage(subtype: string, isError = false): SDKMessage {
  const msg = { type: "result" as const, subtype, result: "ok", stop_reason: "end_turn", is_error: isError };
  return msg as unknown as SDKMessage;
}

/** One turn over a fake query; returns the events, the options and the user message the SDK was handed. */
async function oneTurn(inv: HostInvoke, ...stream: SDKMessage[]) {
  const events: WorkerEvent[] = [];
  const sink = { write: (s: string) => { for (const l of s.split("\n")) if (l.trim()) events.push(JSON.parse(l) as WorkerEvent); } };
  let options: Options | undefined;
  let content: SDKUserMessage["message"]["content"] | undefined;
  let queried = false;
  const query: QueryFn = (args) => {
    queried = true;
    options = args.options;
    void (async () => { for await (const m of args.prompt) content = m.message.content; })();
    const handle: QueryHandle = {
      setMcpServers: () => Promise.resolve({ added: [], removed: [], errors: {} }),
      mcpServerStatus: () => Promise.resolve([]),
      close: () => undefined,
      async *[Symbol.asyncIterator]() { for (const m of stream) yield m; },
    };
    return handle;
  };
  await runInvoke({ systemPrompt: "the agent's prompt" }, inv, { apiKey: "test-key", listCredentials: () => [] }, createEmitter(sink), query);
  const first = events[0];
  const hello: WorkerHelloEvent | undefined = first?.type === "hello" ? first : undefined;
  return { events, options, content, queried, hello };
}

const texts = (content: SDKUserMessage["message"]["content"] | undefined): string[] =>
  Array.isArray(content) ? content.flatMap((b) => (b.type === "text" ? [b.text] : [])) : [];
const blocksOf = (content: SDKUserMessage["message"]["content"] | undefined): AnthropicUserBlock[] =>
  Array.isArray(content) ? content.flatMap((b): AnthropicUserBlock[] => (b.type === "text" ? [{ type: "text", text: b.text }] : [])) : [];

describe("R1: no cliSession is today's turn exactly", () => {
  it("neither sessionId nor resume, history rendered, the hello first and without the capability or block", async () => {
    const t = await oneTurn(invoke(), resultMessage("success"));
    expect(t.options?.sessionId).toBeUndefined();
    expect(t.options?.resume).toBeUndefined();
    expect(texts(t.content).join("\n")).toContain(HISTORY_LINE);
    expect(t.hello?.capabilities ?? []).not.toContain(CLI_SESSION_CAPABILITY);
    expect(t.hello?.cliSession).toBeUndefined();
    expect(t.events.map((e) => e.type)).toEqual(["hello", "native", "done"]);
  });

  // R4 (the host never derives an id) holds by type: `HostInvoke` carries no thread id to derive one from, and the
  // only id the host runs is `cliSession.id` (R2, R3).

  it("the lead's PIN: without cliSession the SDK gets exactly the pre-B3 options and message, and no stored session is read", async () => {
    const inv = invoke();
    const t = await oneTurn(inv, resultMessage("success"));
    // What the host built before B3 for the same turn: buildOptions and the turn context, then the invoke's own
    // content, exactly as 52febe6567cf composed them. The per-invoke roots are random per turn, so those five
    // env values are compared by presence, not value.
    const snapshot = { systemPrompt: "the agent's prompt" };
    const cliDirs = { config: "/r/config", cache: "/r/cache", xdgConfig: "/r/xc", xdgData: "/r/xd", xdgState: "/r/xs" };
    const ctx = { input: inv.input, identity: inv.identity, fs: inv.fs, cliDirs, history: inv.history, apiKey: "test-key", listCredentials: () => [] };
    const before = buildOptions(snapshot, ctx);
    const ROOT_ENV = ["CLAUDE_CONFIG_DIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"];
    const plain = (o: Options | undefined) => {
      const env: { [k: string]: string | undefined } = { ...(o?.env ?? {}) };
      for (const k of ROOT_ENV) env[k] = env[k] === undefined ? "absent" : "set";
      return JSON.parse(JSON.stringify({ ...o, env }));
    };
    expect(plain(t.options)).toEqual(plain(before));
    expect(Object.keys(t.options ?? {}).sort()).toEqual(Object.keys(before).sort());
    expect(t.content).toEqual([...claudeTurnContext(snapshot, ctx).map((text) => ({ type: "text", text })), ...anthropicUserContent(inv)]);
    expect(t.hello?.capabilities ?? []).not.toContain(CLI_SESSION_CAPABILITY);
    expect(t.hello !== undefined && "cliSession" in t.hello).toBe(false);
  });
});

describe("R2: start", () => {
  it("sessionId is the Router's id, no resume, history rendered; the hello announces and carries the block", async () => {
    const t = await oneTurn(invoke({ cliSession: { mode: "start", id: ID } }), resultMessage("success"));
    expect(t.options?.sessionId).toBe(ID);
    expect(t.options?.resume).toBeUndefined();
    expect(t.options?.forkSession).toBeUndefined();
    expect(texts(t.content).join("\n")).toContain(HISTORY_LINE);
    expect(t.hello?.capabilities).toContain(CLI_SESSION_CAPABILITY);
    const block = t.hello?.cliSession;
    expect(block?.hashVersion).toBe(CLI_SESSION_HASH_VERSION);
    expect(block?.stored).toBeUndefined();
    expect(t.events[0].type).toBe("hello");
  });

  it("R18/R25 (start shape, the loadHistory block): the shas are of exactly what the SDK was handed", async () => {
    const t = await oneTurn(invoke({ cliSession: { mode: "start", id: ID } }), resultMessage("success"));
    const block = t.hello?.cliSession;
    expect(block?.promptSha).toBe(hashUserBlocks(blocksOf(t.content)));
    expect(block?.systemPromptSha256).toBe(hashSystemPrompt(String(t.options?.systemPrompt)));
    expect(block?.lastPromptSha).toBe(hashUserText("the user's words"));
    expect(block?.promptBytes).toBe(texts(t.content).reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0));
  });
});

describe("R3: resume", () => {
  it("resume is the Router's id, no sessionId and no fork; no history section even though the invoke sent one", async () => {
    const t = await oneTurn(invoke({ cliSession: { mode: "resume", id: ID } }), initMessage(ID), resultMessage("success"));
    expect(t.options?.resume).toBe(ID);
    expect(t.options?.sessionId).toBeUndefined();
    expect(t.options?.forkSession).toBeUndefined();
    expect(texts(t.content).join("\n")).not.toContain(HISTORY_LINE);
    expect(texts(t.content)[0].startsWith("<turn_context>\n")).toBe(true);
  });

  it("R25 (resume shape, no history): promptSha is of exactly the blocks handed to the SDK", async () => {
    const t = await oneTurn(invoke({ cliSession: { mode: "resume", id: ID } }), initMessage(ID), resultMessage("success"));
    expect(t.hello?.cliSession?.promptSha).toBe(hashUserBlocks(blocksOf(t.content)));
  });

  it("the hello carries the stored measures; with no session written they read missing", async () => {
    const t = await oneTurn(invoke({ cliSession: { mode: "resume", id: ID } }), initMessage(ID), resultMessage("success"));
    expect(t.hello?.cliSession?.stored).toMatchObject({ readError: "missing", walks: [], entries: [] });
  });
});

describe("R14: a resume is confirmed by the init of the id sent, before anything is forwarded", () => {
  it("the init of the id: the turn runs and is forwarded", async () => {
    const t = await oneTurn(invoke({ cliSession: { mode: "resume", id: ID } }), initMessage(ID), resultMessage("success"));
    expect(t.events.map((e) => e.type)).toEqual(["hello", "native", "native", "done"]);
  });

  it.each([
    ["an error result first (a missing or unreadable session, R7b)", [resultMessage("error_during_execution", true)]],
    ["the init of another session", [initMessage("00000000-0000-4000-8000-000000000000"), resultMessage("success")]],
  ])("%s: CLI_SESSION_RESUME_FAILED, nothing forwarded, no user message sent", async (_label, stream) => {
    const t = await oneTurn(invoke({ cliSession: { mode: "resume", id: ID } }), ...stream);
    expect(t.events.map((e) => e.type)).toEqual(["hello", "error"]);
    const err = t.events[1];
    expect(err.type === "error" && err.message.startsWith(`${CLI_SESSION_RESUME_FAILED}:`)).toBe(true);
    expect(t.content).toBeUndefined();
  });

  it("mutant guard: a start is never held for an init", async () => {
    const t = await oneTurn(invoke({ cliSession: { mode: "start", id: ID } }), resultMessage("success"));
    expect(t.events.map((e) => e.type)).toEqual(["hello", "native", "done"]);
  });
});

describe("R5: a malformed id stops before any spawn", () => {
  it.each(["not-a-uuid", "6f9619ff8b864011b42d00c04fc964ff", " " + ID])("%j: a hello without the capability, then one error, no query", async (id) => {
    const t = await oneTurn(invoke({ cliSession: { mode: "start", id } }), resultMessage("success"));
    expect(t.queried).toBe(false);
    expect(t.events.map((e) => e.type)).toEqual(["hello", "error"]);
    expect(t.hello?.capabilities ?? []).not.toContain(CLI_SESSION_CAPABILITY);
  });
});

describe("R23: the bound root is checked, never made", () => {
  const root = (): string => mkdtempSync(join(tmpdir(), "bound-root-"));
  const tree = (r: string): string => {
    mkdirSync(join(r, "config", "projects", "-session"), { recursive: true });
    return r;
  };

  it("absent → not bound (the caller makes it); the exact tree → bound", () => {
    const r = root();
    try {
      expect(isBoundRoot(join(r, "nothing-here"))).toBe(false);
      expect(isBoundRoot(tree(r))).toBe(true);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it.each([
    ["an extra entry in config/", (r: string) => writeFileSync(join(r, "config", ".claude.json"), "{}")],
    ["an extra entry beside config/", (r: string) => mkdirSync(join(r, "cache"))],
    ["a second session directory", (r: string) => mkdirSync(join(r, "config", "projects", "-other"))],
    ["projects/ is a link", (r: string) => {
      rmSync(join(r, "config", "projects"), { recursive: true });
      mkdirSync(join(r, "elsewhere", "-session"), { recursive: true });
      symlinkSync(join(r, "elsewhere"), join(r, "config", "projects"));
    }],
  ])("%s refuses (mutant: mkdir -p the tree)", (_label, plant) => {
    const r = tree(root());
    try {
      plant(r);
      expect(() => isBoundRoot(r)).toThrow();
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it(`a bound turn under ${CLAUDE_CLI_FIXED_ROOT}: the host makes only cache/ and the XDG roots, and leaves the bound session untouched after the turn`, async () => {
    expect(existsSync(CLAUDE_CLI_FIXED_ROOT)).toBe(false);
    const bind = join(CLAUDE_CLI_FIXED_ROOT, "config", "projects", "-session");
    mkdirSync(bind, { recursive: true });
    writeFileSync(join(bind, `${ID}.jsonl`), "{}\n");
    vi.stubEnv(CLAUDE_CLI_ROOT_ENV, CLAUDE_CLI_FIXED_ROOT);
    try {
      const t = await oneTurn(invoke({ cliSession: { mode: "start", id: ID } }), resultMessage("success"));
      expect(t.options?.env?.CLAUDE_CONFIG_DIR).toBe(join(CLAUDE_CLI_FIXED_ROOT, "config"));
      expect(t.events.at(-1)?.type).toBe("done");
      expect(readFileSync(join(bind, `${ID}.jsonl`), "utf8")).toBe("{}\n");
      expect(existsSync(join(CLAUDE_CLI_FIXED_ROOT, "cache"))).toBe(false);
      expect(existsSync(join(CLAUDE_CLI_FIXED_ROOT, "xdg-state"))).toBe(false);
    } finally {
      rmSync(CLAUDE_CLI_FIXED_ROOT, { recursive: true, force: true });
    }
  });
});

/**
 * On the pod the thread directory is a bind MOUNT at `config/projects/-session`: a recursive remove of the root would
 * descend into it and empty the thread's store, link-safe or not. After a bound turn, on success and on failure, the
 * thread's session file must still be there (grown, when the CLI wrote to it) and every other file in the bind must
 * keep its bytes. Mutant: remove the bound root recursively, as an unbound root is, which turns every case here RED.
 */
describe("a bound turn never empties the thread's store (success and failure)", () => {
  const bind = join(CLAUDE_CLI_FIXED_ROOT, "config", "projects", "-session");
  const file = join(bind, `${ID}.jsonl`);
  const sentinel = join(bind, "sentinel.bin");
  const SENTINEL = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13]);

  /** One resumed turn under the bound fixed root; `append` stands in for the CLI writing the session file. */
  async function boundTurn(stream: (append: () => void) => AsyncGenerator<SDKMessage>) {
    expect(existsSync(CLAUDE_CLI_FIXED_ROOT)).toBe(false);
    mkdirSync(bind, { recursive: true });
    writeFileSync(file, '{"type":"queue-operation"}\n');
    writeFileSync(sentinel, SENTINEL);
    const before = statSync(file).size;
    vi.stubEnv(CLAUDE_CLI_ROOT_ENV, CLAUDE_CLI_FIXED_ROOT);
    const events: WorkerEvent[] = [];
    const sink = { write: (s: string) => { for (const l of s.split("\n")) if (l.trim()) events.push(JSON.parse(l) as WorkerEvent); } };
    const sent: SDKUserMessage[] = [];
    const query: QueryFn = (args) => {
      void (async () => { for await (const m of args.prompt) sent.push(m); })();
      const handle: QueryHandle = {
        setMcpServers: () => Promise.resolve({ added: [], removed: [], errors: {} }),
        mcpServerStatus: () => Promise.resolve([]),
        close: () => undefined,
        [Symbol.asyncIterator]: () => stream(() => appendFileSync(file, '{"type":"user"}\n')),
      };
      return handle;
    };
    await runInvoke({ systemPrompt: "the agent's prompt" }, invoke({ cliSession: { mode: "resume", id: ID } }), { apiKey: "test-key", listCredentials: () => [] }, createEmitter(sink), query);
    return {
      last: events.at(-1),
      before,
      after: existsSync(file) ? statSync(file).size : -1,
      sentinel: existsSync(sentinel) ? readFileSync(sentinel) : null,
      cache: existsSync(join(CLAUDE_CLI_FIXED_ROOT, "cache")),
    };
  }

  it("a resumed turn that succeeds: the session file is there and has grown, the sentinel keeps its bytes", async () => {
    try {
      const t = await boundTurn(async function* (append) { yield initMessage(ID); append(); yield resultMessage("success"); });
      expect(t.last?.type).toBe("done");
      expect(t.after).toBeGreaterThan(t.before);
      expect(t.sentinel).toEqual(SENTINEL);
      expect(t.cache).toBe(false);
    } finally {
      rmSync(CLAUDE_CLI_FIXED_ROOT, { recursive: true, force: true });
    }
  });

  it("a resumed turn whose CLI fails mid-stream: the same", async () => {
    try {
      const t = await boundTurn(async function* (append) { yield initMessage(ID); append(); throw new Error("the CLI exited"); });
      expect(t.last?.type).toBe("error");
      expect(t.after).toBeGreaterThan(t.before);
      expect(t.sentinel).toEqual(SENTINEL);
    } finally {
      rmSync(CLAUDE_CLI_FIXED_ROOT, { recursive: true, force: true });
    }
  });

  it("a resume the CLI does not confirm: the file and the sentinel are kept as they were", async () => {
    try {
      const t = await boundTurn(async function* () { yield resultMessage("error_during_execution", true); });
      expect(t.last?.type === "error" ? t.last.message : "").toContain(CLI_SESSION_RESUME_FAILED);
      expect(t.after).toBe(t.before);
      expect(t.sentinel).toEqual(SENTINEL);
    } finally {
      rmSync(CLAUDE_CLI_FIXED_ROOT, { recursive: true, force: true });
    }
  });
});
