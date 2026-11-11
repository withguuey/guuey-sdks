/**
 * No-code google-adk coverage (the production replacement for the deleted
 * Python host — previously only graceful mode was tested)
 * plus the review-driven regression pins: armed-env (the SDK actually reads
 * GEMINI_API_KEY), SSE streaming mode on runAsync, RUNNERS registry module
 * paths resolving, the graceful gate, and the import-condition (single-
 * INSTANCE) resolution.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GUUEY_DEFAULT_SYSTEM_PROMPT } from "@guuey/config";
import type { Emitter, JsonValue, StopReason } from "@guuey/worker";
import { assertGracefulSupport, loadRunner, type HostSnapshot, type HostTurn } from "../index.js";
import {
  SURFACE_FORMATTING_SECTION,
  RESPONSE_NORMS_SECTION,
  TURN_AUTHORITY_SECTION,
  GENERATIVE_UI_SECTION,
  A2UI_SECTION,
  A2UI_GUUEY_CATALOG_ID,
  MEMORY_SAVE_INSTRUCTION,
  PROFILE_SAVE_INSTRUCTION,
  renderUserMemoryRecall,
  renderProfileRecall,
  renderResourcesSection,
  renderMcpAvailabilitySection,
  renderFirstImpressionShownSection,
} from "../preamble.js";
import { createRunner, importConditionEntry, loadAdk } from "./google-adk.js";

function fakeEmitter() {
  const got = {
    hello: [] as Array<{ sdkName: string | null; sdkVersion: string | null }>,
    native: [] as JsonValue[],
    done: [] as Array<{ result: string; stopReason: StopReason | undefined }>,
    error: [] as string[],
  };
  const emit: Emitter = {
    text: () => undefined,
    done: (result, stopReason) => got.done.push({ result, stopReason }),
    error: (m) => got.error.push(m),
    native: (_f, e) => got.native.push(e),
    hello: (_f, sdkName, sdkVersion) => got.hello.push({ sdkName, sdkVersion }),
  };
  return { emit, got };
}

/**
 * The ADK resolves `GOOGLE_GENAI_API_KEY || GOOGLE_API_KEY || GEMINI_API_KEY`
 * (adk 1.3.0 + 2.0.0 dist). A developer shell carrying a real Google key would
 * otherwise win the slot, red a case, AND print the key in the assertion diff
 * (guuey#1310) — so every case in a block that calls this starts from a
 * cleared trio, and the shell's own values come back afterwards.
 */
const ADK_KEY_VARS = ["GOOGLE_GENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"] as const;
function isolateAdkKeys(): void {
  const shellKeys = new Map<(typeof ADK_KEY_VARS)[number], string | undefined>();
  beforeAll(() => {
    for (const name of ADK_KEY_VARS) shellKeys.set(name, process.env[name]);
  });
  beforeEach(() => {
    for (const name of ADK_KEY_VARS) delete process.env[name];
  });
  afterAll(() => {
    for (const name of ADK_KEY_VARS) {
      const shellValue = shellKeys.get(name);
      if (shellValue === undefined) delete process.env[name];
      else process.env[name] = shellValue;
    }
  });
}

/** The ADK's `Gemini` as the fakes see it (guuey#1342): the runner constructs it with the sanctioned key. */
class FakeGemini {
  static readonly supportedModels: Array<string | RegExp> = [/gemini-.*/];
  constructor(public readonly params: { model: string; apiKey: string }) {}
}

/** The ADK's model registry and base model class as the fakes see them (guuey#2139). */
const fakeRegistry = { register: (): void => undefined, resolve: (): object => FakeGemini };
class FakeBaseLlm {}

