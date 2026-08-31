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
import {
  RESPONSE_NORMS_SECTION, renderMemorySection, renderProfileSection, renderResourcesSection } from "../preamble.js";
import { defaultModelFor, type GuueyAgent } from "@guuey/config";

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
    // Default invoke is anonymous + not attached → NO memory section (the SAVE
    // gate is `authenticated && memoryAttached`).
    expect(seen.instructions).not.toContain("`save_memory` tool");
    expect(seen.instructions).not.toContain("## What you remember about this user");
  });

  it("defaults the model to defaultModelFor('openai-agents-sdk') when the snapshot omits model (M7: was silently falling to the SDK's own default)", async () => {
    const { sink } = collector();
    const emit = createEmitter(sink);
    const seen: { model?: string } = {};
    const run: OpenaiRunFn = (agent) => {
      seen.model = typeof agent.model === "string" ? agent.model : undefined;
      return Promise.resolve(fakeResult({ events: [], finalOutput: "ok" }));
    };

    await runInvokeOpenai(
      { framework: "openai-agents-sdk", mcpServers: {} },
      invoke(),
      runtime,
      emit,
      run,
    );

    // Derived, not pinned to a bare literal — proves runInvokeOpenai falls back
    // to the SAME registry default openai.ts's DEFAULT_MODEL derives
    // (defaultModelFor("openai-agents-sdk")), so this assertion tracks a
    // future registry default change instead of silently going stale. Mirrors
    // agent-entry.test.ts's "defaults the model when the snapshot has none"
    // pin for the google-adk lane.
    expect(seen.model).toBe(defaultModelFor("openai-agents-sdk"));
    // Non-vacuous: the derived default must actually differ from the explicit
    // literal the sibling test above pins, or this assertion would pass
    // whether or not the `??` fallback is wired up.
    expect(seen.model).not.toBe("gpt-4o-mini");
  });
});

describe("runInvokeOpenai — memory section (memory-mcp T5, gated on authenticated && memoryAttached)", () => {
  /** Capture the built Agent's assembled `instructions`. */
  function captureInstructions(over: Partial<HostInvoke>): Promise<string | undefined> {
    const { sink } = collector();
    const emit = createEmitter(sink);
    let instructions: string | undefined;
    const run: OpenaiRunFn = (agent) => {
      instructions = typeof agent.instructions === "string" ? agent.instructions : undefined;
      return Promise.resolve(fakeResult({ events: [], finalOutput: "ok" }));
    };
    return runInvokeOpenai(
      { framework: "openai-agents-sdk", model: "gpt-4o-mini", systemPrompt: "SYS", mcpServers: {} },
      invoke(over),
      runtime,
      emit,
      run,
    ).then(() => instructions);
  }
  const authed = { userId: "u1", authMode: "authenticated" as const };

  it("authenticated + attached + userMemory → save + byte-identical recall block, after the preamble", async () => {
    const instructions = await captureInstructions({
      identity: authed,
      memoryAttached: true,
      userMemory: "User's name is Ada.",
    });
    // Identical block content to Claude/ADK, appended AFTER the context preamble.
    expect(instructions).toContain("SYS");
    expect(instructions).toContain("`save_memory` tool");
    expect(instructions?.endsWith(renderMemorySection("User's name is Ada.") + RESPONSE_NORMS_SECTION)).toBe(true);
    expect((instructions ?? "").indexOf("SYS")).toBeLessThan(
      (instructions ?? "").indexOf("`save_memory` tool"),
    );
  });

  it("BOOTSTRAP: authenticated + attached + NO userMemory (brand-new user) → save-only section, NO recall block", async () => {
    const instructions = await captureInstructions({ identity: authed, memoryAttached: true });
    expect(instructions).toContain("`save_memory` tool");
    expect(instructions?.endsWith(renderMemorySection(undefined) + RESPONSE_NORMS_SECTION)).toBe(true);
    expect(instructions).not.toContain("## What you remember about this user");
  });

  it("authenticated + NOT attached → NO section even if userMemory somehow present (no tool → no instruction)", async () => {
    const instructions = await captureInstructions({
      identity: authed,
      memoryAttached: false,
      userMemory: "orphaned",
    });
    expect(instructions).not.toContain("`save_memory` tool");
    expect(instructions).not.toContain("orphaned");
  });

  it("anonymous + attached → NO section (guest never gets the memory tool)", async () => {
    const instructions = await captureInstructions({ memoryAttached: true, userMemory: "guest" });
    expect(instructions).not.toContain("`save_memory` tool");
    expect(instructions).not.toContain("guest");
  });
});

