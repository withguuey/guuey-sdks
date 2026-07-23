import { describe, expect, it } from "vitest";
import { createEmitter, type WorkerEvent } from "@guuey/worker";
import {
  MaxTurnsExceededError,
  RunRawModelStreamEvent,
  type ResponseStreamEvent,
  type RunStreamEvent,
} from "@openai/agents";
import {
  runInvokeOpenai,
  type OpenaiRunFn,
  type OpenaiRunResult,
} from "./openai.js";
import type { HostInvoke } from "./claude.js";
import { renderMemorySection } from "../preamble.js";
import type { GuueyAgent } from "@guuey/config";

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
 * A raw `RunStreamEvent` fixture: a genuine `RunRawModelStreamEvent` instance
 * wrapping the model `data` payload. `runInvokeOpenai` treats each event as
 * opaque JSON (it only `toJson`s it onto the wire), so the payload content is
 * behaviour-irrelevant — only the static type must be a real `RunStreamEvent`.
 * Test-only; never in shipping code.
 */
function rawEvent(data: ResponseStreamEvent): RunStreamEvent {
  return new RunRawModelStreamEvent(data);
}

/**
 * A fake `OpenaiRunResult`: async-iterates the canned events, then resolves (or
 * rejects, for max-turns) `completed`. Mirrors `StreamedRunResult`'s
 * read-projection the loop consumes — no live model, no real `run`.
 */
function fakeResult(opts: {
  events: RunStreamEvent[];
  finalOutput?: string;
  completedError?: Error;
}): OpenaiRunResult {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of opts.events) yield ev;
    },
    get completed(): Promise<void> {
      return opts.completedError ? Promise.reject(opts.completedError) : Promise.resolve();
    },
    finalOutput: opts.finalOutput,
  };
}

const runtime = { apiKey: "sk-openai-test", listCredentials: () => [] };

/** Snapshot with NO mcpServers so the path never constructs a live MCP server. */
const snapshot: GuueyAgent = {
  framework: "openai-agents-sdk",
  model: "gpt-4o-mini",
  mcpServers: {},
};

