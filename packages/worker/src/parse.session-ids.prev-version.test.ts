/**
 * N−1 across a rolling release for the stored session's `sessionIds` (guuey#3407 6a, cto D1). The Router reads the
 * hello with this package's parser, and the Router and the worker image roll apart, so both directions are pinned:
 *
 * - An OLDER Router (the parser frozen in `fixtures/parse.pre-session-ids.prev.ts`) reads a NEWER host's hello that
 *   carries `sessionIds`: the block is kept, without the new field.
 * - The current parser reads an OLDER host's block (no `sessionIds`) exactly as before: the field stays optional, so a
 *   good older block is never turned into a host fault. A present but malformed `sessionIds` drops the block whole.
 */
import { describe, expect, it } from "vitest";
import { parseControl, parseEvent } from "./parse.js";
import { CLI_SESSION_CAPABILITY, CLI_SESSION_HASH_VERSION, type HelloCliSession, type HelloStoredMeasures } from "./protocol.js";
import { parseControl as parseControlPrev, parseEvent as parseEventPrev } from "./fixtures/parse.pre-session-ids.prev.js";

const SHA = "a".repeat(64);
const SESSION_ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const OLD_STORED: HelloStoredMeasures = {
  systemPromptShas: [SHA],
  walks: [{ fromLastPromptLeaf: true, promptShas: [SHA], compactSummaries: 0, boundary: "none" }],
  lastPromptShas: [SHA],
  entries: [`${SESSION_ID}.jsonl`],
  unclassified: 0,
  corrupt: 0,
  benignDuplicates: 0,
  filePromptEntries: 1,
  fileCompactSummaries: 0,
};
const OLD_BLOCK: HelloCliSession = {
  hashVersion: CLI_SESSION_HASH_VERSION,
  systemPromptSha256: SHA,
  headerShas: { model: SHA, permissionMode: SHA, tools: SHA, mcpConfig: SHA },
  promptSha: SHA,
  promptBytes: 120,
  lastPromptSha: SHA,
  stored: OLD_STORED,
};
const NEW_BLOCK: HelloCliSession = { ...OLD_BLOCK, stored: { ...OLD_STORED, sessionIds: [SESSION_ID] } };
const HELLO = { type: "hello", framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk", sdkVersion: "0.3.282", capabilities: [CLI_SESSION_CAPABILITY] };

describe("the previous Router's parser (frozen) × a new host's stored sessionIds", () => {
  it("keeps the block and drops only the new field", () => {
    const fromNew = parseEventPrev(JSON.stringify({ ...HELLO, cliSession: NEW_BLOCK }));
    expect(fromNew).toEqual({ ...HELLO, cliSession: OLD_BLOCK });
  });
});

describe("the current parser × stored sessionIds", () => {
  it("keeps sessionIds when well formed", () => {
    const hello = { ...HELLO, cliSession: NEW_BLOCK };
    expect(parseEvent(JSON.stringify(hello))).toEqual(hello);
  });

  it("reads an older host's block without sessionIds exactly as the previous parser did", () => {
    const hello = JSON.stringify({ ...HELLO, cliSession: OLD_BLOCK });
    expect(parseEvent(hello)).toEqual(parseEventPrev(hello));
    expect(parseEvent(hello)).toEqual({ ...HELLO, cliSession: OLD_BLOCK });
  });

  it.each([
    ["a non-string id", [1]],
    ["a non-array", SESSION_ID],
  ])("drops the WHOLE block on %s, keeping the rest of the hello", (_label, sessionIds) => {
    const hello = { ...HELLO, cliSession: { ...OLD_BLOCK, stored: { ...OLD_STORED, sessionIds } } };
    const now = parseEvent(JSON.stringify(hello));
    expect(now).toEqual(HELLO);
  });
});

// The invoke's side of the same change: cliSession.expectLastPromptSha, the platform's record a host checks before it
// starts the CLI on a resume (guuey#3407 6a, F1, the lead's ruling (B) plus the Router hold).
const INVOKE = {
  type: "invoke",
  input: "hello",
  identity: { userId: "u1", authMode: "authenticated" },
  fs: { app: "/app", home: "/home", session: "/session" },
  history: [],
};
const EXPECT = "e".repeat(64);

describe("the previous worker's parser (frozen) × a new Router's cliSession with expectLastPromptSha", () => {
  it("keeps the resume and drops only the new field: no host check, as before", () => {
    const fromNew = parseControlPrev(JSON.stringify({ ...INVOKE, cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha: EXPECT } }));
    expect(fromNew).toMatchObject({ cliSession: { mode: "resume", id: SESSION_ID } });
    expect(JSON.stringify(fromNew)).not.toContain("expectLastPromptSha");
  });
});

describe("the current parser × cliSession.expectLastPromptSha", () => {
  it("keeps a 64-hex record, and reads an older Router's cliSession without it as before", () => {
    const withRecord = { ...INVOKE, cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha: EXPECT } };
    expect(parseControl(JSON.stringify(withRecord))).toMatchObject({ cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha: EXPECT } });
    const older = JSON.stringify({ ...INVOKE, cliSession: { mode: "resume", id: SESSION_ID } });
    expect(parseControl(older)).toEqual(parseControlPrev(older));
  });

  it.each([
    ["upper-case hex", "E".repeat(64)],
    ["too short", "e".repeat(63)],
    ["not a string", 7],
  ])("drops the whole cliSession on a record that is %s: no resume, never an unchecked one", (_label, expectLastPromptSha) => {
    const parsed = parseControl(JSON.stringify({ ...INVOKE, cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha } }));
    expect("cliSession" in parsed).toBe(false);
  });
});
