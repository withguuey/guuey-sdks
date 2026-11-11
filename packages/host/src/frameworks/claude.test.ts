import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { anthropicUserContent, createEmitter, type WorkerEvent } from "@guuey/worker";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { awaitMcpReady, runInvoke, type HostInvoke, type QueryFn, type QueryHandle } from "./claude.js";
import { A2UI_GUUEY_CATALOG_ID, A2UI_SECTION, FIRST_IMPRESSION_SHOWN_HEADING } from "../preamble.js";

/** Collect every emitted WorkerEvent into an array (the fd-3 sink, in memory). */
function collector(): { events: WorkerEvent[]; sink: { write(s: string): void } } {
  const events: WorkerEvent[] = [];
  return {
    events,
    sink: {
      write(s: string) {
        for (const line of s.split("\n")) {
          if (line.trim().length > 0) events.push(JSON.parse(line) as WorkerEvent);
        }
      },
    },
  };
}

function invoke(over: Partial<HostInvoke> = {}): HostInvoke {
  return {
    input: "hi",
    identity: { userId: "u1", authMode: "anonymous" },
    fs: { app: "/fs/app", home: "/fs/home", session: "/fs/session" },
    history: [],
    ...over,
  };
}

/**
 * A streamed assistant-message fixture. `SDKMessage` is the SDK's frozen ~30-arm
 * union (someone else's surface); `runInvoke` treats each message as opaque JSON,
 * reading only `.type` (and, on the result arm, `.subtype`/`.result`). Building a
 * fully-populated arm would add only noise, so the fixture is coerced to
 * `SDKMessage` for the pass-through. Test-only; never in shipping code.
 */
function assistantMessage(text: string): SDKMessage {
  const msg: { type: "assistant"; uuid: string; message: { role: "assistant"; text: string } } = {
    type: "assistant",
    uuid: "m-1",
    message: { role: "assistant", text },
  };
  return msg as unknown as SDKMessage;
}

/** A terminal result-message fixture (the only arm `runInvoke` reads beyond `.type`). */
function resultMessage(subtype: string, result: string, isError = false): SDKMessage {
  const msg: { type: "result"; subtype: string; result: string; stop_reason: string; is_error: boolean } = {
    type: "result",
    subtype,
    result,
    stop_reason: "end_turn",
    is_error: isError,
  };
  return msg as unknown as SDKMessage;
}

/** The control half of a fake `Query`: no MCP servers, every call answered at once. */
const idleControl = {
  setMcpServers: () => Promise.resolve({ added: [], removed: [], errors: {} }),
  mcpServerStatus: () => Promise.resolve([]),
  close: () => undefined,
};

/** A fake `Query` over a fixed list of messages (no yield-less generator). */
function streamOf(...messages: SDKMessage[]): QueryHandle {
  return {
    ...idleControl,
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
  };
}

/** A fake `Query` whose message stream throws on first iteration. */
function throwingStream(message: string): QueryHandle {
  return {
    ...idleControl,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKMessage>> {
          return Promise.reject(new Error(message));
        },
      };
    },
  };
}

// A real session directory: an image turn stores its images there before it runs.
const SESSION = mkdtempSync(join(tmpdir(), "host-claude-session-"));
afterAll(() => rmSync(SESSION, { recursive: true, force: true }));

/** What one turn handed the SDK: the options' system prompt and thinking knob, and the user message's content. */
interface TurnSeen {
  systemPrompt?: string;
  thinking?: unknown;
  content?: SDKUserMessage["message"]["content"];
}

