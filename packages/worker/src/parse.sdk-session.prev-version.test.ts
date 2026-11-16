/**
 * N−1 across a rolling release for the hello's SDK thread-resume block `session` (guuey#3517, P4). The Router reads
 * the hello with this package's parser, and the Router and the worker image roll apart, so both directions are pinned:
 *
 * - NEW host → OLD Router: an older Router (the parser frozen in `fixtures/parse.pre-sdk-session.prev.ts`) reads a
 *   newer host's hello carrying `session` and `sdk-session.v1`: the hello parses, the block is dropped, the unknown
 *   capability is kept as an opaque name it never acts on, and every other field is intact.
 * - OLD host → NEW Router: the current parser reads today's JavaScript OpenAI and ADK host hellos (no block, no
 *   capability) exactly as the previous parser did, with no `session`.
 * - OLD host → NEW Router on a RESUME: only the PARSE half lives here (no block, no capability, so nothing a Router
 *   could read as a measure). The Router's abort-before-forwarding and re-run with history is the Router's and chat's
 *   half, pinned in their tests.
 */
import { describe, expect, it } from "vitest";
import { readEvent } from "./parse.js";
import { SDK_SESSION_CAPABILITY, SDK_SESSION_HASH_VERSION, type HelloSdkSession } from "./protocol.js";
import { parseControl as parseControlPrev, readEvent as readEventPrev } from "./fixtures/parse.pre-sdk-session.prev.js";

const SHA = "a".repeat(64);
const SESSION_ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const BLOCK: HelloSdkSession = {
  kind: "openai-agents",
  hashVersion: SDK_SESSION_HASH_VERSION,
  systemPromptSha256: SHA,
  headerShas: { model: SHA, tools: SHA, mcpConfig: SHA },
  promptSha: SHA,
  promptBytes: 42,
  lastPromptSha: SHA,
  stored: {
    fileSha256: "b".repeat(64),
    itemCount: 4,
    promptShas: [SHA],
    lastPromptShas: [SHA],
    sessionIds: [SESSION_ID],
    corrupt: 0,
    unclassified: 0,
    compactions: 0,
  },
};

// Today's JavaScript hosts' hellos, pinned literally (frameworks/openai.ts and frameworks/google-adk.ts at this
// change's base): neither runs `cliSession`, so neither sends the block or the capability.
const OLD_OPENAI_HELLO =
  '{"type":"hello","framework":"openai-agents-sdk","sdkName":"@openai/agents","sdkVersion":"0.3.1","capabilities":["input-kind:context-only"]}';
const OLD_ADK_HELLO =
  '{"type":"hello","framework":"google-adk","sdkName":"@google/adk","sdkVersion":"1.0.0","capabilities":["adk.host-completion","input-kind:context-only"]}';

const NEW_HELLO = {
  type: "hello",
  framework: "openai-agents-sdk",
  sdkName: "openai-agents",
  sdkVersion: "0.4.0",
  capabilities: ["input-kind:context-only", SDK_SESSION_CAPABILITY],
  session: BLOCK,
};

describe("NEW host -> OLD Router: the previous parser (frozen) × a hello with the SDK session block", () => {
  it("parses the hello, drops the block, keeps the capability as an opaque name and every other field", () => {
    const { session: _dropped, ...rest } = NEW_HELLO;
    expect(readEventPrev(JSON.stringify(NEW_HELLO))).toEqual(rest);
  });

  it("drops a start block (no stored) the same way", () => {
    const { stored: _none, ...start } = BLOCK;
    const { session: _dropped, ...rest } = NEW_HELLO;
    expect(readEventPrev(JSON.stringify({ ...NEW_HELLO, session: start }))).toEqual(rest);
  });

  it("the frozen copy still reads an invoke (it is the whole previous parser)", () => {
    const invoke = { type: "invoke", input: "hi", identity: { userId: "u1" }, fs: { app: "/a", home: "/h", session: "/s" } };
    expect(parseControlPrev(JSON.stringify(invoke))).toMatchObject({ type: "invoke", input: "hi" });
  });
});

describe("OLD host -> NEW Router: the current parser × today's JavaScript OpenAI and ADK hellos", () => {
  it.each([
    ["OpenAI", OLD_OPENAI_HELLO],
    ["ADK", OLD_ADK_HELLO],
  ])("reads the %s hello exactly as the previous parser did, with no session", (_label, line) => {
    const now = readEvent(line);
    expect(now).toEqual(readEventPrev(line));
    expect("session" in now).toBe(false);
  });
});

describe("OLD host -> NEW Router on a RESUME (parse half; the Router's abort-and-rerun is the Router's and chat's half)", () => {
  it.each([
    ["OpenAI", OLD_OPENAI_HELLO],
    ["ADK", OLD_ADK_HELLO],
  ])("today's %s hello yields no block and no sdk-session.v1 capability: nothing to read as a measure", (_label, line) => {
    const now = readEvent(line);
    expect("session" in now).toBe(false);
    expect(now.type === "hello" && (now.capabilities ?? []).includes(SDK_SESSION_CAPABILITY)).toBe(false);
  });

  it("a hello with neither cliSession nor session nor the capability yields no block either", () => {
    const now = readEvent(JSON.stringify({ type: "hello", framework: "google-adk", sdkName: "@google/adk", sdkVersion: null }));
    expect(now).toEqual({ type: "hello", framework: "google-adk", sdkName: "@google/adk", sdkVersion: null });
  });
});
