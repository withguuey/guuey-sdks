import { describe, expect, it } from "vitest";
import { createEmitter, type WorkerEvent } from "@guuey/worker";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { runInvoke, type HostInvoke, type QueryFn } from "./run.js";

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
      { apiKey: "sk-test", readCredential: () => undefined },
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
      { apiKey: "sk-test", readCredential: () => undefined },
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
      { apiKey: "sk-test", readCredential: () => undefined },
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

    await runInvoke({}, invoke(), { readCredential: () => undefined }, emit, query);

    expect(queried).toBe(false);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events[0]).toMatchObject({
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
      { apiKey: "sk-test", readCredential: () => undefined },
      emit,
      query,
    );

    expect(seen.prompt).toBe("do it");
    expect(seen.systemPrompt).toContain("<thread_memory>");
    expect(seen.systemPrompt).toContain("<working_state>");
    expect(seen.systemPrompt).toContain("Ada");
  });
});
