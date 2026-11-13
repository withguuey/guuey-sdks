/**
 * N−1 across a rolling release for thread resume (guuey#3407 B3, R8):
 *
 * - An OLDER worker (its parser frozen in `fixtures/parse.pre-cli-session.prev.ts`) reads a NEWER Router's invoke that
 *   carries `cliSession`: the field is dropped and the turn is today's.
 * - An OLDER Router (the same frozen parser) reads a NEWER host's hello that carries the thread-resume block: the hello
 *   reads as before, capabilities included, without the block.
 * - The current parser reads both older shapes exactly as the previous one did, keeps the new fields when well formed,
 *   and drops a malformed one: the invoke's field alone, the hello's block whole.
 */
import { describe, expect, it } from "vitest";
import { createEmitter } from "./emit.js";
import { parseControl, readEvent } from "./parse.js";
import { CLI_SESSION_CAPABILITY, CLI_SESSION_HASH_VERSION, type HelloCliSession } from "./protocol.js";
import { parseControl as parseControlPrev, parseEvent as parseEventPrev } from "./fixtures/parse.pre-cli-session.prev.js";

const OLD_INVOKE = {
  type: "invoke",
  input: "hello",
  identity: { userId: "u1", authMode: "authenticated" },
  fs: { app: "/app", home: "/home", session: "/session" },
  fsBound: true,
  history: [{ role: "user", text: "earlier" }],
  threadId: "0b5c3f1e-8d2a-4c7b-9e1f-3a4b5c6d7e8f",
};
const SESSION_ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const NEW_INVOKE = { ...OLD_INVOKE, cliSession: { mode: "resume", id: SESSION_ID } };