describe("runInvokeOpenai — native emission", () => {
  it("emits one `native('openai-agents-sdk', ev)` per stream event, then a single `done`", async () => {
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    const streamEvents = [
      rawEvent({ type: "model", event: { type: "response.created", response: { id: "r1" } } }),
      rawEvent({ type: "model", event: { type: "response.output_text.delta", delta: "hi" } }),
    ];
    const run: OpenaiRunFn = () =>
      Promise.resolve(fakeResult({ events: streamEvents, finalOutput: "hi there" }));

    await runInvokeOpenai(snapshot, invoke(), runtime, emit, run);

    const natives = events.filter((e) => e.type === "native");
    expect(natives).toHaveLength(2);
    expect(natives.every((e) => e.type === "native" && e.framework === "openai-agents-sdk")).toBe(
      true,
    );
    const dones = events.filter((e) => e.type === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ type: "done", result: "hi there", stopReason: "end_turn" });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("emits the `__host_error__` max_turns sentinel + a `done('max_turns')` when `completed` throws MaxTurnsExceededError", async () => {
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    const streamEvents = [
      rawEvent({ type: "model", event: { type: "response.created", response: { id: "r1" } } }),
    ];
    const run: OpenaiRunFn = () =>
      Promise.resolve(
        fakeResult({
          events: streamEvents,
          completedError: new MaxTurnsExceededError("Max turns (1) exceeded"),
        }),
      );

    await runInvokeOpenai(
      { ...snapshot, runtime: { maxTurns: 1 } },
      invoke(),
      runtime,
      emit,
      run,
    );

    // The raw stream event crossed first, THEN the synthetic sentinel.
    const natives = events.filter((e) => e.type === "native");
    expect(natives).toHaveLength(2);
    const sentinel = natives[1];
    expect(sentinel).toMatchObject({
      type: "native",
      framework: "openai-agents-sdk",
      event: { type: "__host_error__", code: "max_turns", message: expect.stringContaining("Max turns") },
    });
    const dones = events.filter((e) => e.type === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ type: "done", stopReason: "max_turns" });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("emits `error` and no `done` when `completed` throws a non-max-turns error", async () => {
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    const run: OpenaiRunFn = () =>
      Promise.resolve(fakeResult({ events: [], completedError: new Error("boom") }));

    await runInvokeOpenai(snapshot, invoke(), runtime, emit, run);

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error", message: expect.stringContaining("boom") });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("emits `error` and no `done` when `run` itself throws", async () => {
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    const run: OpenaiRunFn = () => Promise.reject(new Error("run-failed"));

    await runInvokeOpenai(snapshot, invoke(), runtime, emit, run);

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error", message: expect.stringContaining("run-failed") });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("builds the Agent from the snapshot: model + preamble instructions, input as the run prompt", async () => {
    const { sink } = collector();
    const emit = createEmitter(sink);
    const seen: { model?: string; instructions?: string; input?: string; maxTurns?: number } = {};
    const run: OpenaiRunFn = (agent, input, options) => {
      seen.model = typeof agent.model === "string" ? agent.model : undefined;
      seen.instructions = typeof agent.instructions === "string" ? agent.instructions : undefined;
      seen.input = input;
      seen.maxTurns = options.maxTurns;
      return Promise.resolve(fakeResult({ events: [], finalOutput: "ok" }));
    };

    await runInvokeOpenai(
      {
        framework: "openai-agents-sdk",
        model: "gpt-4o-mini",
        systemPrompt: "SYS",
        mcpServers: {},
        runtime: { maxTurns: 7 },
      },
      invoke({
        input: "do it",
        priorMemory: [{ key: "name", value: "Ada" }],
        priorState: { step: 1 },
      }),
      runtime,
      emit,
      run,
    );

    expect(seen.model).toBe("gpt-4o-mini");
    expect(seen.input).toBe("do it");
    expect(seen.maxTurns).toBe(7);
    expect(seen.instructions).toContain("SYS");
    expect(seen.instructions).toContain("<thread_memory>");
    expect(seen.instructions).toContain("Ada");
    expect(seen.instructions).toContain("<working_state>");
    // No userMemory pushed → NO memory section (framework-blind gate: present
    // iff `invoke.userMemory` is present).
    expect(seen.instructions).not.toContain("`save_memory` tool");
    expect(seen.instructions).not.toContain("## What you remember about this user");
  });

  it("renders the framework-blind memory section (save + recall) into instructions when userMemory is present (memory-mcp T5)", async () => {
    const { sink } = collector();
    const emit = createEmitter(sink);
    let instructions: string | undefined;
    const run: OpenaiRunFn = (agent) => {
      instructions = typeof agent.instructions === "string" ? agent.instructions : undefined;
      return Promise.resolve(fakeResult({ events: [], finalOutput: "ok" }));
    };

    await runInvokeOpenai(
      { framework: "openai-agents-sdk", model: "gpt-4o-mini", systemPrompt: "SYS", mcpServers: {} },
      invoke({ userMemory: "User's name is Ada." }),
      runtime,
      emit,
      run,
    );

    // Identical block content to Claude/ADK: the save one-liner + the
    // byte-identical RECALL block appended AFTER the context preamble (mirror
    // where the Claude path puts it — trailing the system prompt).
    expect(instructions).toContain("SYS");
    expect(instructions).toContain("`save_memory` tool");
    expect(instructions?.endsWith(renderMemorySection("User's name is Ada."))).toBe(true);
    // The preamble output precedes the memory section.
    expect((instructions ?? "").indexOf("SYS")).toBeLessThan(
      (instructions ?? "").indexOf("`save_memory` tool"),
    );
  });
});

describe("runInvokeOpenai — hello handshake (§8 item B)", () => {
  it("emits hello FIRST, before any native/done event, with a non-null real sdkVersion", async () => {
    const { events, sink } = collector();
    const emit = createEmitter(sink);
    const run: OpenaiRunFn = () =>
      Promise.resolve(fakeResult({ events: [], finalOutput: "ok" }));

    await runInvokeOpenai(snapshot, invoke(), runtime, emit, run);

    expect(events[0]).toMatchObject({
      type: "hello",
      framework: "openai-agents-sdk",
      sdkName: "@openai/agents",
    });
    // Real environment: @openai/agents is an installed dependency.
    expect((events[0] as { sdkVersion: string | null }).sdkVersion).not.toBeNull();
    const helloIdx = events.findIndex((e) => e.type === "hello");
    const firstOtherIdx = events.findIndex((e) => e.type !== "hello");
    expect(helloIdx).toBe(0);
    expect(firstOtherIdx).toBeGreaterThan(helloIdx);
  });
});
