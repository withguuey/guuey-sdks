/**
 * The turn's images (`Invoke.attachments`) on every framework run path: each
 * hands them to its model beside the text (Claude image blocks, OpenAI
 * `input_image` parts, ADK `inlineData` parts), and each hello announces
 * `invoke.images.v1` exactly when the invoke carried images. A turn without
 * images keeps the prompt and the hello it always had.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const noMessages: SDKMessage[] = [];
import type { RunStreamEvent } from "@openai/agents";
import {
  ADK_HOST_COMPLETION_CAPABILITY,
  INVOKE_IMAGES_CAPABILITY,
  createEmitter,
  type InvokeImageAttachment,
  type JsonValue,
  type WorkerEvent,
} from "@guuey/worker";
import type { HostTurn } from "../index.js";
import { runInvoke, type HostInvoke, type QueryFn } from "./claude.js";
import { runInvokeOpenai, type OpenaiRunFn, type OpenaiRunResult } from "./openai.js";
import { runAdkTurn } from "./google-adk.js";
import {
  CONTEXT_ONLY_TURN_TEXT,
  MODEL_TEXT_INPUT_KIND_CAPABILITIES,
  TURN_IMAGES_FACES,
  anthropicUserContent,
  attachmentFileName,
  geminiUserParts,
  openaiTurnInput,
} from "@guuey/worker";

const PNG: InvokeImageAttachment = {
  kind: "inline",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
};
const JPEG: InvokeImageAttachment = { kind: "inline", mimeType: "image/jpeg", data: "/9j/4AAQ" };
/** A1: every turn's message leads with its (here empty) context block; the images and the text follow unchanged. */
const EMPTY_TURN_CONTEXT = "<turn_context></turn_context>";

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

// A real session directory: an image turn stores its images there before it runs.
const SESSION = mkdtempSync(join(tmpdir(), "host-images-session-"));
afterAll(() => rmSync(SESSION, { recursive: true, force: true }));

function turn(over: Partial<HostInvoke> = {}): HostInvoke {
  return {
    input: "Make flashcards from this page.",
    identity: { userId: "u1", authMode: "anonymous" },
    fs: { app: "/fs/app", home: "/fs/home", session: SESSION },
    history: [],
    ...over,
  };
}

function helloOf(events: WorkerEvent[]): WorkerEvent | undefined {
  return events.find((e) => e.type === "hello");
}

/** Run one Claude turn on a fake query and return the user message it sent plus the emitted events. */
async function claudeTurn(over: Partial<HostInvoke>): Promise<{ sent: SDKUserMessage | undefined; events: WorkerEvent[] }> {
  const { events, sink } = collector();
  let sent: SDKUserMessage | undefined;
  const query: QueryFn = (args) => ({
    setMcpServers: () => Promise.resolve({ added: [], removed: [], errors: {} }),
    mcpServerStatus: () => Promise.resolve([]),
    close: () => undefined,
    async *[Symbol.asyncIterator]() {
      // The loop reads the one user message, then ends without a result (the turn ends on `done`).
      for await (const message of args.prompt) {
        sent = message;
        break;
      }
      yield* noMessages;
    },
  });
  await runInvoke({}, turn(over), { apiKey: "sk-test", listCredentials: () => [] }, createEmitter(sink), query);
  return { sent, events };
}

describe("Claude: the images reach the model as image blocks before the text", () => {
  it("sends each image as a base64 image block, in order, then the text; the hello announces invoke.images.v1", async () => {
    const { sent, events } = await claudeTurn({ attachments: [PNG, JPEG] });
    expect(sent?.message.content).toEqual([
      { type: "text", text: EMPTY_TURN_CONTEXT },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.data } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.data } },
      { type: "text", text: "Make flashcards from this page." },
    ]);
    expect(helloOf(events)).toMatchObject({ type: "hello", capabilities: [...MODEL_TEXT_INPUT_KIND_CAPABILITIES, INVOKE_IMAGES_CAPABILITY] });
  });

  it("without images: the turn context, then the one text block, and a hello with only the input kinds it always declared", async () => {
    const { sent, events } = await claudeTurn({});
    expect(sent?.message.content).toEqual([
      { type: "text", text: EMPTY_TURN_CONTEXT },
      { type: "text", text: "Make flashcards from this page." },
    ]);
    expect(helloOf(events)).toMatchObject({ capabilities: [...MODEL_TEXT_INPUT_KIND_CAPABILITIES] });
  });

  it("stores each image in the turn's session storage under attachmentFileName, before the model runs", async () => {
    await claudeTurn({ attachments: [PNG, JPEG] });
    for (const image of [PNG, JPEG]) {
      const file = join(SESSION, attachmentFileName(image));
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file).equals(Buffer.from(image.data, "base64"))).toBe(true);
    }
  });

  it("a refused store is the person's face, and the model is never sent the turn", async () => {
    const { sent, events } = await claudeTurn({ attachments: [PNG], fs: { app: "/fs/app", home: "/fs/home", session: join(SESSION, "missing", "dir") } });
    expect(sent).toBeUndefined();
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", message: TURN_IMAGES_FACES.write_failed }]);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("anthropicUserContent is the text block alone for an empty list", () => {
    expect(anthropicUserContent({ input: "hi", attachments: [] })).toEqual([{ type: "text", text: "hi" }]);
  });
});

