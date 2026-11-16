/**
 * The hello's SDK thread-resume block `session` (guuey#3517, P4), parsed once in `readEvent`'s hello case. The block
 * is kept WHOLE when every field is well formed and within bounds, and dropped WHOLE otherwise, never in part; the
 * rest of the hello is unaffected either way. Hardening's bounds (T-P4b), one RED each.
 */
import { describe, expect, it } from "vitest";
import { readEvent } from "./parse.js";
import {
  SDK_SESSION_CAPABILITY,
  SDK_SESSION_HASH_VERSION,
  SDK_SESSION_IDS_MAX,
  SDK_SESSION_PROMPT_SHAS_MAX,
  type HelloSdkSession,
  type HelloSdkStored,
} from "./protocol.js";

const SHA = "a".repeat(64);
const SESSION_ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const STORED: HelloSdkStored = {
  fileSha256: "b".repeat(64),
  itemCount: 6,
  promptShas: [SHA, "c".repeat(64)],
  lastPromptShas: [SHA, "d".repeat(64)],
  sessionIds: [SESSION_ID],
  corrupt: 0,
  unclassified: 0,
  compactions: 0,
};
const BLOCK: HelloSdkSession = {
  kind: "google-adk",
  hashVersion: SDK_SESSION_HASH_VERSION,
  systemPromptSha256: SHA,
  headerShas: { model: SHA, tools: SHA, mcpConfig: SHA },
  promptSha: SHA,
  promptBytes: 120,
  lastPromptSha: SHA,
  stored: STORED,
};
const { stored: _stored, ...START_BLOCK } = BLOCK;
const HELLO = {
  type: "hello",
  framework: "google-adk",
  sdkName: "google-adk",
  sdkVersion: "1.2.0",
  capabilities: ["adk.host-completion", SDK_SESSION_CAPABILITY],
};

const helloLine = (session: object | string | number | null): string => JSON.stringify({ ...HELLO, session });
const shas = (n: number): string[] => Array.from({ length: n }, (_v, i) => i.toString(16).padStart(64, "0"));
const ids = (n: number): string[] => Array.from({ length: n }, (_v, i) => `6f9619ff-8b86-4011-b42d-${i.toString(16).padStart(12, "0")}`);

/** The block survived whole. */
function expectKept(line: string, block: object): void {
  expect(readEvent(line)).toEqual({ ...HELLO, session: block });
}
/** The block was dropped whole and the rest of the hello read as if it never came. */
function expectDropped(line: string): void {
  const parsed = readEvent(line);
  expect(parsed).toEqual(HELLO);
  expect("session" in parsed).toBe(false);
}

describe("the SDK session block: well formed", () => {
  it("keeps a full resume block, key order as written by the parser", () => {
    const line = helloLine(BLOCK);
    expectKept(line, BLOCK);
    expect(JSON.stringify(readEvent(line))).toBe(JSON.stringify({ ...HELLO, session: BLOCK }));
  });

  it("keeps a start block (no stored)", () => {
    expectKept(helloLine(START_BLOCK), START_BLOCK);
  });

  it("keeps an openai-agents block", () => {
    expectKept(helloLine({ ...BLOCK, kind: "openai-agents" }), { ...BLOCK, kind: "openai-agents" });
  });

  it.each(["missing", "not-regular", "link", "side-file"] as const)("keeps a stored readError %s", (readError) => {
    const stored: HelloSdkStored = { ...STORED, readError, promptShas: [], lastPromptShas: [], sessionIds: [], itemCount: 0 };
    expectKept(helloLine({ ...BLOCK, stored }), { ...BLOCK, stored });
  });

  it("drops unknown members, keeps the block", () => {
    expectKept(helloLine({ extra: 1, ...BLOCK, stored: { ...STORED, extra: true } }), BLOCK);
  });

  it("keeps an upper-case UUID session id (the invoke's id grammar is case-insensitive)", () => {
    const stored = { ...STORED, sessionIds: [SESSION_ID.toUpperCase()] };
    expectKept(helloLine({ ...BLOCK, stored }), { ...BLOCK, stored });
  });

  it("reads counts written 2.0 as integers", () => {
    const line = helloLine(BLOCK).replace('"promptBytes":120', '"promptBytes":120.0').replace('"hashVersion":1', '"hashVersion":1.0');
    expectKept(line, BLOCK);
  });

  it("has no block when the hello carries none", () => {
    expect("session" in readEvent(JSON.stringify(HELLO))).toBe(false);
  });
});