describe("no-code turn (createRunner without GUUEY_AGENT_ENTRY)", () => {
  const base = mkdtempSync(join(tmpdir(), "adk-nocode-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  afterEach(() => {
    delete process.env.GUUEY_AGENT_ENTRY;
  });
  // guuey#1342: with the trio cleared the runner hands the model NAME through
  // (the assertions below); the key-precedence case sets its own values.
  isolateAdkKeys();

  it("guuey#1342: the sanctioned GEMINI_API_KEY WINS over an ambient Google variable — the runner keys the model explicitly; unset or empty, the model rides as its name (the SDK's own chain)", async () => {
    const session = join(base, "s-key");
    mkdirSync(join(session, ".guuey", "credentials"), { recursive: true });
    const captured: { model?: string | object } = {};
    const fakeAdk = {
      LlmAgent: class {
        constructor(params: { name: string; model: string | object; instruction: string | (() => string); tools: unknown[] }) {
          captured.model = params.model;
        }
      },
      Gemini: FakeGemini,
      LLMRegistry: fakeRegistry,
      BaseLlm: FakeBaseLlm,
      MCPToolset: class {
        constructor(_: unknown) {}
      },
      InMemoryRunner: class {
        readonly appName = "fake";
        readonly sessionService = {
          createSession: ({ userId }: { appName: string; userId: string }) => Promise.resolve({ id: `s-${userId}` }),
        };
        constructor(_: { agent: object }) {}
        async *runAsync(_: unknown): AsyncGenerator<JsonValue, void, undefined> {
          yield { content: { parts: [{ text: "ok" }] } };
        }
      },
    };
    // The key is resolved once, at runner creation (guuey#2139: no envelope →
    // the legacy GEMINI_API_KEY), so each channel state gets its own runner.
    const newRunner = () => createRunner({}, { load: () => Promise.resolve(fakeAdk) });
    const turn: HostTurn = {
      input: "hi",
      identity: { userId: "u-1", authMode: "anonymous" },
      fs: { app: base, home: base, session },
      history: [],
    };

    // Both ambient variables present — the ones the SDK's chain reads FIRST.
    process.env.GOOGLE_GENAI_API_KEY = "ambient-genai";
    process.env.GOOGLE_API_KEY = "ambient-google";
    process.env.GEMINI_API_KEY = "rotated-gemini";
    await newRunner().runTurn({ model: "gemini-3.5-pro", systemPrompt: "be terse" }, turn, fakeEmitter().emit);
    if (!(captured.model instanceof FakeGemini)) throw new Error("expected the runner to construct the model with the sanctioned key");
    expect(captured.model.params).toEqual({ model: "gemini-3.5-pro", apiKey: "rotated-gemini" });

    // The channel unset → the name rides, the SDK's own chain decides (as before).
    delete process.env.GEMINI_API_KEY;
    await newRunner().runTurn({ model: "gemini-3.5-pro", systemPrompt: "be terse" }, turn, fakeEmitter().emit);
    expect(captured.model).toBe("gemini-3.5-pro");

    // An EMPTY channel is unset, never an empty key handed to the model.
    process.env.GEMINI_API_KEY = "";
    await newRunner().runTurn({ model: "gemini-3.5-pro", systemPrompt: "be terse" }, turn, fakeEmitter().emit);
    expect(captured.model).toBe("gemini-3.5-pro");

    // guuey#2139: with a launch envelope the envelope's token keys the model and
    // the environment's key-slot variables are never read.
    process.env.GEMINI_API_KEY = "env-must-not-win";
    await createRunner({ envelope: { v: 1, model: { wire: "gemini", token: "envelope-token" } } }, { load: () => Promise.resolve(fakeAdk) })
      .runTurn({ model: "gemini-3.5-pro", systemPrompt: "be terse" }, turn, fakeEmitter().emit);
    if (!(captured.model instanceof FakeGemini)) throw new Error("expected the envelope token to key the model");
    expect(captured.model.params).toEqual({ model: "gemini-3.5-pro", apiKey: "envelope-token" });
  });

  it("constructs the LlmAgent from the snapshot (class-only instruction, cred toolsets, model), streams SSE, role-pinned, the turn context first", async () => {
    // A real cred file on disk — the production contract the broker writes.
    const session = join(base, "session");
    mkdirSync(join(session, ".guuey", "credentials"), { recursive: true });
    writeFileSync(
      join(session, ".guuey", "credentials", "todo.json"),
      JSON.stringify({ url: "https://mcp.dev/proxy/x/", transport: "http", headers: { authorization: "Bearer t" } }),
    );

    const captured: { agent?: unknown; runAsync?: unknown; toolsets: unknown[] } = { toolsets: [] };
    const fakeAdk = {
      LlmAgent: class {
        constructor(
          public readonly params: {
            name: string;
            // guuey#1342: the runner may hand a constructed model, not only its name.
            model: string | object;
            instruction: string | (() => string);
            tools: unknown[];
          },
        ) {
          captured.agent = this;
        }
      },
      Gemini: FakeGemini,
      LLMRegistry: fakeRegistry,
      BaseLlm: FakeBaseLlm,
      MCPToolset: class {
        constructor(public readonly params: unknown) {
          captured.toolsets.push(params);
        }
      },
      InMemoryRunner: class {
        readonly appName = "fake";
        readonly sessionService = {
          createSession: ({ userId }: { appName: string; userId: string }) => Promise.resolve({ id: `s-${userId}` }),
        };
        constructor(public readonly p: { agent: object }) {}
        async *runAsync(params: unknown): AsyncGenerator<JsonValue, void, undefined> {
          captured.runAsync = params;
          yield { content: { parts: [{ text: "streamed answer" }] } };
        }
      },
    };
    const runner = createRunner({}, { load: () => Promise.resolve(fakeAdk) });
    const { emit, got } = fakeEmitter();
    const turn: HostTurn = {
      input: "do the thing",
      identity: { userId: "u-1", authMode: "anonymous" },
      fs: { app: base, home: base, session },
      history: [{ role: "user", text: "earlier" }],
      priorMemory: [{ key: "k", value: 1 }],
      priorState: { s: true },
    };
    await runner.runTurn({ model: "gemini-3.5-pro", systemPrompt: "be terse" }, turn, emit);

    expect(got.error).toEqual([]);
    const agent = captured.agent as {
      params: { name: string; model: string | object; instruction: string | (() => string); tools: unknown[] };
    };
    expect(agent.params.model).toBe("gemini-3.5-pro");
    // F7: instruction rides as a FUNCTION, never a raw string — a string
    // instruction is routed through ADK's `{var}` session-state substitution,
    // and the builder's prompt may itself contain `{...}` (see
    // google-adk.test.ts for the crash proof against the real SDK). A1: it is
    // the class-only system prompt; the per-turn context leads the message.
    expect(typeof agent.params.instruction).toBe("function");
    const resolvedInstruction = (agent.params.instruction as () => string)();
    expect(resolvedInstruction).toBe(systemPromptOf());
    expect(resolvedInstruction).not.toContain("<conversation_history>");
    expect(agent.params.tools).toHaveLength(1);
    expect(captured.toolsets[0]).toEqual({
      type: "StreamableHTTPConnectionParams",
      url: "https://mcp.dev/proxy/x/",
      transportOptions: { requestInit: { headers: { authorization: "Bearer t" } } },
    });
    // role pin + SSE streaming mode (Python-host parity) on the real call; the
    // context (history + memory + state) AUTO-INJECTED even in no-code, as the
    // message's first part:
    const call = captured.runAsync as { newMessage: { parts: Array<{ text?: string }> } };
    expect(captured.runAsync).toMatchObject({ userId: "u-1", sessionId: "s-u-1", runConfig: { streamingMode: "sse" } });
    expect(call.newMessage).toMatchObject({ role: "user" });
    expect(call.newMessage.parts).toHaveLength(3);
    const context = call.newMessage.parts[0]?.text ?? "";
    expect(context.startsWith("<turn_context>\n")).toBe(true);
    expect(context).toContain("<conversation_history>");
    expect(context).toContain("<thread_memory>");
    expect(context).toContain("<working_state>");
    // No order this turn: the directive block is still the second part, empty.
    expect(call.newMessage.parts[1]).toEqual({ text: "<turn_directive></turn_directive>" });
    expect(call.newMessage.parts[2]).toEqual({ text: "do the thing" });
    expect(got.done[0]?.result).toBe("streamed answer");
  });

  /** The no-code system prompt for "be terse": the class-level sections `mid`, then surface, authority, norms. */
  function systemPromptOf(...mid: string[]): string {
    return "be terse" + mid.join("") + SURFACE_FORMATTING_SECTION + TURN_AUTHORITY_SECTION + RESPONSE_NORMS_SECTION;
  }
  const MEMORY_SAVE = `\n\n${MEMORY_SAVE_INSTRUCTION}`;
  const PROFILE_SAVE = `\n\n${PROFILE_SAVE_INSTRUCTION}`;
  const EMPTY_CONTEXT = "<turn_context></turn_context>";
  const EMPTY_DIRECTIVE = "<turn_directive></turn_directive>";

  /**
   * Run one no-code turn and return the resolved F7 function-instruction string
   * and the text parts of the message the turn sent (its context blocks, then
   * its input). Asserts the instruction is a FUNCTION (F7 brace-safety).
   */
  async function resolveTurn(
    over: Partial<HostTurn>,
    snapshot: HostSnapshot = { model: "gemini-3.5-pro", systemPrompt: "be terse" }
  ): Promise<{ instruction: string; texts: string[] }> {
    const session = join(base, `mem-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(session, ".guuey", "credentials"), { recursive: true });
    const captured: { agent?: unknown; texts: string[] } = { texts: [] };
    const fakeAdk = {
      LlmAgent: class {
        constructor(
          public readonly params: { name: string; model: string | object; instruction: string | (() => string); tools: unknown[] },
        ) {
          captured.agent = this;
        }
      },
      Gemini: FakeGemini,
      LLMRegistry: fakeRegistry,
      BaseLlm: FakeBaseLlm,
      MCPToolset: class {
        constructor(_: unknown) {}
      },
      InMemoryRunner: class {
        readonly appName = "fake";
        readonly sessionService = {
          createSession: ({ userId }: { appName: string; userId: string }) => Promise.resolve({ id: `s-${userId}` }),
        };
        constructor(_: { agent: object }) {}
        async *runAsync(params: { newMessage: { parts: Array<{ text: string } | { inlineData: object }> } }): AsyncGenerator<JsonValue, void, undefined> {
          captured.texts = params.newMessage.parts.flatMap((part) => ("text" in part ? [part.text] : []));
          yield { content: { parts: [{ text: "ok" }] } };
        }
      },
    };
    const runner = createRunner({}, { load: () => Promise.resolve(fakeAdk) });
    const { emit, got } = fakeEmitter();
    const turn: HostTurn = {
      input: "hi",
      identity: { userId: "u-mem", authMode: "authenticated" },
      fs: { app: base, home: base, session },
      history: [],
      ...over,
    };
    await runner.runTurn(snapshot, turn, emit);
    expect(got.error).toEqual([]);
    const agent = captured.agent as { params: { instruction: string | (() => string) } };
    // Still a FUNCTION (F7 brace-safety) — the builder's prompt may contain `{...}`,
    // which a string instruction would 400 on.
    expect(typeof agent.params.instruction).toBe("function");
    return { instruction: (agent.params.instruction as () => string)(), texts: captured.texts };
  }

  /** The resolved instruction alone. */
  async function resolveInstruction(over: Partial<HostTurn>, snapshot?: HostSnapshot): Promise<string> {
    return (await resolveTurn(over, snapshot)).instruction;
  }

  it("prompt-less snapshot → GUUEY_DEFAULT_SYSTEM_PROMPT rides the instruction (parity with the claude/openai arms)", async () => {
    const resolved = await resolveInstruction({}, { model: "gemini-3.5-pro" });
    expect(resolved).toBe(GUUEY_DEFAULT_SYSTEM_PROMPT + SURFACE_FORMATTING_SECTION + TURN_AUTHORITY_SECTION + RESPONSE_NORMS_SECTION);
  });

  it("the welcome card the Router already drew → its section in the turn's directive block, byte-identical to the shared renderer, rail or no rail", async () => {
    const shown = { heading: "Welcome to Harbor Books", message: "Glad you're here.", options: ["Find a book", "Opening hours"] };
    const directive = `<turn_directive>\n${renderFirstImpressionShownSection(shown).slice(2)}\n</turn_directive>`;
    expect(await resolveTurn({ firstImpressionShown: shown })).toEqual({
      instruction: systemPromptOf(),
      texts: [EMPTY_CONTEXT, directive, "hi"],
    });
    expect((await resolveTurn({ firstImpressionShown: shown, gguiAttached: true })).texts[1]).toBe(directive);
    expect((await resolveTurn({})).texts).toEqual([EMPTY_CONTEXT, EMPTY_DIRECTIVE, "hi"]);
  });

  it("authenticated + attached + userMemory → the save instruction in the instruction, the byte-identical recall block in the turn context (memory-mcp T5)", async () => {
    const { instruction, texts } = await resolveTurn({
      identity: { userId: "u-mem", authMode: "authenticated" },
      memoryAttached: true,
      userMemory: "User's name is Ada.",
    });
    // Identical section content to Claude/OpenAI.
    expect(instruction).toBe(systemPromptOf(MEMORY_SAVE));
    expect(instruction).toContain("`save_memory` tool");
    expect(texts[0]).toBe(`<turn_context>\n${renderUserMemoryRecall("User's name is Ada.").slice(2)}\n</turn_context>`);
    expect(texts[0]).toContain("<user_memory>\nUser's name is Ada.\n</user_memory>");
  });

  it("BOOTSTRAP: authenticated + attached + NO userMemory (brand-new user) → save-only, NO recall block", async () => {
    const { instruction, texts } = await resolveTurn({
      identity: { userId: "u-mem", authMode: "authenticated" },
      memoryAttached: true,
    });
    expect(instruction).toBe(systemPromptOf(MEMORY_SAVE));
    expect(texts[0]).toBe(EMPTY_CONTEXT);
  });

  it("authenticated + NOT attached → NO memory section, even with userMemory (no tool → no instruction)", async () => {
    const { instruction, texts } = await resolveTurn({
      identity: { userId: "u-mem", authMode: "authenticated" },
      memoryAttached: false,
      userMemory: "orphaned",
    });
    expect(instruction).toBe(systemPromptOf());
    expect(texts[0]).toBe(EMPTY_CONTEXT);
  });

  it("anonymous + attached → NO memory section (guest never gets the memory tool)", async () => {
    const { instruction, texts } = await resolveTurn({
      identity: { userId: "g-1", authMode: "anonymous" },
      memoryAttached: true,
      userMemory: "guest",
    });
    expect(instruction).toBe(systemPromptOf());
    expect(texts[0]).toBe(EMPTY_CONTEXT);
  });

  it("guuey#2386: a client that draws guuey A2UI gets the section DIRECTLY AFTER generative UI, byte-identical to Claude's", async () => {
    const resolved = await resolveInstruction({ gguiAttached: true, clientCatalogs: [A2UI_GUUEY_CATALOG_ID] });
    expect(resolved.endsWith(SURFACE_FORMATTING_SECTION + GENERATIVE_UI_SECTION + A2UI_SECTION + TURN_AUTHORITY_SECTION + RESPONSE_NORMS_SECTION)).toBe(true);
    const plain = await resolveInstruction({ gguiAttached: true, clientCatalogs: ["guuey.json-render.v1"] });
    expect(plain).not.toContain(A2UI_SECTION);
  });

  it('guuey#2262: tools.allowlist ["@none"] leaves out the SAVE instruction and the generative-UI section, keeps the recall', async () => {
    const turn: Partial<HostTurn> = {
      identity: { userId: "u-mem", authMode: "authenticated" },
      memoryAttached: true,
      userMemory: "Ada.",
      gguiAttached: true,
      clientCatalogs: [A2UI_GUUEY_CATALOG_ID],
    };
    const none = await resolveTurn(turn, {
      model: "gemini-3.5-pro",
      systemPrompt: "be terse",
      tools: { allowlist: ["@none"] },
    });
    expect(none.instruction).toBe(systemPromptOf());
    expect(none.texts[0]).toBe(`<turn_context>\n${renderUserMemoryRecall("Ada.").slice(2)}\n</turn_context>`);
    // Control: an allowlist that keeps a tool keeps both sections.
    const control = await resolveTurn(turn, {
      model: "gemini-3.5-pro",
      systemPrompt: "be terse",
      tools: { allowlist: ["ggui.*"] },
    });
    expect(control.instruction).toContain("`save_memory` tool");
    expect(control.instruction).toContain(GENERATIVE_UI_SECTION + A2UI_SECTION);
    expect(control.texts[0]).toContain(renderUserMemoryRecall("Ada.").slice(2));
  });

  it('guuey#2262: tools.allowlist ["@none"] leaves out the profile SAVE instruction and the first impression, keeps the profile recall', async () => {
    const turn: Partial<HostTurn> = {
      identity: { userId: "u-mem", authMode: "authenticated" },
      gguiAttached: true,
      profileAccess: "read-write",
      profileSections: [{ app: "Todoist", content: "Prefers short replies." }],
      firstImpression: { chipKey: "c5c73c61f370", intent: "Opening hours", contract: { propsSpec: { properties: {} } } },
    };
    const none = await resolveTurn(turn, { model: "gemini-3.5-pro", systemPrompt: "be terse", tools: { allowlist: ["@none"] } });
    expect(none.instruction).not.toContain("save_profile");
    expect(none.texts.join("\n\n")).toContain("Prefers short replies.");
    expect(none.texts.join("\n\n")).not.toContain("ggui_handshake");
    const control = await resolveTurn(turn, { model: "gemini-3.5-pro", systemPrompt: "be terse", tools: { allowlist: ["ggui.*"] } });
    expect(control.instruction).toContain("save_profile");
    expect(control.texts[1]).toContain("ggui_handshake");
  });

  // ── cross-app profile sections (profile T7) — SIBLINGS of the memory sections ──
  const PROFILE_SECTIONS = [{ app: "Todoist", content: "Prefers short replies." }];

  it("authenticated + read-write + sections → memory THEN profile, in both the instruction and the turn context", async () => {
    const { instruction, texts } = await resolveTurn({
      identity: { userId: "u-mem", authMode: "authenticated" },
      memoryAttached: true,
      userMemory: "User's name is Ada.",
      profileAccess: "read-write",
      profileSections: PROFILE_SECTIONS,
    });
    expect(instruction).toBe(systemPromptOf(MEMORY_SAVE, PROFILE_SAVE));
    expect(texts[0]).toBe(
      `<turn_context>\n${renderUserMemoryRecall("User's name is Ada.").slice(2)}${renderProfileRecall(PROFILE_SECTIONS)}\n</turn_context>`,
    );
    expect(texts[0]).toContain("### From Todoist");
  });

  it("authenticated + read (read-only) + sections → recall only, NO save instruction", async () => {
    const { instruction, texts } = await resolveTurn({
      identity: { userId: "u-mem", authMode: "authenticated" },
      profileAccess: "read",
      profileSections: PROFILE_SECTIONS,
    });
    expect(instruction).toBe(systemPromptOf());
    expect(texts[0]).toBe(`<turn_context>\n${renderProfileRecall(PROFILE_SECTIONS).slice(2)}\n</turn_context>`);
  });

  it("authenticated + NO profileAccess → NO profile section (fail-closed default)", async () => {
    const { instruction, texts } = await resolveTurn({
      identity: { userId: "u-mem", authMode: "authenticated" },
      profileSections: PROFILE_SECTIONS,
    });
    expect(instruction).toBe(systemPromptOf());
    expect(texts[0]).toBe(EMPTY_CONTEXT);
  });

  it("anonymous + profileAccess present → NO profile section (guest never gets the profile)", async () => {
    const { instruction, texts } = await resolveTurn({
      identity: { userId: "g-1", authMode: "anonymous" },
      profileAccess: "read-write",
      profileSections: PROFILE_SECTIONS,
    });
    expect(instruction).toBe(systemPromptOf());
    expect(texts[0]).toBe(EMPTY_CONTEXT);
  });

  // ── app-resources section (guuey#456 B4) — after the SAVE instructions ──

  it("fsBound + resourceCount > 0 → the resources hint, byte-identical to the framework-blind renderer, naming the turn's fs.app", async () => {
    const resolved = await resolveInstruction({ fsBound: true, resourceCount: 2 });
    // The helper's turn fs.app is `base` (a real tmp path) — the section names
    // THAT dir, never a hardcoded /app.
    expect(resolved).toBe(systemPromptOf(renderResourcesSection(2, base)));
    expect(resolved).toContain("## App resources");
    expect(resolved).toContain(`2 reference files at ${base}/resources`);
  });

  it("memory + profile + resources → appended in that order, byte-identical to the renderers", async () => {
    const resolved = await resolveInstruction({
      identity: { userId: "u-mem", authMode: "authenticated" },
      memoryAttached: true,
      userMemory: "Ada",
      profileAccess: "read-write",
      profileSections: PROFILE_SECTIONS,
      fsBound: true,
      resourceCount: 1,
    });
    expect(resolved).toBe(systemPromptOf(MEMORY_SAVE, PROFILE_SAVE, renderResourcesSection(1, base)));
  });

  it("fsBound false/absent + resourceCount present → NO resources section (no file tools to read them)", async () => {
    expect(await resolveInstruction({ fsBound: false, resourceCount: 3 })).toBe(systemPromptOf());
    expect(await resolveInstruction({ resourceCount: 3 })).toBe(systemPromptOf());
  });

  it("resourceCount 0/absent → NO resources section", async () => {
    expect(await resolveInstruction({ fsBound: true, resourceCount: 0 })).toBe(systemPromptOf());
    expect(await resolveInstruction({ fsBound: true })).toBe(systemPromptOf());
  });

  it("an sse cred file fails the turn with the actionable transport error", async () => {
    const session = join(base, "sse-session");
    mkdirSync(join(session, ".guuey", "credentials"), { recursive: true });
    writeFileSync(
      join(session, ".guuey", "credentials", "legacy.json"),
      JSON.stringify({ url: "https://old.dev/sse", transport: "sse", headers: {} }),
    );
    const fakeAdk = {
      LlmAgent: class {
        constructor(_: { name: string; model: string | object; instruction: string | (() => string); tools: unknown[] }) {}
      },
      Gemini: FakeGemini,
      LLMRegistry: fakeRegistry,
      BaseLlm: FakeBaseLlm,
      MCPToolset: class {
        constructor(_: unknown) {}
      },
      // never reached — the sse rejection throws before agent construction
      InMemoryRunner: class {
        readonly appName = "unreached";
        readonly sessionService = {
          createSession: (_: { appName: string; userId: string }) => Promise.resolve({ id: "unreached" }),
        };
        constructor(_: { agent: object }) {}
        // eslint-disable-next-line require-yield
        async *runAsync(_: unknown): AsyncGenerator<JsonValue, void, undefined> {
          throw new Error("unreached");
        }
      },
    };
    const runner = createRunner({}, { load: () => Promise.resolve(fakeAdk) });
    const { emit, got } = fakeEmitter();
    await runner.runTurn({}, {
      input: "x",
      identity: { userId: "u", authMode: "anonymous" },
      fs: { app: session, home: session, session },
      history: [],
    }, emit);
    expect(got.error[0]).toMatch(/legacy.*sse.*Streamable-HTTP only/s);
    expect(got.done).toHaveLength(0);
  });

  it("connected-services section (guuey#901): present → in the turn context, identical renderer; never in the instruction", async () => {
    const availability = [{ server: "platform", state: "connected" as const }];
    const { instruction, texts } = await resolveTurn({
      identity: { userId: "u-oauth", authMode: "authenticated" },
      mcpAvailability: availability,
    });
    expect(instruction).toBe(systemPromptOf());
    expect(texts[0]).toBe(`<turn_context>\n${renderMcpAvailabilitySection(availability).slice(2)}\n</turn_context>`);
  });

  it("A1: two users of one class get a byte-identical instruction; the class change (guest) changes it", async () => {
    const a = await resolveTurn({
      identity: { userId: "u-a", authMode: "authenticated" },
      memoryAttached: true,
      userMemory: "A likes tea.",
      history: [{ role: "user", text: "first" }],
    });
    const b = await resolveTurn({
      identity: { userId: "u-b", authMode: "authenticated" },
      memoryAttached: true,
      userMemory: "B is vegan.",
      priorState: { step: 2 },
      mcpAvailability: [{ server: "linear", state: "denied" }],
    });
    expect(a.instruction).toBe(b.instruction);
    expect(a.texts).not.toEqual(b.texts);
    const guest = await resolveTurn({ identity: { userId: "g", authMode: "anonymous" }, memoryAttached: true });
    expect(guest.instruction).not.toBe(a.instruction);
  });
});

/**
 * These two construct the REAL @google/adk agent + runner (no spawn, no
 * tsc — but a heavyweight module graph): ~1 s warm on a Mac, 8.3 s on the
 * 2-vCPU `Unit (oss)` runner under turbo fan-out (guuey#864 run 33969609440),
 * where vitest's 5 s default reported them as failures. The budget is the
 * #867 rule applied to in-process construction, not just to spawns.
 */
const REAL_ADK_BUDGET_MS = 60_000;

describe("armed-env (spec §2.1.6): the REAL @google/adk reads the pod's gemini pair", () => {
  isolateAdkKeys();

  it("Gemini picks GEMINI_API_KEY from env (the buildWorkerEnv keySlot)", { timeout: REAL_ADK_BUDGET_MS }, async () => {
    process.env.GEMINI_API_KEY = "opaque-broker-token";
    const adk = (await import("@google/adk")) as { Gemini: new (p: { model: string }) => object };
    const llm = new adk.Gemini({ model: "gemini-3.5-flash" });
    // `apiKey` is a private-typed but own enumerable property — inspect via
    // JSON round-trip (structural boundary, no type erasure of shaped data).
    const shape = JSON.parse(JSON.stringify(llm)) as { apiKey?: string };
    expect(shape.apiKey).toBe("opaque-broker-token");
  });

  it("GOOGLE_GENAI_API_KEY takes precedence when both are set (the SDK's || order)", { timeout: REAL_ADK_BUDGET_MS }, async () => {
    process.env.GOOGLE_GENAI_API_KEY = "genai-first";
    process.env.GEMINI_API_KEY = "gemini-second";
    const adk = (await import("@google/adk")) as { Gemini: new (p: { model: string }) => object };
    const shape = JSON.parse(JSON.stringify(new adk.Gemini({ model: "gemini-3.5-flash" }))) as { apiKey?: string };
    expect(shape.apiKey).toBe("genai-first");
  });

  it("an explicit `apiKey` beats the env chain — what the no-code runner now hands the model (guuey#1342)", { timeout: REAL_ADK_BUDGET_MS }, async () => {
    process.env.GOOGLE_GENAI_API_KEY = "ambient-genai";
    process.env.GOOGLE_API_KEY = "ambient-google";
    const adk = (await import("@google/adk")) as { Gemini: new (p: { model: string; apiKey: string }) => object };
    const shape = JSON.parse(JSON.stringify(new adk.Gemini({ model: "gemini-3.5-flash", apiKey: "rotated-gemini" }))) as { apiKey?: string };
    expect(shape.apiKey).toBe("rotated-gemini");
  });
});

/**
 * The Gemini API's answer to an invalid key on the streaming path, captured
 * from generativelanguage.googleapis.com on 2026-09-28 with a deliberately
 * invalid key: HTTP 400 (not a 401 or 403), `content-type: text/event-stream`,
 * this JSON body byte for byte, and no `x-should-retry` / `retry-after` header.
 */
const GEMINI_INVALID_KEY_BODY = `${JSON.stringify(
  {
    error: {
      code: 400,
      message: "API key not valid. Please pass a valid API key.",
      status: "INVALID_ARGUMENT",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "API_KEY_INVALID",
          domain: "googleapis.com",
          metadata: { service: "generativelanguage.googleapis.com" },
        },
        {
          "@type": "type.googleapis.com/google.rpc.LocalizedMessage",
          locale: "en-US",
          message: "API key not valid. Please pass a valid API key.",
        },
      ],
    },
  },
  null,
  2
)}\n`;

interface FakeGeminiAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A local stand-in for the Gemini endpoint: it records every request path and gives every request the same answer. */
async function startFakeGeminiEndpoint(
  answer: FakeGeminiAnswer
): Promise<{ baseUrl: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the fake Gemini endpoint has no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err === undefined ? resolve() : reject(err)));
      }),
  };
}

/**
 * A refused key on the no-code Gemini path: how many times does the REAL
 * model client call the provider in one turn? The client reads its endpoint
 * from `GOOGLE_GEMINI_BASE_URL`, pointed here at a local endpoint, so nothing
 * leaves the machine.
 *
 * Measured with `@google/adk` at its defaults: ONE call for every answer below.
 * The ADK builds its `GoogleGenAI` client with headers only (no
 * `retryOptions`), and `@google/genai` retries only when `retryOptions` are
 * set. `@google/genai` also never reads `x-should-retry`: the control arm sets
 * `retryOptions` on the same client, and a 503 marked do-not-retry is retried
 * anyway. So a do-not-retry header added by a proxy in front of the worker
 * has no effect on this client, and at the defaults none is needed: a bad key
 * cannot multiply into a stream of provider calls here.
 */
describe("a refused Gemini key costs ONE provider call per turn at the ADK's default retry settings", () => {
  isolateAdkKeys();
  const ROUTING_VARS = ["GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI"] as const;
  const shellRouting = new Map<(typeof ROUTING_VARS)[number], string | undefined>();
  const base = mkdtempSync(join(tmpdir(), "adk-refusal-"));
  const MODEL = "gemini-2.5-flash";
  const STREAM_PATH = `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;
  const JSON_HEADERS = { "content-type": "application/json" };

  beforeAll(() => {
    for (const name of ROUTING_VARS) shellRouting.set(name, process.env[name]);
  });
  beforeEach(() => {
    for (const name of ROUTING_VARS) delete process.env[name];
  });
  afterAll(() => {
    for (const name of ROUTING_VARS) {
      const shellValue = shellRouting.get(name);
      if (shellValue === undefined) delete process.env[name];
      else process.env[name] = shellValue;
    }
    rmSync(base, { recursive: true, force: true });
  });

  /** One no-code turn through the real runner (real `@google/adk`), pointed at the fake endpoint. */
  async function noCodeTurn(
    answer: FakeGeminiAnswer
  ): Promise<{ calls: string[]; got: ReturnType<typeof fakeEmitter>["got"] }> {
    const endpoint = await startFakeGeminiEndpoint(answer);
    try {
      process.env.GEMINI_API_KEY = "local-endpoint-key";
      process.env.GOOGLE_GEMINI_BASE_URL = endpoint.baseUrl;
      const session = mkdtempSync(join(base, "s-"));
      const { emit, got } = fakeEmitter();
      await createRunner().runTurn(
        { model: MODEL, systemPrompt: "be terse" },
        {
          input: "hi",
          identity: { userId: "u-refused", authMode: "anonymous" },
          fs: { app: session, home: session, session },
          history: [],
        },
        emit
      );
      return { calls: endpoint.calls, got };
    } finally {
      await endpoint.close();
    }
  }

  it(
    "the Gemini API's own invalid-key answer (a 400) → one call, and the turn carries the provider's refusal",
    { timeout: REAL_ADK_BUDGET_MS },
    async () => {
      const { calls, got } = await noCodeTurn({
        status: 400,
        headers: { "content-type": "text/event-stream" },
        body: GEMINI_INVALID_KEY_BODY,
      });
      expect(calls).toEqual([STREAM_PATH]);
      // The ADK ends the model call on its first answer: one error event, the provider's own body as its message.
      const refusals = got.native.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          !Array.isArray(event) &&
          "errorCode" in event
      );
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({ errorCode: "400" });
      expect(JSON.stringify(refusals[0])).toContain("API_KEY_INVALID");
    }
  );

  it.each([401, 403])(
    "a %i marked x-should-retry: false → one call",
    { timeout: REAL_ADK_BUDGET_MS },
    async (status) => {
      const { calls } = await noCodeTurn({
        status,
        headers: { ...JSON_HEADERS, "x-should-retry": "false" },
        body: `{"error":{"code":${status}}}`,
      });
      expect(calls).toEqual([STREAM_PATH]);
    }
  );

  it.each([429, 503])(
    "a %i, which @google/genai retries once retries are configured → still one call at the defaults",
    { timeout: REAL_ADK_BUDGET_MS },
    async (status) => {
      const { calls } = await noCodeTurn({
        status,
        headers: JSON_HEADERS,
        body: `{"error":{"code":${status}}}`,
      });
      expect(calls).toEqual([STREAM_PATH]);
    }
  );

  it(
    "control: the same client with retries configured DOES retry, and ignores x-should-retry: false",
    { timeout: REAL_ADK_BUDGET_MS },
    async () => {
      const endpoint = await startFakeGeminiEndpoint({
        status: 503,
        headers: { ...JSON_HEADERS, "x-should-retry": "false" },
        body: '{"error":{"code":503}}',
      });
      try {
        process.env.GOOGLE_GEMINI_BASE_URL = endpoint.baseUrl;
        const adk = await import("@google/adk");
        const agent = new adk.LlmAgent({
          name: "control",
          model: new adk.Gemini({ model: MODEL, apiKey: "local-endpoint-key" }),
          instruction: "be terse",
          generateContentConfig: {
            httpOptions: { retryOptions: { attempts: 3, initialDelay: 0.01, maxDelay: 0.02 } },
          },
        });
        const runner = new adk.InMemoryRunner({ agent });
        const session = await runner.sessionService.createSession({
          appName: runner.appName,
          userId: "u-control",
        });
        const errorCodes: Array<string | undefined> = [];
        for await (const event of runner.runAsync({
          userId: "u-control",
          sessionId: session.id,
          newMessage: { role: "user", parts: [{ text: "hi" }] },
          runConfig: { streamingMode: adk.StreamingMode.SSE },
        })) {
          errorCodes.push(event.errorCode);
        }
        expect(errorCodes).toEqual(["503"]);
        expect(endpoint.calls).toEqual([STREAM_PATH, STREAM_PATH, STREAM_PATH]);
      } finally {
        await endpoint.close();
      }
    }
  );
});

