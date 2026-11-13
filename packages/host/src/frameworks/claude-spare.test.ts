import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CanUseTool, ClaimOptions, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createEmitter, type WorkerEvent } from "@guuey/worker";
import { prewarmClaudeSpare, runInvoke, type HostInvoke, type HostRuntime, type QueryFn, type QueryHandle } from "./claude.js";
import {
  CLAUDE_SPARE_PLACEHOLDER_TOKEN,
  SPARE_PARKING_DIR,
  delegatingCanUseTool,
  parseSpareTemplate,
  spareKeyOf,
  type ParkedSpare,
  type PrewarmFn,
  type SpareHandle,
} from "./claude-spare.js";

const SESSION = mkdtempSync(join(tmpdir(), "host-spare-session-"));
afterAll(() => rmSync(SESSION, { recursive: true, force: true }));

const RUNTIME: HostRuntime = { baseUrl: "http://127.0.0.1:9911", authToken: "turn-token", listCredentials: () => [] };

function invoke(over: Partial<HostInvoke> = {}): HostInvoke {
  return {
    input: "hi",
    identity: { userId: "u1", authMode: "anonymous" },
    fs: { app: "/fs/app", home: "/fs/home", session: SESSION },
    history: [],
    ...over,
  };
}

function collector(): { events: WorkerEvent[]; sink: { write(s: string): void } } {
  const events: WorkerEvent[] = [];
  return {
    events,
    sink: {
      write(s: string) {
        for (const line of s.split("\n")) if (line.trim().length > 0) events.push(JSON.parse(line) as WorkerEvent);
      },
    },
  };
}

/** A terminal result fixture; `runInvoke` reads only `.type`, `.subtype` and `.result` on it. */
function resultMessage(): SDKMessage {
  const msg: { type: "result"; subtype: string; result: string; stop_reason: string; is_error: boolean } = {
    type: "result",
    subtype: "success",
    result: "ok",
    stop_reason: "end_turn",
    is_error: false,
  };
  return msg as unknown as SDKMessage;
}

/** A fake Query that reads its prompt's one message into `seen`, then ends with a result. */
function answeringQuery(prompt: AsyncIterable<SDKUserMessage>, seen: { messages: number }, closed: { count: number }): QueryHandle {
  return {
    setMcpServers: () => Promise.resolve({ added: [], removed: [], errors: {} }),
    mcpServerStatus: () => Promise.resolve([]),
    close: () => {
      closed.count += 1;
    },
    async *[Symbol.asyncIterator]() {
      for await (const _message of prompt) {
        seen.messages += 1;
        break;
      }
      yield resultMessage();
    },
  };
}

/** A fake SDK spare: records its claim, answers it as told, and counts closes. */
function fakeSpare(answer: "accept" | "refuse"): {
  spare: SpareHandle;
  claims: ClaimOptions[];
  seen: { messages: number };
  closed: { count: number };
  queryClosed: { count: number };
} {
  const claims: ClaimOptions[] = [];
  const seen = { messages: 0 };
  const closed = { count: 0 };
  const queryClosed = { count: 0 };
  let settle!: (refused: boolean) => void;
  const claimed = new Promise<{ cwd: string; sessionId: string }>((resolve, reject) => {
    settle = (refused) =>
      refused ? reject(new Error("cwd_not_found: no such folder")) : resolve({ cwd: SESSION, sessionId: "00000000-0000-4000-8000-000000000000" });
  });
  claimed.catch(() => undefined);
  const spare: SpareHandle = {
    claim({ prompt, options }) {
      claims.push(options);
      settle(answer === "refuse");
      if (answer === "refuse") {
        // A refused claim's prompt must never yield: read it in the background and count.
        void (async () => {
          for await (const _message of prompt) seen.messages += 1;
        })();
        return {
          setMcpServers: () => Promise.resolve({ added: [], removed: [], errors: {} }),
          mcpServerStatus: () => Promise.resolve([]),
          close: () => {
            queryClosed.count += 1;
          },
          async *[Symbol.asyncIterator]() {},
        };
      }
      return answeringQuery(prompt, seen, queryClosed);
    },
    claimed,
    exited: new Promise<void>(() => undefined),
    close: () => {
      closed.count += 1;
    },
  };
  return { spare, claims, seen, closed, queryClosed };
}