describe("the SDK session block: the caps at their edges", () => {
  it(`keeps ${SDK_SESSION_PROMPT_SHAS_MAX} promptShas and lastPromptShas`, () => {
    const stored = { ...STORED, promptShas: shas(SDK_SESSION_PROMPT_SHAS_MAX), lastPromptShas: shas(SDK_SESSION_PROMPT_SHAS_MAX) };
    expectKept(helloLine({ ...BLOCK, stored }), { ...BLOCK, stored });
  });

  it(`RED: drops the block on ${SDK_SESSION_PROMPT_SHAS_MAX + 1} promptShas`, () => {
    expectDropped(helloLine({ ...BLOCK, stored: { ...STORED, promptShas: shas(SDK_SESSION_PROMPT_SHAS_MAX + 1) } }));
  });

  it(`RED: drops the block on ${SDK_SESSION_PROMPT_SHAS_MAX + 1} lastPromptShas`, () => {
    expectDropped(helloLine({ ...BLOCK, stored: { ...STORED, lastPromptShas: shas(SDK_SESSION_PROMPT_SHAS_MAX + 1) } }));
  });

  it(`keeps ${SDK_SESSION_IDS_MAX} sessionIds`, () => {
    const stored = { ...STORED, sessionIds: ids(SDK_SESSION_IDS_MAX) };
    expectKept(helloLine({ ...BLOCK, stored }), { ...BLOCK, stored });
  });

  it(`RED: drops the block on ${SDK_SESSION_IDS_MAX + 1} sessionIds`, () => {
    expectDropped(helloLine({ ...BLOCK, stored: { ...STORED, sessionIds: ids(SDK_SESSION_IDS_MAX + 1) } }));
  });
});