describe("RUNNERS registry paths resolve for real (dist/module-name drift guard)", () => {
  afterEach(() => {
    delete process.env.GUUEY_AGENT_ENTRY;
  });
  it("every registered framework's runner module loads and returns a runner", async () => {
    for (const framework of ["claude-agent-sdk", "openai-agents-sdk", "google-adk"]) {
      const runner = await loadRunner(framework);
      expect(typeof runner.runTurn).toBe("function");
    }
  });
});

describe("assertGracefulSupport — 'non-goal' means rejected loudly, not ignored", () => {
  it("throws for claude/openai when GUUEY_AGENT_ENTRY is set", () => {
    expect(() => assertGracefulSupport("claude-agent-sdk", "agent.js")).toThrow(/not supported for framework "claude-agent-sdk"/);
    expect(() => assertGracefulSupport("openai-agents-sdk", "agent.js")).toThrow(/full worker/);
  });
  it("passes for google-adk with an entry, and for anyone without one", () => {
    expect(() => assertGracefulSupport("google-adk", "agent.js")).not.toThrow();
    expect(() => assertGracefulSupport("claude-agent-sdk", undefined)).not.toThrow();
    expect(() => assertGracefulSupport("claude-agent-sdk", "")).not.toThrow();
  });
});

describe("importConditionEntry — the single-INSTANCE rule (ESM/CJS dual-package hazard)", () => {
  const base = mkdtempSync(join(tmpdir(), "adk-cond-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("returns the exports '.' import target; loadAdk drives the ESM instance the dev's agent imports", async () => {
    const worker = join(base, "worker");
    const adkDir = join(worker, "node_modules", "@google", "adk");
    mkdirSync(join(adkDir, "dist"), { recursive: true });
    writeFileSync(
      join(adkDir, "package.json"),
      JSON.stringify({
        name: "@google/adk",
        version: "1.0.0-cond",
        type: "module",
        main: "./dist/cjs.cjs",
        exports: { ".": { import: "./dist/esm.js", require: "./dist/cjs.cjs" } },
      }),
    );
    writeFileSync(join(adkDir, "dist", "esm.js"), 'export const INSTANCE = "esm-import-condition";\n');
    writeFileSync(join(adkDir, "dist", "cjs.cjs"), 'module.exports = { INSTANCE: "cjs-require-condition" };\n');
    writeFileSync(join(worker, "agent.js"), "export default {};\n");

    const resolvedCjs = join(adkDir, "dist", "cjs.cjs");
    expect(importConditionEntry(resolvedCjs)).toBe(join(adkDir, "dist", "esm.js"));

    const mod = (await loadAdk(join(worker, "agent.js"))) as unknown as { INSTANCE?: string };
    expect(mod.INSTANCE).toBe("esm-import-condition");
  });

  it("falls back to the require resolution when the package has no exports map", () => {
    const plainDir = join(base, "plain", "node_modules", "@google", "adk");
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, "package.json"), JSON.stringify({ name: "@google/adk", version: "1", main: "./index.js" }));
    expect(importConditionEntry(join(plainDir, "index.js"))).toBeUndefined();
  });
});