function fakeResult(): OpenaiRunResult {
  const events: RunStreamEvent[] = [];
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
    get completed(): Promise<void> {
      return Promise.resolve();
    },
    finalOutput: "ok",
  };
}

async function openaiTurn(over: Partial<HostInvoke>): Promise<{ input: Parameters<OpenaiRunFn>[1] | undefined; events: WorkerEvent[] }> {
  const { events, sink } = collector();
  let input: Parameters<OpenaiRunFn>[1] | undefined;
  const run: OpenaiRunFn = (_agent, sentInput) => {
    input = sentInput;
    return Promise.resolve(fakeResult());
  };
  await runInvokeOpenai(
    { framework: "openai-agents-sdk", model: "gpt-4o-mini", mcpServers: {} },
    turn(over),
    { apiKey: "sk-openai-test", listCredentials: () => [] },
    createEmitter(sink),
    run,
  );
  return { input, events };
}

describe("OpenAI: the images reach the model as input_image parts before the text", () => {
  it("sends one user message of data-URL input_image parts, in order, then input_text; the hello announces invoke.images.v1", async () => {
    const { input, events } = await openaiTurn({ attachments: [PNG, JPEG] });
    expect(input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: EMPTY_TURN_CONTEXT },
          { type: "input_image", image: `data:image/png;base64,${PNG.data}` },
          { type: "input_image", image: `data:image/jpeg;base64,${JPEG.data}` },
          { type: "input_text", text: "Make flashcards from this page." },
        ],
      },
    ]);
    expect(helloOf(events)).toMatchObject({ type: "hello", capabilities: [...MODEL_TEXT_INPUT_KIND_CAPABILITIES, INVOKE_IMAGES_CAPABILITY] });
  });

  it("without images: the input string after the turn context, and a hello with only the input kinds it always declared", async () => {
    const { input, events } = await openaiTurn({});
    expect(input).toBe(`${EMPTY_TURN_CONTEXT}\n\nMake flashcards from this page.`);
    expect(helloOf(events)).toMatchObject({ capabilities: [...MODEL_TEXT_INPUT_KIND_CAPABILITIES] });
    expect(openaiTurnInput({ input: "hi", attachments: [] })).toBe("hi");
  });
});

function fakeAdk(capture: { newMessage?: JsonValue }) {
  return {
    InMemoryRunner: class {
      readonly appName = "fake-app";
      readonly sessionService = {
        createSession: (req: { appName: string; userId: string }) => Promise.resolve({ id: `sess-${req.userId}` }),
      };
      constructor(public readonly params: { agent: object }) {}
      async *runAsync(params: { newMessage: { role: "user"; parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> } }): AsyncGenerator<JsonValue, void, undefined> {
        capture.newMessage = params.newMessage;
        yield* [];
      }
    },
  };
}

async function adkTurn(over: Partial<HostTurn>): Promise<{ newMessage: JsonValue | undefined; events: WorkerEvent[] }> {
  const { events, sink } = collector();
  const capture: { newMessage?: JsonValue } = {};
  await runAdkTurn(fakeAdk(capture), {}, turn(over), [EMPTY_TURN_CONTEXT], createEmitter(sink), "2.1.0");
  return { newMessage: capture.newMessage, events };
}

describe("ADK: the images reach the model as inlineData parts before the text", () => {
  it("sends an inlineData part per image, in order, then the text part; the hello adds invoke.images.v1 to host completion", async () => {
    const { newMessage, events } = await adkTurn({ attachments: [PNG, JPEG] });
    expect(newMessage).toEqual({
      role: "user",
      parts: [
        { text: EMPTY_TURN_CONTEXT },
        { inlineData: { mimeType: "image/png", data: PNG.data } },
        { inlineData: { mimeType: "image/jpeg", data: JPEG.data } },
        { text: "Make flashcards from this page." },
      ],
    });
    expect(helloOf(events)).toMatchObject({
      capabilities: [ADK_HOST_COMPLETION_CAPABILITY, ...MODEL_TEXT_INPUT_KIND_CAPABILITIES, INVOKE_IMAGES_CAPABILITY],
    });
  });

  it("without images: the one text part, and host completion with the input kinds on the hello", async () => {
    const { newMessage, events } = await adkTurn({});
    expect(newMessage).toEqual({ role: "user", parts: [{ text: EMPTY_TURN_CONTEXT }, { text: "Make flashcards from this page." }] });
    expect(helloOf(events)).toMatchObject({ capabilities: [ADK_HOST_COMPLETION_CAPABILITY, ...MODEL_TEXT_INPUT_KIND_CAPABILITIES] });
    expect(geminiUserParts({ input: "hi", attachments: [] })).toEqual([{ text: "hi" }]);
  });
});

describe("an image turn's text is the model text (guuey#2549 beside guuey#2293)", () => {
  it("a context-only turn with images reads the fixed sentence after its images, on every framework", () => {
    const turn = { input: "", inputKind: "context-only" as const, attachments: [PNG] };
    expect(anthropicUserContent(turn).at(-1)).toEqual({ type: "text", text: CONTEXT_ONLY_TURN_TEXT });
    expect(geminiUserParts(turn).at(-1)).toEqual({ text: CONTEXT_ONLY_TURN_TEXT });
    const openai = openaiTurnInput(turn);
    expect(Array.isArray(openai) ? openai[0] : openai).toMatchObject({
      content: [{ type: "input_image" }, { type: "input_text", text: CONTEXT_ONLY_TURN_TEXT }],
    });
  });
});