describe("the SDK session block: every bound breach drops the WHOLE block (RED)", () => {
  const BAD_SHAS: readonly (readonly [string, string])[] = [
    ["upper-case", "A".repeat(64)],
    ["63 characters", "a".repeat(63)],
    ["65 characters", "a".repeat(65)],
    ["a trailing newline", "a".repeat(64) + "\n"],
    ["a non-hex letter", "g".repeat(64)],
  ];

  describe.each(BAD_SHAS)("a sha with %s", (_label, bad) => {
    it.each([
      ["systemPromptSha256", { ...BLOCK, systemPromptSha256: bad }],
      ["headerShas.model", { ...BLOCK, headerShas: { ...BLOCK.headerShas, model: bad } }],
      ["headerShas.tools", { ...BLOCK, headerShas: { ...BLOCK.headerShas, tools: bad } }],
      ["headerShas.mcpConfig", { ...BLOCK, headerShas: { ...BLOCK.headerShas, mcpConfig: bad } }],
      ["promptSha", { ...BLOCK, promptSha: bad }],
      ["lastPromptSha", { ...BLOCK, lastPromptSha: bad }],
      ["stored.fileSha256", { ...BLOCK, stored: { ...STORED, fileSha256: bad } }],
      ["a stored.promptShas entry", { ...BLOCK, stored: { ...STORED, promptShas: [SHA, bad] } }],
      ["a stored.lastPromptShas entry", { ...BLOCK, stored: { ...STORED, lastPromptShas: [bad] } }],
    ])("RED: in %s", (_field, block) => {
      expectDropped(helloLine(block));
    });
  });

  const BAD_COUNTS: readonly (readonly [string, number | string | boolean | null])[] = [
    ["negative", -1],
    ["fractional", 0.5],
    ["a string", "1"],
    ["a boolean", true],
    ["null", null],
  ];

  describe.each(BAD_COUNTS)("a count that is %s", (_label, bad) => {
    it.each([
      ["promptBytes", { ...BLOCK, promptBytes: bad }],
      ["stored.itemCount", { ...BLOCK, stored: { ...STORED, itemCount: bad } }],
      ["stored.corrupt", { ...BLOCK, stored: { ...STORED, corrupt: bad } }],
      ["stored.unclassified", { ...BLOCK, stored: { ...STORED, unclassified: bad } }],
      ["stored.compactions", { ...BLOCK, stored: { ...STORED, compactions: bad } }],
    ])("RED: in %s", (_field, block) => {
      expectDropped(helloLine(block));
    });
  });

  it("RED: a count that is not finite (1e400 reads as Infinity)", () => {
    expectDropped(helloLine(BLOCK).replace('"promptBytes":120', '"promptBytes":1e400'));
  });

  it.each([
    ["0", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "1"],
  ])("RED: a hashVersion that is %s", (_label, hashVersion) => {
    expectDropped(helloLine({ ...BLOCK, hashVersion }));
  });

  it.each([
    ["claude", "claude"],
    ["the framework's spelling", "openai-agents-sdk"],
    ["upper-case", "OPENAI-AGENTS"],
    ["null", null],
  ])("RED: a kind that is %s", (_label, kind) => {
    expectDropped(helloLine({ ...BLOCK, kind }));
  });

  it("RED: a missing kind", () => {
    const { kind: _kind, ...noKind } = BLOCK;
    expectDropped(helloLine(noKind));
  });

  it.each([
    ["not a UUID", "not-a-uuid"],
    ["a UUID with braces", `{${SESSION_ID}}`],
    ["a UUID with a trailing newline", `${SESSION_ID}\n`],
    ["empty", ""],
    ["a number", 7],
  ])("RED: a session id that is %s", (_label, id) => {
    expectDropped(helloLine({ ...BLOCK, stored: { ...STORED, sessionIds: [SESSION_ID, id] } }));
  });
});

describe("the SDK session block: a malformed shape drops the WHOLE block", () => {
  it.each([
    ["an unknown readError", { ...BLOCK, stored: { ...STORED, readError: "gone" } }],
    ["a null readError", { ...BLOCK, stored: { ...STORED, readError: null } }],
    ["a null stored", { ...BLOCK, stored: null }],
    ["a stored array", { ...BLOCK, stored: [] }],
    ["a missing fileSha256", { ...BLOCK, stored: { ...STORED, fileSha256: undefined } }],
    ["a missing sessionIds", { ...BLOCK, stored: { ...STORED, sessionIds: undefined } }],
    ["a non-array promptShas", { ...BLOCK, stored: { ...STORED, promptShas: SHA } }],
    ["a missing compactions", { ...BLOCK, stored: { ...STORED, compactions: undefined } }],
    ["a missing header sha", { ...BLOCK, headerShas: { model: SHA, tools: SHA } }],
    ["a null headerShas", { ...BLOCK, headerShas: null }],
  ])("RED: %s", (_label, block) => {
    expectDropped(helloLine(block));
  });

  it.each([
    ["a string", "session"],
    ["a number", 1],
    ["null", null],
  ])("reads a session that is %s as none", (_label, session) => {
    expectDropped(helloLine(session));
  });

  it("drops a malformed SDK block and a malformed cliSession each on its own, keeping the rest of the hello", () => {
    const parsed = readEvent(JSON.stringify({ ...HELLO, session: { ...BLOCK, kind: "x" }, cliSession: "not a block" }));
    expect(parsed).toEqual(HELLO);
  });
});