/** Park a spare through the real boot path with a fake `prewarm`, recording the options it was started with. */
async function park(spare: SpareHandle, template: HostInvoke = invoke()): Promise<{ parked: ParkedSpare; started: Options[] }> {
  const started: Options[] = [];
  const prewarm: PrewarmFn = (params) => {
    started.push(params.options);
    return Promise.resolve(spare);
  };
  const parked = await prewarmClaudeSpare({}, template, RUNTIME, prewarm);
  if (parked === undefined) throw new Error("the spare did not park");
  return { parked, started };
}

describe("parseSpareTemplate", () => {
  it("refuses a value that is not a JSON object", () => {
    expect(parseSpareTemplate("1").ok).toBe(false);
    expect(parseSpareTemplate("not json").ok).toBe(false);
    expect(parseSpareTemplate("[]").ok).toBe(false);
  });

  it("refuses a template that names a CLI session", () => {
    const raw = JSON.stringify({
      identity: { userId: "u", authMode: "anonymous" },
      fs: { app: "/app", home: "/home", session: "/session" },
      cliSession: { id: "00000000-0000-4000-8000-000000000000", mode: "start" },
    });
    expect(parseSpareTemplate(raw)).toEqual({ ok: false, reason: "GUUEY_CLAUDE_SPARE may not carry cliSession" });
  });

  it("reads identity, fs and the class flags with the invoke parser", () => {
    const raw = JSON.stringify({
      identity: { userId: "u", authMode: "authenticated" },
      fs: { app: "/app", home: "/home", session: "/session" },
      fsBound: true,
      gguiAttached: false,
    });
    const template = parseSpareTemplate(raw);
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    expect(template.invoke.identity.authMode).toBe("authenticated");
    expect(template.invoke.fs.session).toBe("/session");
    expect(template.invoke.fsBound).toBe(true);
    expect(template.invoke.input).toBe("");
  });
});

describe("spareKeyOf", () => {
  const base: Options = { model: "m", systemPrompt: "s", env: { B: "2", A: "1" }, tools: [] };

  it("ignores what the claim or the turn's callback sets", () => {
    const allow: CanUseTool = () => Promise.resolve({ behavior: "allow", updatedInput: {} });
    expect(spareKeyOf({ ...base, cwd: "/x", additionalDirectories: ["/y"], allowedTools: ["mcp__a"], canUseTool: allow })).toBe(spareKeyOf(base));
    expect(spareKeyOf({ ...base, env: { A: "1", B: "2" } })).toBe(spareKeyOf(base));
  });

  it("differs on a field fixed at prewarm", () => {
    expect(spareKeyOf({ ...base, systemPrompt: "other" })).not.toBe(spareKeyOf(base));
    expect(spareKeyOf({ ...base, disallowedTools: ["mcp__a__b"] })).not.toBe(spareKeyOf(base));
    expect(spareKeyOf({ ...base, env: { A: "1", B: "3" } })).not.toBe(spareKeyOf(base));
  });
});

describe("delegatingCanUseTool", () => {
  it("denies before a turn binds its check, and asks that check after", async () => {
    const permission = delegatingCanUseTool();
    const signal = new AbortController().signal;
    const before = await permission.canUseTool("Bash", {}, { signal, toolUseID: "t1", requestId: "r1" });
    expect(before?.behavior).toBe("deny");
    permission.bind(() => Promise.resolve({ behavior: "allow", updatedInput: { x: 1 } }));
    const after = await permission.canUseTool("Bash", {}, { signal, toolUseID: "t2", requestId: "r2" });
    expect(after).toEqual({ behavior: "allow", updatedInput: { x: 1 } });
  });
});

