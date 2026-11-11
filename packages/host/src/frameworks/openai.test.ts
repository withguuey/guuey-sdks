import { describe, expect, it, vi } from "vitest";
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
} from './openai.js';
import { mcpToolCustomData as mcpCustomData } from "@guuey/worker";
import type { HostInvoke } from "./claude.js";
import {
  RESPONSE_NORMS_SECTION, TURN_AUTHORITY_SECTION, MEMORY_SAVE_INSTRUCTION, PROFILE_SAVE_INSTRUCTION,
  SURFACE_FORMATTING_SECTION, renderResourcesSection, renderProfileRecall,
  FIRST_IMPRESSION_SHOWN_HEADING, GENERATIVE_UI_SECTION, A2UI_SECTION, A2UI_GUUEY_CATALOG_ID, renderUserMemoryRecall } from "../preamble.js";
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

/** The class-level sections of the "SYS" agent's instructions: `mid`, then surface, authority, norms (A1). */
function instructionsOf(...mid: string[]): string {
  return "SYS" + mid.join("") + SURFACE_FORMATTING_SECTION + TURN_AUTHORITY_SECTION + RESPONSE_NORMS_SECTION;
}
const MEMORY_SAVE = `\n\n${MEMORY_SAVE_INSTRUCTION}`;
const PROFILE_SAVE = `\n\n${PROFILE_SAVE_INSTRUCTION}`;