/** Every text block of a user message's content, in order. */
function textsOf(content: SDKUserMessage["message"]["content"] | undefined): string[] {
  if (content === undefined) return [];
  if (typeof content === "string") return [content];
  return content.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

/** Run one turn on a fake query that reads the one user message, and return what the SDK was handed. */
async function turnFor(over: Partial<HostInvoke>, snapshot: { model?: string; systemPrompt?: string } = {}): Promise<TurnSeen> {
  const { sink } = collector();
  const seen: TurnSeen = {};
  const query: QueryFn = (args) => {
    if (typeof args.options.systemPrompt === "string") seen.systemPrompt = args.options.systemPrompt;
    if ("thinking" in args.options) seen.thinking = args.options.thinking;
    return {
      ...idleControl,
      async *[Symbol.asyncIterator]() {
        for await (const message of args.prompt) {
          seen.content = message.message.content;
          break;
        }
        yield resultMessage("success", "ok");
      },
    };
  };
  await runInvoke(snapshot, invoke(over), { apiKey: "sk-test", listCredentials: () => [] }, createEmitter(sink), query);
  return seen;
}

describe("runInvoke — native emission", () => {
  it("emits one `native('claude-agent-sdk', msg)` per SDKMessage, then a single `done`", async () => {
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    const query: QueryFn = () =>
      streamOf(assistantMessage("hello"), assistantMessage(" world"), resultMessage("success", "hello world"));

    await runInvoke(
      {},
      invoke(),
      { apiKey: "sk-test", listCredentials: () => [] },
      emit,
      query,
    );

    // 3 messages cross the wire as native (incl. the result message), then one done.
    const natives = events.filter((e) => e.type === "native");
    expect(natives).toHaveLength(3);
    expect(natives.every((e) => e.type === "native" && e.framework === "claude-agent-sdk")).toBe(
      true,
    );
    const dones = events.filter((e) => e.type === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ type: "done", result: "hello world" });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it.each([
    ["success", false, "end_turn"],
    ["success", true, "error"],
    ["error_max_turns", true, "max_turns"],
    ["error_during_execution", true, "error"],
  ] as const)("a %s result with is_error %s ends in one `done` with stopReason %s, never an `error` event (guuey#3114)", async (subtype, isError, stopReason) => {
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    const query: QueryFn = () => streamOf(resultMessage(subtype, "API Error: Connection error.", isError));
    await runInvoke({}, invoke(), { apiKey: "sk-test", listCredentials: () => [] }, emit, query);
    const dones = events.filter((e) => e.type === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ type: "done", stopReason, result: "API Error: Connection error." });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("emits `error` and no `done` when the query throws", async () => {
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    const query: QueryFn = () => throwingStream("boom");

    await runInvoke(
      {},
      invoke(),
      { apiKey: "sk-test", listCredentials: () => [] },
      emit,
      query,
    );

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error", message: expect.stringContaining("boom") });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("framework gate: a non-claude framework with no run path emits a clear error and never queries", async () => {
    // `index.ts` routes openai to `runInvokeOpenai`; a framework with NO run path
    // yet (e.g. `google-adk`) reaching the Claude run path errors loudly.
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    let queried = false;
    const query: QueryFn = () => {
      queried = true;
      return streamOf();
    };

    await runInvoke(
      { framework: "google-adk" },
      invoke(),
      { apiKey: "sk-test", listCredentials: () => [] },
      emit,
      query,
    );

    expect(queried).toBe(false);
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("google-adk"),
    });
  });

  it("missing ANTHROPIC_API_KEY → a clear error, no query", async () => {
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    let queried = false;
    const query: QueryFn = () => {
      queried = true;
      return streamOf();
    };

    await runInvoke({}, invoke(), { listCredentials: () => [] }, emit, query);

    expect(queried).toBe(false);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    // events[0] is `hello` (always first); the error follows it.
    expect(events.filter((e) => e.type === "error")[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("ANTHROPIC_API_KEY"),
    });
  });

  it("A1: the user message leads with the turn context (priorMemory/priorState), then the invoke's own content unchanged", async () => {
    const turn = invoke({
      input: "do it",
      priorMemory: [{ key: "name", value: "Ada" }],
      priorState: { step: 1 },
    });
    const seen = await turnFor(turn, { systemPrompt: "SYS" });
    expect(Array.isArray(seen.content)).toBe(true);
    const content = Array.isArray(seen.content) ? seen.content : [];
    expect(content).toHaveLength(2);
    const [context, ...rest] = content;
    expect(context?.type).toBe("text");
    const contextText = context?.type === "text" ? context.text : "";
    expect(contextText.startsWith("<turn_context>\n")).toBe(true);
    expect(contextText).toContain("<thread_memory>");
    expect(contextText).toContain("<working_state>");
    expect(contextText).toContain("Ada");
    expect(rest).toEqual(anthropicUserContent(turn));
    expect(rest).toEqual([{ type: "text", text: "do it" }]);
    // The system prompt carries none of it.
    expect(seen.systemPrompt).not.toContain("<thread_memory>");
    expect(seen.systemPrompt).not.toContain("Ada");
  });

  it("A1: an empty turn context is still its own first block; a directive is its own second block; images follow", async () => {
    const png = {
      kind: "inline" as const,
      mimeType: "image/png" as const,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    };
    const shown = { heading: "Welcome", message: "Hi", options: ["One"] };
    const turn = invoke({ input: "look", firstImpressionShown: shown, attachments: [png], fs: { app: "/fs/app", home: "/fs/home", session: SESSION } });
    const seen = await turnFor(turn);
    const content = Array.isArray(seen.content) ? seen.content : [];
    expect(content.slice(0, 2)).toEqual([
      { type: "text", text: "<turn_context></turn_context>" },
      { type: "text", text: expect.stringMatching(/^<turn_directive>\n## Welcome card \(already on screen\)/) },
    ]);
    expect(content.slice(2)).toEqual(anthropicUserContent(turn));
    expect(content.slice(2)[0]).toMatchObject({ type: "image" });
  });

  describe("withheldTools — the Router's per-turn withholds reach the SDK catalog on the Claude path", () => {
    const gguiCred = { name: "ggui", cred: { url: "https://mcp.example/apps/x", transport: "http" as const, headers: {} } };

    async function gatesFor(over: Partial<HostInvoke>): Promise<{ allowedTools?: unknown; disallowedTools?: unknown }> {
      const { sink } = collector();
      const emit = createEmitter(sink);
      let seen: { allowedTools?: unknown; disallowedTools?: unknown } = {};
      const query: QueryFn = (args) => {
        seen = {
          allowedTools: args.options.allowedTools,
          ...("disallowedTools" in args.options ? { disallowedTools: args.options.disallowedTools } : {}),
        };
        return streamOf();
      };
      await runInvoke({}, invoke(over), { apiKey: "sk-test", listCredentials: () => [gguiCred] }, emit, query);
      return seen;
    }

    it("a withheld ggui tool is removed from the catalog (disallowedTools), the rest of the server stays allowed", async () => {
      const seen = await gatesFor({ gguiAttached: true, withheldTools: [{ server: "ggui", tool: "ggui_consume" }] });
      expect(seen.disallowedTools).toEqual(["mcp__ggui__ggui_consume"]);
      expect(seen.allowedTools).toContain("mcp__ggui");
    });

    it("no withheld tools → no disallowedTools at all (today's catalog)", async () => {
      const seen = await gatesFor({ gguiAttached: true });
      expect(seen).not.toHaveProperty("disallowedTools");
    });

    it("a withhold naming a server that is not attached this turn adds nothing", async () => {
      const seen = await gatesFor({ withheldTools: [{ server: "elsewhere", tool: "ggui_consume" }] });
      expect(seen).not.toHaveProperty("disallowedTools");
    });
  });

  it("guuey#2386: invoke.clientCatalogs reaches buildOptions on the Claude path, so the A2UI section renders", async () => {
    const { sink } = collector();
    let systemPrompt: string | undefined;
    const query: QueryFn = (args) => {
      systemPrompt = typeof args.options.systemPrompt === "string" ? args.options.systemPrompt : undefined;
      return streamOf();
    };
    await runInvoke({}, invoke({ clientCatalogs: [A2UI_GUUEY_CATALOG_ID] }), { apiKey: "sk-test", listCredentials: () => [] }, createEmitter(sink), query);
    expect(systemPrompt).toContain(A2UI_SECTION);
  });

  describe("guuey#1183 — the first-impression push reaches buildOptions on the Claude path", () => {
    const push = { chipKey: "opening-hours", intent: "show opening hours", contract: { kind: "hours" } };

    /** The turn's options knob and its directive text (A1: the handshake rides the turn's <turn_directive> block). */
    async function optionsFor(
      over: Partial<HostInvoke>,
      snapshot: { model?: string } = {},
    ): Promise<{ systemPrompt?: string; thinking?: unknown; turn: string }> {
      const { content, ...seen } = await turnFor(over, snapshot);
      return { ...seen, turn: textsOf(content).join("\n\n") };
    }

    // On a model that takes `disabled` (Sonnet 5, explicit since #2270 made the default Sonnet 5.5).
    it("rail armed + push → the verbatim handshake section renders AND extended thinking is off (the served red: neither ran)", async () => {
      const seen = await optionsFor({ gguiAttached: true, firstImpression: push }, { model: "claude-sonnet-5" });
      expect(seen.turn).toContain("<turn_directive>\n## First impression (this turn)");
      expect(seen.turn).toContain("<first_impression_handshake>");
      expect(seen.turn).toContain('"intent":"show opening hours"');
      expect(seen.systemPrompt).not.toContain("<first_impression_handshake>");
      expect(seen.thinking).toEqual({ type: "disabled" });
    });

    it("no push → no section, and the SDK default thinking stands (no `thinking` key)", async () => {
      const seen = await optionsFor({ gguiAttached: true });
      expect(seen.turn).not.toContain("<first_impression_handshake>");
      expect(seen).not.toHaveProperty("thinking");
    });

    it("push without the ggui rail → neither the section nor the knob (the same gate)", async () => {
      const seen = await optionsFor({ firstImpression: push });
      expect(seen.turn).not.toContain("<first_impression_handshake>");
      expect(seen).not.toHaveProperty("thinking");
    });

    // guuey#1606 — the provider 400s `thinking: disabled` on these (QA's in-pod
    // receipts on #1606; Sonnet 5.5 from the vendor docs, guuey#2231); sending
    // it would fail EVERY request of the bound turn.
    it.each(["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-sonnet-5-5", "anthropic/claude-fable-5-1"])(
      "%s (refuses `disabled`) → the handshake section still renders, thinking is left at the SDK default",
      async (model) => {
        const seen = await optionsFor({ gguiAttached: true, firstImpression: push }, { model });
        expect(seen.turn).toContain("<first_impression_handshake>");
        expect(seen).not.toHaveProperty("thinking");
      },
    );

    it.each(["claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"])(
      "%s (answered 200 with `disabled`) → the #1183 recipe is unchanged: thinking disabled for the bound turn",
      async (model) => {
        const seen = await optionsFor({ gguiAttached: true, firstImpression: push }, { model });
        expect(seen.thinking).toEqual({ type: "disabled" });
      },
    );
  });

  it("threads invoke.userMemory + memoryAttached into the buildOptions ctx → the recall block renders in the turn context", async () => {
    const seen = await turnFor({
      identity: { userId: "u1", authMode: "authenticated" },
      fs: { app: "/fs/app", home: "/fs/home", session: "/fs/session" },
      memoryAttached: true,
      userMemory: "User's favorite color is teal.",
    });
    const [context] = textsOf(seen.content);
    expect(context).toContain("## What you remember about this user");
    expect(context).toContain("User's favorite color is teal.");
    expect(seen.systemPrompt).not.toContain("User's favorite color is teal.");
    expect(seen.systemPrompt).toContain("`save_memory` tool");
  });

  it("A1: the turn blocks reach ONLY the query's user message — no emitted text or native payload carries them", async () => {
    const { events, sink } = collector();
    let content: SDKUserMessage["message"]["content"] | undefined;
    const query: QueryFn = (args) => ({
      ...idleControl,
      async *[Symbol.asyncIterator]() {
        for await (const message of args.prompt) {
          content = message.message.content;
          break;
        }
        yield assistantMessage("Here are the hours.");
        yield resultMessage("success", "Here are the hours.");
      },
    });
    await runInvoke(
      {},
      invoke({
        input: "when are you open?",
        identity: { userId: "u1", authMode: "authenticated" },
        history: [
          { role: "user", text: "hello" },
          { role: "agent", text: "hi, how can I help?" },
        ],
        memoryAttached: true,
        userMemory: "Likes tea.",
        gguiAttached: true,
        firstImpression: { chipKey: "opening-hours", intent: "show opening hours", contract: { kind: "hours" } },
      }),
      { apiKey: "sk-test", listCredentials: () => [] },
      createEmitter(sink),
      query,
    );

    // The query's user message carries both blocks, ahead of the user's own text.
    const texts = textsOf(content);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toMatch(/^<turn_context>\n/);
    expect(texts[0]).toContain("<conversation_history>");
    expect(texts[0]).toContain("Likes tea.");
    expect(texts[1]).toMatch(/^<turn_directive>\n## First impression \(this turn\)/);
    expect(texts[2]).toBe("when are you open?");

    // What the worker emits is the SDK's own stream, never the platform's turn blocks.
    const payloads = events.flatMap((e) =>
      e.type === "text" ? [e.text] : e.type === "native" ? [JSON.stringify(e.event)] : [],
    );
    expect(events.some((e) => e.type === "native")).toBe(true);
    for (const payload of payloads) {
      expect(payload).not.toContain("<turn_context");
      expect(payload).not.toContain("<turn_directive");
    }
  });

  it("BOOTSTRAP: authenticated + memoryAttached + no userMemory → save instruction still renders (no recall block)", async () => {
    const { sink } = collector();
    const emit = createEmitter(sink);
    let seenSystemPrompt: string | undefined;
    const query: QueryFn = (args) => {
      seenSystemPrompt = typeof args.options.systemPrompt === "string" ? args.options.systemPrompt : undefined;
      return streamOf();
    };

    await runInvoke(
      {},
      invoke({
        identity: { userId: "u1", authMode: "authenticated" },
        fs: { app: "/fs/app", home: "/fs/home", session: "/fs/session" },
        memoryAttached: true,
      }),
      { apiKey: "sk-test", listCredentials: () => [] },
      emit,
      query,
    );

    expect(seenSystemPrompt).not.toContain("## What you remember about this user");
    // Save instruction still present (authenticated + attached, no file yet) —
    // memory-mcp T5 points it at the `save_memory` tool; old file phrasing gone.
    expect(seenSystemPrompt).toContain("`save_memory` tool");
    expect(seenSystemPrompt).not.toContain("$GUUEY_HOME_DIR/memories/MEMORY.md");
  });

  it("broker path: baseUrl+authToken in runtime → options.env has ANTHROPIC_BASE_URL and no credential (guuey#2139)", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const { sink } = collector();
    const emit = createEmitter(sink);
    const query: QueryFn = (args) => {
      capturedEnv = args.options.env as Record<string, string>;
      return streamOf();
    };

    await runInvoke(
      {},
      invoke(),
      { baseUrl: "http://127.0.0.1:9911", authToken: "opaque-token", listCredentials: () => [] },
      emit,
      query,
    );

    expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9911");
    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(capturedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("local-dev path: apiKey in runtime → options.env has no credential and no base URL (guuey#2139)", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const { sink } = collector();
    const emit = createEmitter(sink);
    const query: QueryFn = (args) => {
      capturedEnv = args.options.env as Record<string, string>;
      return streamOf();
    };

    await runInvoke(
      {},
      invoke(),
      { apiKey: "sk-ant-local", listCredentials: () => [] },
      emit,
      query,
    );

    expect(capturedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(capturedEnv?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

describe("runInvoke — hello handshake (§8 item B)", () => {
  it("emits hello FIRST, before any native/done event, with a non-null real sdkVersion", async () => {
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    const query: QueryFn = () => streamOf(resultMessage("success", "ok"));

    await runInvoke({}, invoke(), { apiKey: "sk-test", listCredentials: () => [] }, emit, query);

    expect(events[0]).toMatchObject({
      type: "hello",
      framework: "claude-agent-sdk",
      sdkName: "@anthropic-ai/claude-agent-sdk",
    });
    // Real environment: @anthropic-ai/claude-agent-sdk is an installed dependency.
    expect((events[0] as { sdkVersion: string | null }).sdkVersion).not.toBeNull();
    // hello precedes every native/done event.
    const helloIdx = events.findIndex((e) => e.type === "hello");
    const firstOtherIdx = events.findIndex((e) => e.type !== "hello");
    expect(helloIdx).toBe(0);
    expect(firstOtherIdx).toBeGreaterThan(helloIdx);
  });

  it("still emits hello first even on the framework gate (no run path for this framework)", async () => {
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    const query: QueryFn = () => streamOf();

    await runInvoke(
      { framework: "google-adk" },
      invoke(),
      { apiKey: "sk-test", listCredentials: () => [] },
      emit,
      query,
    );

    expect(events[0]?.type).toBe("hello");
    expect(events[1]).toMatchObject({ type: "error" });
  });
});

describe("the welcome card the Router already drew reaches the Claude turn's directive block", () => {
  const shown = { heading: "Welcome to Harbor Books", message: "Glad you're here.", options: ["Find a book", "Opening hours"] };

  it("renders the section through runInvoke, with or without the ggui rail (the card is on screen either way)", async () => {
    for (const gguiAttached of [true, false]) {
      const seen = await turnFor({ firstImpressionShown: shown, gguiAttached });
      const directive = textsOf(seen.content)[1];
      expect(directive).toContain(FIRST_IMPRESSION_SHOWN_HEADING);
      expect(directive).toContain('"heading":"Welcome to Harbor Books"');
      expect(seen.systemPrompt).not.toContain(FIRST_IMPRESSION_SHOWN_HEADING);
    }
  });

  it("no card drawn: no section, no directive block", async () => {
    const seen = await turnFor({ gguiAttached: true });
    expect(textsOf(seen.content)).toEqual(["<turn_context></turn_context>", "hi"]);
  });
});

describe("the MCP-ready gate and the startup deadline (guuey#2139)", () => {
  const server = { fake: { type: "http" as const, url: "http://127.0.0.1:9/mcp" } };

  it("a server still pending at the MCP-ready deadline is named and the gate opens", async () => {
    const q: QueryHandle = {
      setMcpServers: () => Promise.resolve({ added: ["fake"], removed: [], errors: {} }),
      mcpServerStatus: () => Promise.resolve([{ name: "fake", status: "pending" as const }]),
      close: () => undefined,
      [Symbol.asyncIterator]: () => streamOf()[Symbol.asyncIterator](),
    };
    const started = Date.now();
    const problems = await awaitMcpReady(q, server, { mcpReadyDeadlineMs: 300 });
    expect(problems).toEqual(['MCP server "fake" not connected: still pending after 300 ms']);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a CLI that never answers setMcpServers fails the turn closed: one error, the query closed, no user message sent", async () => {
    let closed = 0;
    let pulled = false;
    const query: QueryFn = (params) => ({
      setMcpServers: () => new Promise(() => undefined),
      mcpServerStatus: () => Promise.resolve([]),
      close: () => {
        closed += 1;
      },
      async *[Symbol.asyncIterator]() {
        for await (const _message of params.prompt) {
          pulled = true;
          yield resultMessage("success", "unexpected");
        }
      },
    });
    const events: WorkerEvent[] = [];
    const emit = createEmitter({ write: (s: string) => { for (const line of s.split("\n")) if (line.trim()) events.push(JSON.parse(line) as WorkerEvent); } });
    await runInvoke({}, invoke(), { apiKey: "sk-test", listCredentials: () => [] }, emit, query, { startupDeadlineMs: 200 });
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: expect.stringContaining("Claude CLI startup failed: no answer to setMcpServers within 200 ms") });
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(closed).toBe(1);
    expect(pulled).toBe(false);
  });
});

describe("runInvoke — a runtime-owned name in agent.env is reported on stderr when it is left out", () => {
  async function stderrFor(env: Record<string, string>): Promise<{ lines: string[]; queried: boolean }> {
    const { sink } = collector();
    const emit = createEmitter(sink);
    let queried = false;
    const query: QueryFn = () => {
      queried = true;
      return streamOf(resultMessage("success", "ok"));
    };
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await runInvoke({ env }, invoke(), { apiKey: "sk-test", listCredentials: () => [] }, emit, query);
    } finally {
      spy.mockRestore();
    }
    return { lines, queried };
  }

  it("one line naming each dropped name, never a value, and the turn still runs", async () => {
    const { lines, queried } = await stderrFor({ KEEP: "1", LD_AUDIT: "/audit.so", GLIBC_TUNABLES: "glibc.x=1" });
    expect(queried).toBe(true);
    const reported = lines.filter((l) => l.includes("agent.env"));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("LD_AUDIT, GLIBC_TUNABLES");
    expect(reported[0]).not.toContain("/audit.so");
    expect(reported[0]).not.toContain("glibc.x=1");
  });

  it("no line when agent.env carries no reserved name", async () => {
    const { lines } = await stderrFor({ KEEP: "1", LD_SDK_KEY: "k" });
    expect(lines.filter((l) => l.includes("agent.env"))).toEqual([]);
  });
});

/** The `[guuey]` lines a run writes to stderr, captured without printing them. */
async function stderrLinesOf(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines.filter((line) => line.startsWith("[guuey] tools."));
}

describe("an unreadable denylist entry is named on stderr (guuey#2585)", () => {
  it('{denylist:["mcp__x__y"]} writes one [guuey] line naming the entry', async () => {
    const { sink } = collector();
    const emit = createEmitter(sink);
    const lines = await stderrLinesOf(() =>
      runInvoke({ tools: { denylist: ["mcp__x__y"] } }, invoke(), { apiKey: "sk-test", listCredentials: () => [] }, emit, () => streamOf()),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[guuey\] tools\.denylist entry "mcp__x__y" cannot be read/);
  });
});