const SHA = "a".repeat(64);
const BLOCK: HelloCliSession = {
  hashVersion: CLI_SESSION_HASH_VERSION,
  systemPromptSha256: SHA,
  headerShas: { model: SHA, permissionMode: SHA, tools: SHA, mcpConfig: SHA },
  promptSha: SHA,
  promptBytes: 120,
  lastPromptSha: SHA,
  stored: {
    systemPromptShas: [SHA, SHA],
    walks: [{ fromLastPromptLeaf: true, promptShas: [SHA, SHA], compactSummaries: 0, boundary: "none" }],
    lastPromptShas: [SHA, SHA],
    entries: ["x.jsonl"],
    unclassified: 0,
    corrupt: 0,
    benignDuplicates: 0,
    filePromptEntries: 2,
    fileCompactSummaries: 0,
  },
};
const OLD_HELLO = { type: "hello", framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk", sdkVersion: "0.3.282", capabilities: ["tool-gates.v1"] };
const NEW_HELLO = { ...OLD_HELLO, capabilities: ["tool-gates.v1", CLI_SESSION_CAPABILITY], cliSession: BLOCK };

describe("the previous worker's parser (frozen) × a new Router's invoke with cliSession", () => {
  it("reads it and drops cliSession: today's turn", () => {
    const fromNew = parseControlPrev(JSON.stringify(NEW_INVOKE));
    expect(fromNew).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
    expect("cliSession" in fromNew).toBe(false);
  });
});

describe("the previous Router's parser (frozen) × a new host's hello with the thread-resume block", () => {
  it("reads the hello as before, capabilities included, without the block", () => {
    const fromNew = parseEventPrev(JSON.stringify(NEW_HELLO));
    expect(fromNew).toEqual({ ...OLD_HELLO, capabilities: ["tool-gates.v1", CLI_SESSION_CAPABILITY] });
    expect("cliSession" in fromNew).toBe(false);
  });
});

describe("the current parser × the older shapes", () => {
  it("reads an old Router's invoke exactly as the previous parser did", () => {
    expect(parseControl(JSON.stringify(OLD_INVOKE))).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
  });
  it("reads an old host's hello exactly as the previous parser did", () => {
    expect(readEvent(JSON.stringify(OLD_HELLO))).toEqual(parseEventPrev(JSON.stringify(OLD_HELLO)));
  });
});

describe("the current parser × the new invoke field", () => {
  it.each(["start", "resume"] as const)("keeps a well-formed %s, and differs from the previous parser only by it", (mode) => {
    const line = JSON.stringify({ ...OLD_INVOKE, cliSession: { mode, id: SESSION_ID } });
    expect(parseControl(line)).toEqual({ ...parseControlPrev(line), cliSession: { mode, id: SESSION_ID } });
  });

  it.each([
    ["an unknown mode", { mode: "fork", id: SESSION_ID }],
    ["an empty id", { mode: "resume", id: "" }],
    ["a missing id", { mode: "start" }],
    ["a string", "resume"],
    ["null", null],
  ])("drops a malformed cliSession (%s) without throwing: today's turn", (_label, cliSession) => {
    const now = parseControl(JSON.stringify({ ...OLD_INVOKE, cliSession }));
    expect(now).toEqual(parseControl(JSON.stringify(OLD_INVOKE)));
    expect("cliSession" in now).toBe(false);
  });

  it("keeps a non-UUID id: the host names that refusal itself (R5)", () => {
    const now = parseControl(JSON.stringify({ ...OLD_INVOKE, cliSession: { mode: "start", id: "not-a-uuid" } }));
    expect(now).toMatchObject({ cliSession: { mode: "start", id: "not-a-uuid" } });
  });
});

describe("the current parser × the hello's thread-resume block", () => {
  it("keeps a well-formed block whole, with and without stored measures", () => {
    expect(readEvent(JSON.stringify(NEW_HELLO))).toEqual(NEW_HELLO);
    const { stored: _stored, ...startBlock } = BLOCK;
    const start = { ...NEW_HELLO, cliSession: startBlock };
    expect(readEvent(JSON.stringify(start))).toEqual(start);
  });

  it("keeps a readError with the other measures empty", () => {
    const readError = { ...NEW_HELLO, cliSession: { ...BLOCK, stored: { ...BLOCK.stored, readError: "missing", systemPromptShas: [], walks: [], lastPromptShas: [], entries: [], filePromptEntries: 0 } } };
    expect(readEvent(JSON.stringify(readError))).toEqual(readError);
  });

  it.each([
    ["a negative promptBytes", { promptBytes: -1 }],
    ["a missing header sha", { headerShas: { model: SHA, permissionMode: SHA, tools: SHA } }],
    ["a string hashVersion", { hashVersion: "1" }],
    ["an unknown readError", { stored: { ...BLOCK.stored, readError: "gone" } }],
    ["a walk with an unknown boundary", { stored: { ...BLOCK.stored, walks: [{ fromLastPromptLeaf: true, promptShas: [], compactSummaries: 0, boundary: "maybe" }] } }],
    ["a fractional count", { stored: { ...BLOCK.stored, unclassified: 0.5 } }],
    ["a non-string entry", { stored: { ...BLOCK.stored, entries: [1] } }],
    // runtime's C-2 (withdrawn for this): a stored block missing a wire-v1.2 count never reaches a compare as 0.
    ["a stored block missing benignDuplicates", { stored: { ...BLOCK.stored, benignDuplicates: undefined } }],
    ["a stored block missing corrupt (wire v1.3)", { stored: { ...BLOCK.stored, corrupt: undefined } }],
  ])("drops the WHOLE block on %s, keeping the rest of the hello", (_label, patch) => {
    const hello = { ...NEW_HELLO, cliSession: { ...BLOCK, ...patch } };
    const now = readEvent(JSON.stringify(hello));
    expect(now).toEqual({ ...OLD_HELLO, capabilities: ["tool-gates.v1", CLI_SESSION_CAPABILITY] });
    expect("cliSession" in now).toBe(false);
  });
});

describe("the emitter writes the block the parser reads back", () => {
  it("round-trips a hello with the thread-resume block", () => {
    const lines: string[] = [];
    createEmitter({ write: (s) => lines.push(s) }).hello(
      NEW_HELLO.framework,
      NEW_HELLO.sdkName,
      NEW_HELLO.sdkVersion,
      NEW_HELLO.capabilities,
      BLOCK,
    );
    expect(lines).toHaveLength(1);
    expect(readEvent(lines[0].trimEnd())).toEqual(NEW_HELLO);
  });

  it("writes no block when none is given: today's hello", () => {
    const lines: string[] = [];
    createEmitter({ write: (s) => lines.push(s) }).hello(OLD_HELLO.framework, OLD_HELLO.sdkName, OLD_HELLO.sdkVersion, OLD_HELLO.capabilities);
    expect(JSON.parse(lines[0])).toEqual(OLD_HELLO);
  });
});