describe("runInvokeOpenai — cross-app profile section (profile T7, gated on authenticated && profileAccess)", () => {
  function captureInstructions(over: Partial<HostInvoke>): Promise<string | undefined> {
    const { sink } = collector();
    const emit = createEmitter(sink);
    let instructions: string | undefined;
    const run: OpenaiRunFn = (agent) => {
      instructions = typeof agent.instructions === "string" ? agent.instructions : undefined;
      return Promise.resolve(fakeResult({ events: [], finalOutput: "ok" }));
    };
    return runInvokeOpenai(
      { framework: "openai-agents-sdk", model: "gpt-4o-mini", systemPrompt: "SYS", mcpServers: {} },
      invoke(over),
      runtime,
      emit,
      run,
    ).then(() => instructions);
  }
  const authed = { userId: "u1", authMode: "authenticated" as const };
  const sections = [{ app: "Todoist", content: "Prefers short replies." }];

  it("authenticated + read-write + sections → save + recall, byte-identical to renderProfileSection, after the memory section", async () => {
    const instructions = await captureInstructions({
      identity: authed,
      memoryAttached: true,
      userMemory: "Ada",
      profileAccess: "read-write",
      profileSections: sections,
    });
    // The section content is byte-identical to Claude/ADK.
    expect(
      instructions?.endsWith(
        renderMemorySection("Ada") +
          renderProfileSection(sections, "read-write") +
          RESPONSE_NORMS_SECTION,
      ),
    ).toBe(true);
    expect(instructions).toContain("`save_profile` tool");
    expect(instructions).toContain("### From Todoist");
    // memory section precedes profile section.
    expect((instructions ?? "").indexOf("`save_memory` tool")).toBeLessThan(
      (instructions ?? "").indexOf("`save_profile` tool"),
    );
  });

  it("authenticated + read (read-only) + sections → recall only, NO save instruction", async () => {
    const instructions = await captureInstructions({
      identity: authed,
      profileAccess: "read",
      profileSections: sections,
    });
    expect(instructions).not.toContain("`save_profile` tool");
    expect(instructions).toContain("## What you know about this user from other apps");
    expect(instructions).toContain("### From Todoist");
  });

  it("authenticated + NO profileAccess → NO profile section", async () => {
    const instructions = await captureInstructions({ identity: authed, profileSections: sections });
    expect(instructions).not.toContain("`save_profile` tool");
    expect(instructions).not.toContain("Prefers short replies.");
  });

  it("anonymous + profileAccess present → NO profile section (guest never gets the profile)", async () => {
    const instructions = await captureInstructions({
      profileAccess: "read-write",
      profileSections: sections,
    });
    expect(instructions).not.toContain("`save_profile` tool");
    expect(instructions).not.toContain("Prefers short replies.");
  });
});

describe("runInvokeOpenai — app-resources section (guuey#456 B4, gated on fsBound && resourceCount > 0)", () => {
  function captureInstructions(over: Partial<HostInvoke>): Promise<string | undefined> {
    const { sink } = collector();
    const emit = createEmitter(sink);
    let instructions: string | undefined;
    const run: OpenaiRunFn = (agent) => {
      instructions = typeof agent.instructions === "string" ? agent.instructions : undefined;
      return Promise.resolve(fakeResult({ events: [], finalOutput: "ok" }));
    };
    return runInvokeOpenai(
      { framework: "openai-agents-sdk", model: "gpt-4o-mini", systemPrompt: "SYS", mcpServers: {} },
      invoke(over),
      runtime,
      emit,
      run,
    ).then(() => instructions);
  }
  const authed = { userId: "u1", authMode: "authenticated" as const };
  const sections = [{ app: "Todoist", content: "Prefers short replies." }];

  it("fsBound + resourceCount > 0 → byte-identical to renderResourcesSection, naming the invoke's fs.app", async () => {
    const instructions = await captureInstructions({ fsBound: true, resourceCount: 3 });
    // The invoke fixture's fs.app is "/fs/app" — the section names THAT path.
    expect(instructions?.endsWith(renderResourcesSection(3, "/fs/app") + RESPONSE_NORMS_SECTION)).toBe(true);
    expect(instructions).toContain("3 reference files at /fs/app/resources");
  });

  it("renders AFTER the profile section (memory → profile → resources), byte-identical to the framework-blind renderers", async () => {
    const instructions = await captureInstructions({
      identity: authed,
      fsBound: true,
      resourceCount: 2,
      memoryAttached: true,
      userMemory: "Ada",
      profileAccess: "read-write",
      profileSections: sections,
    });
    expect(
      instructions?.endsWith(
        renderMemorySection("Ada") +
          renderProfileSection(sections, "read-write") +
          renderResourcesSection(2, "/fs/app") +
          RESPONSE_NORMS_SECTION,
      ),
    ).toBe(true);
  });

  it("an ANONYMOUS caller still gets the section (app resources are shared, public-by-definition — NOT auth-gated)", async () => {
    const instructions = await captureInstructions({ fsBound: true, resourceCount: 1 });
    expect(instructions).toContain("## App resources");
    expect(instructions).toContain("1 reference file at /fs/app/resources");
  });

  it("fsBound false/absent + resourceCount present → NO section (no file tools to read them)", async () => {
    const boundOff = await captureInstructions({ fsBound: false, resourceCount: 3 });
    expect(boundOff).not.toContain("## App resources");
    const boundAbsent = await captureInstructions({ resourceCount: 3 });
    expect(boundAbsent).not.toContain("## App resources");
  });

  it("resourceCount 0/absent → NO section", async () => {
    const zero = await captureInstructions({ fsBound: true, resourceCount: 0 });
    expect(zero).not.toContain("## App resources");
    const absent = await captureInstructions({ fsBound: true });
    expect(absent).not.toContain("## App resources");
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
