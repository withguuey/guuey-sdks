import { describe, expect, it } from "vitest";
import { createEmitter, type WorkerEvent } from "@guuey/worker";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { runInvoke, type HostInvoke, type QueryFn } from "./claude.js";

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
function resultMessage(subtype: string, result: string): SDKMessage {
  const msg: { type: "result"; subtype: string; result: string; stop_reason: string } = {
    type: "result",
    subtype,
    result,
    stop_reason: "end_turn",
  };
  return msg as unknown as SDKMessage;
}

/** An async iterable over a fixed list of messages (no yield-less generator). */
function streamOf(...messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
  };
}

/** An async iterable that throws on first iteration. */
function throwingStream(message: string): AsyncIterable<SDKMessage> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKMessage>> {
          return Promise.reject(new Error(message));
        },
      };
    },
  };
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

  it("passes input as the prompt and reads priorMemory/priorState into the preamble", async () => {
    const seen: { prompt?: string; systemPrompt?: string } = {};
    const { sink } = collector();
    const emit = createEmitter(sink);
    const query: QueryFn = (args) => {
      seen.prompt = args.prompt;
      const sp = args.options.systemPrompt;
      seen.systemPrompt = typeof sp === "string" ? sp : undefined;
      return streamOf();
    };

    await runInvoke(
      { systemPrompt: "SYS" },
      invoke({
        input: "do it",
        priorMemory: [{ key: "name", value: "Ada" }],
        priorState: { step: 1 },
      }),
      { apiKey: "sk-test", listCredentials: () => [] },
      emit,
      query,
    );

    expect(seen.prompt).toBe("do it");
    expect(seen.systemPrompt).toContain("<thread_memory>");
    expect(seen.systemPrompt).toContain("<working_state>");
    expect(seen.systemPrompt).toContain("Ada");
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

  describe("guuey#1183 — the first-impression push reaches buildOptions on the Claude path", () => {
    const push = { chipKey: "opening-hours", intent: "show opening hours", contract: { kind: "hours" } };

    async function optionsFor(
      over: Partial<HostInvoke>,
      snapshot: { model?: string } = {},
    ): Promise<{ systemPrompt?: string; thinking?: unknown }> {
      const { sink } = collector();
      const emit = createEmitter(sink);
      let seen: { systemPrompt?: string; thinking?: unknown } = {};
      const query: QueryFn = (args) => {
        seen = {
          ...(typeof args.options.systemPrompt === "string" ? { systemPrompt: args.options.systemPrompt } : {}),
          ...("thinking" in args.options ? { thinking: args.options.thinking } : {}),
        };
        return streamOf();
      };
      await runInvoke(snapshot, invoke(over), { apiKey: "sk-test", listCredentials: () => [] }, emit, query);
      return seen;
    }

    it("rail armed + push → the verbatim handshake section renders AND extended thinking is off (the served red: neither ran)", async () => {
      const seen = await optionsFor({ gguiAttached: true, firstImpression: push });
      expect(seen.systemPrompt).toContain("<first_impression_handshake>");
      expect(seen.systemPrompt).toContain('"intent":"show opening hours"');
      expect(seen.thinking).toEqual({ type: "disabled" });
    });

    it("no push → no section, and the SDK default thinking stands (no `thinking` key)", async () => {
      const seen = await optionsFor({ gguiAttached: true });
      expect(seen.systemPrompt).not.toContain("<first_impression_handshake>");
      expect(seen).not.toHaveProperty("thinking");
    });

    it("push without the ggui rail → neither the section nor the knob (the same gate)", async () => {
      const seen = await optionsFor({ firstImpression: push });
      expect(seen.systemPrompt).not.toContain("<first_impression_handshake>");
      expect(seen).not.toHaveProperty("thinking");
    });

    // guuey#1606 — the provider 400s `thinking: disabled` on these (QA's in-pod
    // receipts on #1606); sending it would fail EVERY request of the bound turn.
    it.each(["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "anthropic/claude-fable-5-1"])(
      "%s (refuses `disabled`) → the handshake section still renders, thinking is left at the SDK default",
      async (model) => {
        const seen = await optionsFor({ gguiAttached: true, firstImpression: push }, { model });
        expect(seen.systemPrompt).toContain("<first_impression_handshake>");
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

  it("threads invoke.userMemory + memoryAttached into the buildOptions ctx → the recall block renders", async () => {
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
        userMemory: "User's favorite color is teal.",
      }),
      { apiKey: "sk-test", listCredentials: () => [] },
      emit,
      query,
    );

    expect(seenSystemPrompt).toContain("## What you remember about this user");
    expect(seenSystemPrompt).toContain("User's favorite color is teal.");
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

  it("broker path: baseUrl+authToken in runtime → options.env has ANTHROPIC_BASE_URL+ANTHROPIC_AUTH_TOKEN, no ANTHROPIC_API_KEY", async () => {
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
    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe("opaque-token");
    expect(capturedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("local-dev path: apiKey in runtime → options.env has ANTHROPIC_API_KEY, no base-URL/token", async () => {
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

    expect(capturedEnv?.ANTHROPIC_API_KEY).toBe("sk-ant-local");
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