/** One "SYS" turn: the built Agent's `instructions` and the run input (A1: the turn context leads it), as text. */
async function captureTurn(
  over: Partial<HostInvoke>,
  agentSnapshot: GuueyAgent & { framework?: string } = { framework: "openai-agents-sdk", model: "gpt-4o-mini", systemPrompt: "SYS", mcpServers: {} },
): Promise<{ instructions: string; input: string }> {
  const { sink } = collector();
  const seen = { instructions: "", input: "" };
  const run: OpenaiRunFn = (agent, input) => {
    seen.instructions = typeof agent.instructions === "string" ? agent.instructions : "";
    seen.input = typeof input === "string" ? input : JSON.stringify(input);
    return Promise.resolve(fakeResult({ events: [], finalOutput: "ok" }));
  };
  await runInvokeOpenai(agentSnapshot, invoke(over), runtime, createEmitter(sink), run);
  return seen;
}

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

  it("builds the Agent from the snapshot: model + class-only instructions, the turn context then the input as the run prompt", async () => {
    const { sink } = collector();
    const emit = createEmitter(sink);
    const seen: { model?: string; instructions?: string; input?: Parameters<OpenaiRunFn>[1]; maxTurns?: number } = {};
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
    expect(seen.maxTurns).toBe(7);
    expect(seen.instructions).toBe(instructionsOf());
    // A1: the context leads the input, its own block, then the user's text.
    expect(typeof seen.input).toBe("string");
    const input = typeof seen.input === "string" ? seen.input : "";
    expect(input.startsWith("<turn_context>\n")).toBe(true);
    expect(input.endsWith("\n</turn_context>\n\ndo it")).toBe(true);
    expect(input).toContain("<thread_memory>");
    expect(input).toContain("Ada");
    expect(input).toContain("<working_state>");
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

  it("authenticated + attached + userMemory → save in the instructions, the byte-identical recall block leading the input", async () => {
    const { instructions, input } = await captureTurn({
      identity: authed,
      memoryAttached: true,
      userMemory: "User's name is Ada.",
    });
    // Identical block content to Claude/ADK.
    expect(instructions).toBe(instructionsOf(MEMORY_SAVE));
    expect(input).toBe(`<turn_context>\n${renderUserMemoryRecall("User's name is Ada.").slice(2)}\n</turn_context>\n\nhi`);
  });

  it("guuey#2386: a client that draws guuey A2UI gets the section DIRECTLY AFTER generative UI, byte-identical to Claude's", async () => {
    const instructions = await captureInstructions({ gguiAttached: true, clientCatalogs: [A2UI_GUUEY_CATALOG_ID] });
    expect(instructions?.endsWith(SURFACE_FORMATTING_SECTION + GENERATIVE_UI_SECTION + A2UI_SECTION + TURN_AUTHORITY_SECTION + RESPONSE_NORMS_SECTION)).toBe(true);
  });

  it("guuey#2386: no section without the guuey A2UI catalog", async () => {
    for (const over of [{ gguiAttached: true }, { gguiAttached: true, clientCatalogs: ["guuey.json-render.v1"] }]) {
      expect(await captureInstructions(over)).not.toContain(A2UI_SECTION);
    }
  });

  it('guuey#2262: tools.allowlist ["@none"] leaves out the SAVE instruction and the generative-UI section, keeps the recall', async () => {
    const { instructions, input } = await captureTurn(
      { identity: authed, memoryAttached: true, userMemory: "Ada.", gguiAttached: true, clientCatalogs: [A2UI_GUUEY_CATALOG_ID] },
      { framework: "openai-agents-sdk", model: "gpt-4o-mini", systemPrompt: "SYS", mcpServers: {}, tools: { allowlist: ["@none"] } },
    );
    expect(instructions).not.toContain("`save_memory` tool");
    expect(instructions).not.toContain(GENERATIVE_UI_SECTION);
    expect(instructions).not.toContain(A2UI_SECTION);
    expect(instructions).toBe(instructionsOf());
    expect(input).toContain(renderUserMemoryRecall("Ada.").slice(2));
  });

  it('guuey#2262: tools.allowlist ["@none"] leaves out the profile SAVE instruction and the first impression, keeps the profile recall', async () => {
    const capture = (allowlist: string[]) =>
      captureTurn(
        {
          identity: authed,
          gguiAttached: true,
          profileAccess: "read-write",
          profileSections: [{ app: "Todoist", content: "Prefers short replies." }],
          firstImpression: { chipKey: "c5c73c61f370", intent: "Opening hours", contract: { propsSpec: { properties: {} } } },
        },
        { framework: "openai-agents-sdk", model: "gpt-4o-mini", systemPrompt: "SYS", mcpServers: {}, tools: { allowlist } },
      );
    const none = await capture(["@none"]);
    expect(none.instructions).not.toContain("save_profile");
    expect(none.input).toContain("Prefers short replies.");
    expect(none.input).not.toContain("ggui_handshake");
    const control = await capture(["ggui.*"]);
    expect(control.instructions).toContain("save_profile");
    expect(control.input).toContain("<turn_directive>");
    expect(control.input).toContain("ggui_handshake");
    expect(control.instructions).not.toContain("ggui_handshake");
  });

  it("BOOTSTRAP: authenticated + attached + NO userMemory (brand-new user) → save-only section, NO recall block", async () => {
    const { instructions, input } = await captureTurn({ identity: authed, memoryAttached: true });
    expect(instructions).toBe(instructionsOf(MEMORY_SAVE));
    expect(input).toBe("<turn_context></turn_context>\n\nhi");
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

  it("authenticated + read-write + sections → save in the instructions + recall leading the input, after the memory ones", async () => {
    const { instructions, input } = await captureTurn({
      identity: authed,
      memoryAttached: true,
      userMemory: "Ada",
      profileAccess: "read-write",
      profileSections: sections,
    });
    // The section content is byte-identical to Claude/ADK: SAVE instructions in
    // the instructions (memory first), the recalls leading the input.
    expect(instructions).toBe(instructionsOf(MEMORY_SAVE, PROFILE_SAVE));
    expect(input).toBe(
      `<turn_context>\n${renderUserMemoryRecall("Ada").slice(2)}${renderProfileRecall(sections)}\n</turn_context>\n\nhi`,
    );
  });

  it("authenticated + read (read-only) + sections → recall only, NO save instruction", async () => {
    const { instructions, input } = await captureTurn({
      identity: authed,
      profileAccess: "read",
      profileSections: sections,
    });
    expect(instructions).not.toContain("`save_profile` tool");
    expect(input).toContain("## What you know about this user from other apps");
    expect(input).toContain("### From Todoist");
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
    expect(instructions).toBe(instructionsOf(renderResourcesSection(3, "/fs/app")));
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
    expect(instructions).toBe(instructionsOf(MEMORY_SAVE, PROFILE_SAVE, renderResourcesSection(2, "/fs/app")));
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

// ── guuey#981: the MCP result side-channel carries `_meta` too ──────────────
// `@openai/agents` exposes an MCP tool result to us ONLY through
// `customDataExtractor` (context: structuredContent, resultMeta, isError,
// toolOutput). The card's locator rides the MCP-Apps side-channel
// (`_meta.ui` + surface `structuredContent`); forwarding structuredContent
// alone (the cache-marker precedent) leaves the facet with no `_meta` to
// route into `uiData`.
describe("mcpCustomData (guuey#981)", () => {
  it("carries structuredContent AND resultMeta (as `_meta`) when both are present", () => {
    expect(
      mcpCustomData({
        structuredContent: { cache: { hit: false }, resourceUri: "ui://ggui/render/r1/abc" },
        resultMeta: { ui: { resourceUri: "ui://ggui/render/r1/abc" } },
      }),
    ).toEqual({
      structuredContent: { cache: { hit: false }, resourceUri: "ui://ggui/render/r1/abc" },
      _meta: { ui: { resourceUri: "ui://ggui/render/r1/abc" } },
    });
  });

  it("carries whichever is present alone, and returns undefined when neither is (no empty customData on the wire)", () => {
    expect(mcpCustomData({ structuredContent: { cache: { hit: true } } })).toEqual({
      structuredContent: { cache: { hit: true } },
    });
    expect(mcpCustomData({ resultMeta: { ui: { resourceUri: "ui://x" } } })).toEqual({
      _meta: { ui: { resourceUri: "ui://x" } },
    });
    expect(mcpCustomData({})).toBeUndefined();
  });
});

describe("the welcome card the Router already drew reaches the OpenAI run input's directive block", () => {
  const shown = { heading: "Welcome to Harbor Books", message: "Glad you're here.", options: ["Find a book", "Opening hours"] };

  it("renders the section with or without the ggui rail; none when no card was drawn; never in the instructions", async () => {
    for (const gguiAttached of [true, false]) {
      const { instructions, input } = await captureTurn({ firstImpressionShown: shown, gguiAttached });
      expect(input.startsWith(`<turn_context></turn_context>\n\n<turn_directive>\n${FIRST_IMPRESSION_SHOWN_HEADING}`)).toBe(true);
      expect(input).toContain('"options":["Find a book","Opening hours"]');
      expect(instructions).not.toContain(FIRST_IMPRESSION_SHOWN_HEADING);
    }
    expect((await captureTurn({ gguiAttached: true })).input).not.toContain(FIRST_IMPRESSION_SHOWN_HEADING);
  });
});

describe("an unreadable denylist entry is named on stderr (guuey#2585)", () => {
  it('{denylist:["mcp__x__y"]} writes one [guuey] line naming the entry', async () => {
    const { sink } = collector();
    const emit = createEmitter(sink);
    const run: OpenaiRunFn = () => Promise.resolve(fakeResult({ events: [], finalOutput: "ok" }));
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await runInvokeOpenai({ ...snapshot, tools: { denylist: ["mcp__x__y"] } }, invoke(), runtime, emit, run);
    } finally {
      spy.mockRestore();
    }
    const gateLines = lines.filter((line) => line.startsWith("[guuey] tools."));
    expect(gateLines).toHaveLength(1);
    expect(gateLines[0]).toMatch(/^\[guuey\] tools\.denylist entry "mcp__x__y" cannot be read/);
  });
});