describe("withheldTools — the Router's per-turn withholds reach the ADK toolsets", () => {
  const base = mkdtempSync(join(tmpdir(), "adk-withheld-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  isolateAdkKeys();

  async function toolsetsFor(
    over: Partial<HostTurn>,
    tools?: { allowlist?: string[]; denylist?: string[] },
  ): Promise<Array<{ url: string; toolFilter: unknown }>> {
    const session = mkdtempSync(join(base, "s-"));
    mkdirSync(join(session, ".guuey", "credentials"), { recursive: true });
    writeFileSync(
      join(session, ".guuey", "credentials", "ggui.json"),
      JSON.stringify({ url: "https://mcp.example/apps/x", transport: "http", headers: {} }),
    );
    const built: Array<{ url: string; toolFilter: unknown }> = [];
    const fakeAdk = {
      LlmAgent: class {
        constructor(_: { name: string; model: string | object; instruction: string | (() => string); tools: unknown[] }) {}
      },
      Gemini: FakeGemini,
      LLMRegistry: fakeRegistry,
      BaseLlm: FakeBaseLlm,
      MCPToolset: class {
        constructor(params: { url: string }, toolFilter?: unknown) {
          built.push({ url: params.url, toolFilter });
        }
      },
      InMemoryRunner: class {
        readonly appName = "fake";
        readonly sessionService = {
          createSession: ({ userId }: { appName: string; userId: string }) => Promise.resolve({ id: `s-${userId}` }),
        };
        constructor(_: { agent: object }) {}
        async *runAsync(_: unknown): AsyncGenerator<JsonValue, void, undefined> {
          yield { content: { parts: [{ text: "ok" }] } };
        }
      },
    };
    const runner = createRunner({}, { load: () => Promise.resolve(fakeAdk) });
    const turn: HostTurn = {
      input: "hi",
      identity: { userId: "u-1", authMode: "anonymous" },
      fs: { app: base, home: base, session },
      history: [],
      ...over,
    };
    const { emit, got } = fakeEmitter();
    await runner.runTurn({ model: "gemini-3.5-pro", systemPrompt: "be terse", ...(tools !== undefined ? { tools } : {}) }, turn, emit);
    expect(got.error).toEqual([]);
    return built;
  }

  /** The tool names of `candidates` the toolset's predicate keeps. */
  function keptBy(toolFilter: unknown, candidates: readonly string[] = ["ggui_render", "ggui_consume", "ggui_handshake"]): string[] {
    if (typeof toolFilter !== "function") throw new Error(`expected a predicate, got ${JSON.stringify(toolFilter)}`);
    // The ADK hands the predicate its MCPTool wrapper: the name plus the listed tool.
    return candidates.filter((name) => Reflect.apply(toolFilter, undefined, [{ name, mcpTool: { name } }]) === true);
  }

  describe("the builder's tool gates reach the ADK toolsets too (guuey#1768)", () => {
    it("allowlist <server>.<tool> keeps only that tool; an allowlist naming only another server keeps nothing here", async () => {
      expect(keptBy((await toolsetsFor({}, { allowlist: ["ggui.ggui_render"] }))[0]!.toolFilter)).toEqual(["ggui_render"]);
      expect(keptBy((await toolsetsFor({}, { allowlist: ["other.ggui_render"] }))[0]!.toolFilter)).toEqual([]);
    });
    it("allowlist <server>.* keeps the toolset whole; a bare name keeps that tool", async () => {
      expect(keptBy((await toolsetsFor({}, { allowlist: ["ggui.*"] }))[0]!.toolFilter)).toEqual(["ggui_render", "ggui_consume", "ggui_handshake"]);
      expect(keptBy((await toolsetsFor({}, { allowlist: ["ggui_consume"] }))[0]!.toolFilter)).toEqual(["ggui_consume"]);
    });
    it("denylist removes a tool (qualified or bare) or the whole server; the three compose with the withhold", async () => {
      expect(keptBy((await toolsetsFor({}, { denylist: ["ggui.ggui_consume"] }))[0]!.toolFilter)).toEqual(["ggui_render", "ggui_handshake"]);
      expect(keptBy((await toolsetsFor({}, { denylist: ["ggui_consume"] }))[0]!.toolFilter)).toEqual(["ggui_render", "ggui_handshake"]);
      expect(keptBy((await toolsetsFor({}, { denylist: ["ggui.*"] }))[0]!.toolFilter)).toEqual([]);
      const composed = await toolsetsFor({ withheldTools: [{ server: "ggui", tool: "ggui_handshake" }] }, { allowlist: ["ggui.*"], denylist: ["ggui.ggui_consume"] });
      expect(keptBy(composed[0]!.toolFilter)).toEqual(["ggui_render"]);
    });
  });

  it("the named server's toolset gets a predicate that hides exactly the withheld tool", async () => {
    const built = await toolsetsFor({ gguiAttached: true, withheldTools: [{ server: "ggui", tool: "ggui_consume" }] });
    expect(built).toHaveLength(1);
    const filter = built[0]!.toolFilter;
    if (typeof filter !== "function") throw new Error(`expected a predicate, got ${typeof filter}`);
    expect(Reflect.apply(filter, undefined, [{ name: "ggui_consume", mcpTool: { name: "ggui_consume" } }])).toBe(false);
    expect(Reflect.apply(filter, undefined, [{ name: "ggui_render", mcpTool: { name: "ggui_render" } }])).toBe(true);
  });

  it("no withheld tools → the predicate keeps every tool the model may call (today's catalog)", async () => {
    const built = await toolsetsFor({ gguiAttached: true });
    expect(built.map((b) => b.url)).toEqual(["https://mcp.example/apps/x"]);
    expect(keptBy(built[0]!.toolFilter)).toEqual(["ggui_render", "ggui_consume", "ggui_handshake"]);
  });

  it("a withhold naming another server removes nothing from this toolset", async () => {
    const built = await toolsetsFor({ withheldTools: [{ server: "elsewhere", tool: "ggui_consume" }] });
    expect(keptBy(built[0]!.toolFilter)).toEqual(["ggui_render", "ggui_consume", "ggui_handshake"]);
  });
});

describe("an unreadable denylist entry is named on stderr (guuey#2585)", () => {
  const base = mkdtempSync(join(tmpdir(), "adk-gate-errors-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  isolateAdkKeys();

  it('{denylist:["mcp__x__y"]} writes one [guuey] line naming the entry', async () => {
    const session = join(base, "session");
    mkdirSync(join(session, ".guuey", "credentials"), { recursive: true });
    const fakeAdk = {
      LlmAgent: class {
        constructor(_: { name: string; model: string | object; instruction: string | (() => string); tools: unknown[] }) {}
      },
      Gemini: FakeGemini,
      LLMRegistry: fakeRegistry,
      BaseLlm: FakeBaseLlm,
      MCPToolset: class {
        constructor(_: unknown) {}
      },
      InMemoryRunner: class {
        readonly appName = "fake";
        readonly sessionService = {
          createSession: ({ userId }: { appName: string; userId: string }) => Promise.resolve({ id: `s-${userId}` }),
        };
        constructor(_: { agent: object }) {}
        async *runAsync(_: unknown): AsyncGenerator<JsonValue, void, undefined> {
          yield { content: { parts: [{ text: "ok" }] } };
        }
      },
    };
    const turn: HostTurn = {
      input: "hi",
      identity: { userId: "u-1", authMode: "anonymous" },
      fs: { app: base, home: base, session },
      history: [],
    };
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const { emit, got } = fakeEmitter();
    try {
      await createRunner({}, { load: () => Promise.resolve(fakeAdk) }).runTurn(
        { model: "gemini-3.5-pro", systemPrompt: "be terse", tools: { denylist: ["mcp__x__y"] } },
        turn,
        emit,
      );
    } finally {
      spy.mockRestore();
    }
    expect(got.error).toEqual([]);
    const gateLines = lines.filter((line) => line.startsWith("[guuey] tools."));
    expect(gateLines).toHaveLength(1);
    expect(gateLines[0]).toMatch(/^\[guuey\] tools\.denylist entry "mcp__x__y" cannot be read/);
  });
});