describe("prewarmClaudeSpare", () => {
  it("starts nothing without a model-egress base URL", async () => {
    const prewarm = vi.fn<PrewarmFn>();
    const parked = await prewarmClaudeSpare({}, invoke(), { listCredentials: () => [] }, prewarm);
    expect(parked).toBeUndefined();
    expect(prewarm).not.toHaveBeenCalled();
  });

  it("parks with no MCP server, no credential in the environment, and a constant parking directory under its own root", async () => {
    const { spare } = fakeSpare("accept");
    const { parked, started } = await park(spare);
    expect(started).toHaveLength(1);
    const options = started[0];
    expect(options.mcpServers).toBeUndefined();
    expect(options.cwd).toBe(join(parked.root, SPARE_PARKING_DIR));
    expect(existsSync(join(parked.root, SPARE_PARKING_DIR))).toBe(true);
    expect(options.additionalDirectories).toBeUndefined();
    expect(options.canUseTool).toBeDefined();
    const envValues = Object.values(options.env ?? {});
    expect(envValues).not.toContain(CLAUDE_SPARE_PLACEHOLDER_TOKEN);
    expect(envValues).not.toContain("turn-token");
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(parked.cliDirs.config);
    rmSync(parked.root, { recursive: true, force: true });
  });

  it("removes its root and parks nothing when prewarm fails", async () => {
    let root: string | undefined;
    const prewarm: PrewarmFn = (params) => {
      root = params.options.env?.CLAUDE_CONFIG_DIR;
      return Promise.reject(new Error("initialize timed out"));
    };
    expect(await prewarmClaudeSpare({}, invoke(), RUNTIME, prewarm)).toBeUndefined();
    expect(root).toBeDefined();
    expect(existsSync(root ?? "")).toBe(false);
  });
});

describe("runInvoke with a parked spare", () => {
  it("claims the spare for a turn that fits it, and never starts a cold CLI", async () => {
    const fake = fakeSpare("accept");
    const { parked } = await park(fake.spare);
    const query = vi.fn<QueryFn>();
    const { events, sink } = collector();
    await runInvoke({}, invoke(), RUNTIME, createEmitter(sink), query, {}, () => Promise.resolve(parked));
    expect(query).not.toHaveBeenCalled();
    expect(fake.claims).toEqual([{ cwd: SESSION, additionalDirectories: ["/fs/home", "/fs/app"] }]);
    expect(fake.seen.messages).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["hello", "native", "done"]);
    expect(existsSync(parked.root)).toBe(false);
  });

  it("closes the spare and starts cold when the turn's fixed options differ", async () => {
    const fake = fakeSpare("accept");
    const { parked } = await park(fake.spare);
    const seen = { messages: 0 };
    const query = vi.fn<QueryFn>((args) => answeringQuery(args.prompt, seen, { count: 0 }));
    const { events, sink } = collector();
    // fsBound adds the built-in tools: a different catalog from the spare's.
    await runInvoke({}, invoke({ fsBound: true }), RUNTIME, createEmitter(sink), query, {}, () => Promise.resolve(parked));
    expect(fake.claims).toHaveLength(0);
    expect(fake.closed.count).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(seen.messages).toBe(1);
    expect(events.at(-1)?.type).toBe("done");
    expect(existsSync(parked.root)).toBe(false);
  });

  it("starts cold after a refused claim, and the refused prompt never yields", async () => {
    const fake = fakeSpare("refuse");
    const { parked } = await park(fake.spare);
    const seen = { messages: 0 };
    const query = vi.fn<QueryFn>((args) => answeringQuery(args.prompt, seen, { count: 0 }));
    const { events, sink } = collector();
    await runInvoke({}, invoke(), RUNTIME, createEmitter(sink), query, {}, () => Promise.resolve(parked));
    expect(fake.claims).toHaveLength(1);
    expect(fake.queryClosed.count).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(seen.messages).toBe(1);
    expect(fake.seen.messages).toBe(0);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("closes the spare for a turn that names a CLI session", async () => {
    const fake = fakeSpare("accept");
    const { parked } = await park(fake.spare);
    const query = vi.fn<QueryFn>((args) => answeringQuery(args.prompt, { messages: 0 }, { count: 0 }));
    const { sink } = collector();
    const session = { id: "11111111-1111-4111-8111-111111111111", mode: "start" as const };
    await runInvoke({}, invoke({ cliSession: session }), RUNTIME, createEmitter(sink), query, {}, () => Promise.resolve(parked));
    expect(fake.closed.count).toBe(1);
    expect(fake.claims).toHaveLength(0);
    expect(query).toHaveBeenCalledTimes(1);
    expect(existsSync(parked.root)).toBe(false);
  });
});
