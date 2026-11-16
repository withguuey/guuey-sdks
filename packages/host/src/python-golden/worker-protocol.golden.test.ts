/**
 * The golden corpus the Python port of the worker line protocol is held to (guuey#3494, leg P1).
 *
 * Every case runs through the JavaScript implementation, `@guuey/worker` (and `lines` from this package's own
 * `stdin-lines.ts`, the same reader as the worker's `lines.ts`, which the worker does not export), and the results
 * are written as JSON under `../python/golden/worker-protocol/`. The Python tests (`../python/tests/test_protocol.py`)
 * read every file there and require the Python port to give the same answer: the same serialized bytes for anything
 * it writes or returns, the same error name and message for anything it refuses.
 *
 * A diff in those files is a wire change the Python port must follow. Rewrite them with `vitest run -u`.
 */
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  ADK_HOST_COMPLETION_CAPABILITY,
  CLIENT_CATALOGS_MAX,
  CLIENT_CATALOG_ID_MAX_CHARS,
  CLIENT_CATALOG_ID_PATTERN,
  CLI_SESSION_CAPABILITY,
  CLI_SESSION_HASH_VERSION,
  CLI_SESSION_RESUME_FAILED,
  CONTEXT_ONLY_TURN_TEXT,
  END_THREAD_CODE_PATTERN,
  END_THREAD_MESSAGE_MAX_CHARS,
  HOST_SUSPEND_CAPABILITY,
  INPUT_KINDS,
  INVOKE_IMAGES_CAPABILITY,
  INVOKE_IMAGE_MIME_TYPES,
  LAUNCH_ENVELOPE_DEADLINE_MS,
  LAUNCH_ENVELOPE_FD,
  LAUNCH_ENVELOPE_FD_ENV,
  LAUNCH_ENVELOPE_MAX_BYTES,
  LAUNCH_ENVELOPE_VERSION,
  MODEL_TEXT_INPUT_KIND_CAPABILITIES,
  PROTOCOL_VERSION,
  SDK_SESSION_CAPABILITY,
  SDK_SESSION_HASH_VERSION,
  SDK_SESSION_IDS_MAX,
  SDK_SESSION_PROMPT_SHAS_MAX,
  SUSPEND_ENVELOPE_MAX_BYTES,
  TOOL_GATES_CAPABILITY,
  compareStoredSession,
  createEmitter,
  createSuspendWriter,
  encodeLaunchEnvelope,
  endThreadProblem,
  inputKindCapability,
  invokeImagesCapabilities,
  isInputKind,
  isInvoke,
  isInvokeImageMimeType,
  isStandardBase64,
  mcpToolCustomData,
  modelTextOf,
  parseClientCatalogs,
  parseControl,
  parseLaunchEnvelope,
  readEvent,
  type CliSessionRecord,
  type EndThread,
  type HelloCliSession,
  type HelloSdkSession,
  type HelloSdkStored,
  type HelloStoredMeasures,
  type InputKind,
  type JsonValue,
  type LaunchEnvelope,
  type McpToolCustomDataContext,
  type StopReason,
} from "@guuey/worker";
import { lines } from "../stdin-lines.js";

const GOLDEN_DIR = "../python/golden/worker-protocol";

// ── outcomes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Thrown {
  readonly name: string;
  readonly message: string;
}
/** What one call did: returned a value (and the value's `JSON.stringify` bytes), returned `undefined`, or threw. */
type Outcome<T> =
  | { readonly ok: T; readonly line: string }
  | { readonly returned: "undefined" }
  | { readonly error: Thrown };

function outcome<T>(call: () => T | undefined): Outcome<T> {
  let value: T | undefined;
  try {
    value = call();
  } catch (error) {
    if (error instanceof Error) return { error: { name: error.name, message: error.message } };
    throw error;
  }
  if (value === undefined) return { returned: "undefined" };
  return { ok: value, line: JSON.stringify(value) };
}

async function writeGolden(file: string, results: readonly { readonly name: string }[] | object): Promise<void> {
  if (Array.isArray(results)) {
    const names = results.map((r: { readonly name: string }) => r.name);
    expect(new Set(names).size, `${file}: case names are unique`).toBe(names.length);
    expect(names.length, `${file}: has cases`).toBeGreaterThan(0);
  }
  await expect(JSON.stringify(results, null, 2) + "\n").toMatchFileSnapshot(`${GOLDEN_DIR}/${file}`);
}

const j = (value: object | string | number | boolean | null): string => JSON.stringify(value);

// ── shared fixtures (payloads the prev-version tests in @guuey/worker pin) ───────────────────────────────────────────

const ID = { userId: "u1", authMode: "authenticated" };
const FS = { app: "/app", home: "/home", session: "/session" };
const BASE = { type: "invoke", input: "hi", identity: ID, fs: FS, history: [] };
const inv = (patch: object): string => j({ ...BASE, ...patch });
const SHA = "a".repeat(64);
const SESSION_ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const THREAD_ID = "0b5c3f1e-8d2a-4c7b-9e1f-3a4b5c6d7e8f";
const RAW_FS = '"identity":{"userId":"u1"},"fs":{"app":"/a","home":"/h","session":"/s"}';

// parse.prev-version.test.ts
const PREV_OLD_INVOKE = {
  type: "invoke",
  input: "Approved: send_email",
  identity: { userId: "u1", authMode: "authenticated" },
  fs: FS,
  fsBound: true,
  history: [{ role: "user", text: "send it" }],
  gguiAttached: true,
};
const PREV_NEW_INVOKE = {
  ...PREV_OLD_INVOKE,
  suspend: { maxEnvelopeBytes: 2 * 1024 * 1024 },
  resume: {
    envelope: '{"state":"opaque"}',
    answers: [{ askId: "approval_call_1", toolCallId: "call_1", status: "resolved" }],
    pausedUserSeq: 3,
  },
};
const PREV_KIND_INVOKE = {
  ...PREV_OLD_INVOKE,
  input: "",
  inputKind: "context-only",
  history: [{ role: "user", text: "", inputKind: "context-only" }, { role: "agent", text: "A nice photo." }],
};
// parse.thread-id / client-catalogs / end-thread / cli-session prev-version tests
const TID_OLD_INVOKE = { ...BASE, input: "hello", fsBound: true, history: [{ role: "user", text: "earlier" }], gguiAttached: true, threadClose: {} };
const CAT_OLD_INVOKE = { ...PREV_OLD_INVOKE, input: "Book a table for four", history: [{ role: "user", text: "hello" }] };
const END_OLD_INVOKE = { ...BASE, input: "hello", fsBound: true, history: [{ role: "user", text: "earlier" }] };
const CLI_OLD_INVOKE = { ...END_OLD_INVOKE, threadId: THREAD_ID };

const STORED: HelloStoredMeasures = {
  systemPromptShas: [SHA, SHA],
  walks: [{ fromLastPromptLeaf: true, promptShas: [SHA, SHA], compactSummaries: 0, boundary: "none" }],
  lastPromptShas: [SHA, SHA],
  entries: ["x.jsonl"],
  unclassified: 0,
  corrupt: 0,
  benignDuplicates: 0,
  filePromptEntries: 2,
  fileCompactSummaries: 0,
};
const BLOCK: HelloCliSession = {
  hashVersion: CLI_SESSION_HASH_VERSION,
  systemPromptSha256: SHA,
  headerShas: { model: SHA, permissionMode: SHA, tools: SHA, mcpConfig: SHA },
  promptSha: SHA,
  promptBytes: 120,
  lastPromptSha: SHA,
  stored: STORED,
};
const OLD_HELLO = {
  type: "hello",
  framework: "claude-agent-sdk",
  sdkName: "@anthropic-ai/claude-agent-sdk",
  sdkVersion: "0.3.282",
  capabilities: ["tool-gates.v1"],
};
const NEW_HELLO = { ...OLD_HELLO, capabilities: ["tool-gates.v1", CLI_SESSION_CAPABILITY], cliSession: BLOCK };
// parse.session-ids.prev-version.test.ts
const IDS_OLD_STORED: HelloStoredMeasures = {
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
const IDS_OLD_BLOCK: HelloCliSession = { ...BLOCK, promptBytes: 120, stored: IDS_OLD_STORED };
const IDS_NEW_BLOCK: HelloCliSession = { ...IDS_OLD_BLOCK, stored: { ...IDS_OLD_STORED, sessionIds: [SESSION_ID] } };
const IDS_HELLO = { ...OLD_HELLO, capabilities: [CLI_SESSION_CAPABILITY] };
// parse.hello-tool-gates.prev-version.test.ts (pinned literally there)
const OLD_CLAUDE_HELLO =
  '{"type":"hello","framework":"claude-agent-sdk","sdkName":"@anthropic-ai/claude-agent-sdk","sdkVersion":null}';
const OLD_OPENAI_HELLO = '{"type":"hello","framework":"openai-agents-sdk","sdkName":"@openai/agents","sdkVersion":null}';
const NEW_CLAUDE_HELLO =
  '{"type":"hello","framework":"claude-agent-sdk","sdkName":"@anthropic-ai/claude-agent-sdk","sdkVersion":null,"capabilities":["tool-gates.v1"]}';
const NEW_HELLO_WITH_SUSPEND =
  '{"type":"hello","framework":"claude-agent-sdk","sdkName":"@anthropic-ai/claude-agent-sdk","sdkVersion":null,"capabilities":["tool-gates.v1","host.suspend.v1"]}';
// parse.sdk-session.test.ts and parse.sdk-session.prev-version.test.ts (guuey#3517, P4)
const SDK_STORED: HelloSdkStored = {
  fileSha256: "b".repeat(64),
  itemCount: 6,
  promptShas: [SHA, "c".repeat(64)],
  lastPromptShas: [SHA, "d".repeat(64)],
  sessionIds: [SESSION_ID],
  corrupt: 0,
  unclassified: 0,
  compactions: 0,
};
const SDK_BLOCK: HelloSdkSession = {
  kind: "google-adk",
  hashVersion: SDK_SESSION_HASH_VERSION,
  systemPromptSha256: SHA,
  headerShas: { model: SHA, tools: SHA, mcpConfig: SHA },
  promptSha: SHA,
  promptBytes: 120,
  lastPromptSha: SHA,
  stored: SDK_STORED,
};
const SDK_HELLO = {
  type: "hello",
  framework: "google-adk",
  sdkName: "google-adk",
  sdkVersion: "1.2.0",
  capabilities: ["adk.host-completion", SDK_SESSION_CAPABILITY],
};
const sdkShas = (n: number): string[] => Array.from({ length: n }, (_v, i) => i.toString(16).padStart(64, "0"));
const sdkIds = (n: number): string[] => Array.from({ length: n }, (_v, i) => `6f9619ff-8b86-4011-b42d-${i.toString(16).padStart(12, "0")}`);
// Today's JavaScript OpenAI and ADK hosts' hellos: no block, no capability.
const OLD_JS_OPENAI_HELLO =
  '{"type":"hello","framework":"openai-agents-sdk","sdkName":"@openai/agents","sdkVersion":"0.3.1","capabilities":["input-kind:context-only"]}';
const OLD_JS_ADK_HELLO =
  '{"type":"hello","framework":"google-adk","sdkName":"@google/adk","sdkVersion":"1.0.0","capabilities":["adk.host-completion","input-kind:context-only"]}';
// parse.end-thread.prev-version.test.ts
const OLD_DONE = { type: "done", stopReason: "end_turn", result: "This chat is full." };
const NEW_DONE = { ...OLD_DONE, endThread: { code: "CHAT_FULL", message: "This chat is full." } };

const FULL_INVOKE = {
  type: "invoke",
  input: "",
  inputKind: "context-only",
  identity: ID,
  fs: FS,
  fsBound: true,
  history: [{ role: "user", text: "", inputKind: "context-only" }, { role: "agent", text: "A nice photo." }],
  priorMemory: [{ key: "k", value: { n: 1 } }],
  priorState: { step: 2 },
  userMemory: "# memory\n- likes tea",
  memoryAttached: true,
  profileAccess: "read-write",
  profileSections: [{ app: "", content: "[…omitted…]" }, { app: "Notes", content: "likes tea" }],
  firstImpression: { chipKey: "greet", intent: "welcome", contract: { kind: "card" }, blueprintId: "bp_1", variance: { tone: "warm" } },
  mcpAvailability: [{ server: "gmail", state: "connected" }, { server: "drive", state: "needs_authorization" }],
  resourceCount: 3,
  gguiAttached: true,
  clientCatalogs: ["guuey.a2ui.v1"],
  withheldTools: [{ server: "ggui", tool: "ggui_consume" }],
  firstImpressionShown: { heading: "Hi", message: "Welcome", options: ["Start", "Help"] },
  suspend: { maxEnvelopeBytes: 1024 },
  resume: { envelope: "{}", answers: [{ askId: "a1", toolCallId: "c1", status: "declined" }], pausedUserSeq: 0 },
  threadClose: {},
  threadId: THREAD_ID,
  attachments: [{ kind: "inline", mimeType: "image/png", data: "iVBORw0KGgo=" }],
  cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha: "e".repeat(64) },
};

// ── parse-control ────────────────────────────────────────────────────────────────────────────────────────────────────

const PARSE_CONTROL: readonly (readonly [string, string])[] = [
  // framing and malformed lines
  ["non-JSON: plain text", "nope"],
  ["non-JSON: empty line", ""],
  ["non-JSON: NaN literal", '{"type":"invoke","input":NaN}'],
  ["non-JSON: Infinity literal", '{"type":"shutdown","x":Infinity}'],
  ["non-JSON: -Infinity literal", "[-Infinity]"],
  ["non-JSON: trailing comma", '{"type":"shutdown",}'],
  ["non-JSON: single quotes", "{'type':'shutdown'}"],
  ["non-JSON: leading zero", '{"type":"shutdown","n":01}'],
  ["non-JSON: raw tab inside a string", '{"type":"shutdown","x":"a\tb"}'],
  ["non-JSON: byte order mark first", '﻿{"type":"shutdown"}'],
  ["non-JSON: two values", '{"type":"shutdown"} {}'],
  ["non-JSON: truncated object", '{"type":"invoke","input":"x"'],
  ["non-JSON: excerpt cut at 200 UTF-16 units", "x".repeat(300)],
  ["non-JSON: excerpt cut through a surrogate pair", "x".repeat(199) + "\u{1F600}tail"],
  ["non-JSON: excerpt of astral characters", "\u{1F600}".repeat(150)],
  ["non-object: number", "42"],
  ["non-object: array", "[]"],
  ["non-object: null", "null"],
  ["non-object: string", '"invoke"'],
  ["non-object: true", "true"],
  ["non-object: long array excerpt", j(Array.from({ length: 100 }, (_v, i) => i))],
  ["no string type: missing", "{}"],
  ["no string type: number", j({ type: 1 })],
  ["no string type: null", j({ type: null })],
  ["no string type: array", j({ type: ["invoke"] })],
  ["unknown type: a newer Router's cancel", j({ type: "cancel", turnId: "t1", reason: "user" })],
  ["unknown type: literally unknown", j({ type: "unknown", x: 1 })],
  ["unknown type: empty string", j({ type: "" })],
  ["unknown type: non-ASCII", j({ type: "résumé\u{1F600}" })],
  ["unknown type: case differs from invoke", j({ type: "Invoke" })],
  ["shutdown", j({ type: "shutdown" })],
  ["shutdown: extra members dropped", j({ type: "shutdown", reason: "drain", at: 1 })],
  ["shutdown: surrounding JSON whitespace", ' \t{"type":"shutdown"}\r\n '],
  ["duplicate type: the last one wins", '{"type":"invoke","type":"shutdown"}'],
  ["a __proto__ member is an ordinary member", '{"__proto__":{"type":"invoke"},"type":"shutdown"}'],
  // invoke: required members, in the order they are checked
  ["invoke: minimal", j(BASE)],
  ["invoke: missing input", inv({ input: undefined })],
  ["invoke: input not a string", inv({ input: 5 })],
  ["invoke: missing identity", inv({ identity: undefined })],
  ["invoke: identity userId not a string", inv({ identity: { userId: 7 } })],
  ["invoke: identity is an array", inv({ identity: [] })],
  ["invoke: identity authMode missing reads anonymous", inv({ identity: { userId: "u" } })],
  ["invoke: identity authMode unknown reads anonymous", inv({ identity: { userId: "u", authMode: "admin" } })],
  ["invoke: identity extra members dropped", inv({ identity: { userId: "u", authMode: "authenticated", appId: "a" } })],
  ["invoke: missing fs", inv({ fs: undefined })],
  ["invoke: fs session not a string", inv({ fs: { app: "/a", home: "/h", session: 1 } })],
  ["invoke: fs extra members dropped", inv({ fs: { ...FS, tmp: "/tmp" } })],
  ["invoke: history absent reads empty", inv({ history: undefined })],
  ["invoke: history null", inv({ history: null })],
  ["invoke: history an object", inv({ history: { role: "user", text: "x" } })],
  ["invoke: history entry not an object", inv({ history: ["x"] })],
  ["invoke: history entry missing text", inv({ history: [{ role: "user" }] })],
  ["invoke: history roles", inv({ history: [{ role: "agent", text: "a" }, { role: "system", text: "b" }, { text: "c" }] })],
  ["invoke: history inputKind known and unknown", inv({ history: [{ role: "user", text: "", inputKind: "context-only" }, { role: "user", text: "", inputKind: 7 }, { role: "user", text: "", inputKind: "telepathy" }] })],
  ["invoke: input checked before identity", inv({ input: 1, identity: null })],
  ["invoke: identity checked before fs", inv({ identity: null, fs: null })],
  ["invoke: fs checked before history", inv({ fs: null, history: null })],
  ["invoke: a malformed lenient member never wins over a required one", inv({ identity: null, suspend: "x", resume: 1 })],
  // invoke: optional members
  ["inputKind: known", inv({ input: "", inputKind: "context-only" })],
  ["inputKind: unknown", inv({ inputKind: "telepathy" })],
  ["inputKind: number", inv({ inputKind: 7 })],
  ["fsBound: true", inv({ fsBound: true })],
  ["fsBound: false", inv({ fsBound: false })],
  ["fsBound: string", inv({ fsBound: "true" })],
  ["fsBound: number", inv({ fsBound: 1 })],
  ["priorMemory: entries kept and dropped", inv({ priorMemory: [{ key: "k", value: 1 }, { value: null }, { key: 5, value: "v" }, { key: "nov" }, "str", [1], null] })],
  ["priorMemory: none survive", inv({ priorMemory: [{ key: "k" }] })],
  ["priorMemory: empty", inv({ priorMemory: [] })],
  ["priorMemory: not an array", inv({ priorMemory: { value: 1 } })],
  ["priorState: object", inv({ priorState: { step: 1, items: ["a", "b"] } })],
  ["priorState: null kept", inv({ priorState: null })],
  ["priorState: zero kept", inv({ priorState: 0 })],
  ["priorState: empty string kept", inv({ priorState: "" })],
  ["priorState: false kept", inv({ priorState: false })],
  ["priorState: empty array kept", inv({ priorState: [] })],
  ["priorState: JavaScript number forms", `{"type":"invoke","input":"hi",${RAW_FS},"priorState":[1.0,1.5,1e21,1E-7,0.000001,123456789012345678901,-0,-0.0,0.1,100,1e-6,5e-324,1.7976931348623157e308,1e400,-1e400,9007199254740993,2e-7,-1.5e-10,1e20,123e-20,0.1e1,1e-0,25e2,4.35,0.3]}`],
  ["priorState: JavaScript key order", `{"type":"invoke","input":"hi",${RAW_FS},"priorState":{"b":1,"10":2,"2":3,"a":{"1":0,"z":1,"0":2},"4294967295":4,"4294967294":5,"01":6,"-1":7,"1.5":8}}`],
  ["priorState: duplicate keys keep the first position and the last value", `{"type":"invoke","input":"hi",${RAW_FS},"priorState":{"b":1,"1":2,"b":3,"a":4}}`],
  ["priorState: escapes and non-ASCII", `{"type":"invoke","input":"hi",${RAW_FS},"priorState":"q\\"b\\\\s\\/n\\nt\\tc\\u0001d\\u007f\\u00e9\\u2028\\ud83d\\ude00\\ud800 lone"}`],
  ["priorState: __proto__ member passes through", `{"type":"invoke","input":"hi",${RAW_FS},"priorState":{"__proto__":{"x":1},"y":2}}`],
  ["userMemory: string", inv({ userMemory: "# memory" })],
  ["userMemory: empty string kept", inv({ userMemory: "" })],
  ["userMemory: number dropped", inv({ userMemory: 1 })],
  ["memoryAttached: true", inv({ memoryAttached: true })],
  ["memoryAttached: string dropped", inv({ memoryAttached: "yes" })],
  ["profileAccess: read", inv({ profileAccess: "read" })],
  ["profileAccess: read-write", inv({ profileAccess: "read-write" })],
  ["profileAccess: write dropped", inv({ profileAccess: "write" })],
  ["profileSections: entries kept and dropped", inv({ profileSections: [{ app: "", content: "[…omitted…]" }, { app: "A", content: 1 }, { content: "x" }, "s", { app: "B", content: "b", extra: 1 }] })],
  ["profileSections: none survive", inv({ profileSections: [{ app: 1 }] })],
  ["firstImpression: full with variance", inv({ firstImpression: { chipKey: "c", intent: "i", contract: { b: 1, "1": 2 }, blueprintId: "bp", variance: { tone: "warm" }, extra: 1 } })],
  ["firstImpression: empty variance dropped", inv({ firstImpression: { chipKey: "c", intent: "i", contract: {}, variance: {} } })],
  ["firstImpression: variance array dropped", inv({ firstImpression: { chipKey: "c", intent: "i", contract: {}, variance: ["x"] } })],
  ["firstImpression: empty blueprintId dropped", inv({ firstImpression: { chipKey: "c", intent: "i", contract: {}, blueprintId: "" } })],
  ["firstImpression: empty chipKey drops it whole", inv({ firstImpression: { chipKey: "", intent: "i", contract: {} } })],
  ["firstImpression: empty intent drops it whole", inv({ firstImpression: { chipKey: "c", intent: "", contract: {} } })],
  ["firstImpression: contract array drops it whole", inv({ firstImpression: { chipKey: "c", intent: "i", contract: [] } })],
  ["firstImpression: contract null drops it whole", inv({ firstImpression: { chipKey: "c", intent: "i", contract: null } })],
  ["mcpAvailability: entries kept and dropped", inv({ mcpAvailability: [{ server: "gmail", state: "connected" }, { server: "", state: "denied" }, { server: "x", state: "gone" }, { state: "denied" }, [], { server: "drive", state: "unavailable", extra: 1 }] })],
  ["mcpAvailability: none survive", inv({ mcpAvailability: [{ server: "x" }] })],
  ["resourceCount: positive integer", inv({ resourceCount: 3 })],
  ["resourceCount: zero dropped", inv({ resourceCount: 0 })],
  ["resourceCount: negative dropped", inv({ resourceCount: -1 })],
  ["resourceCount: fraction dropped", inv({ resourceCount: 2.5 })],
  ["resourceCount: string dropped", inv({ resourceCount: "3" })],
  ["resourceCount: boolean dropped", inv({ resourceCount: true })],
  ["resourceCount: 3.0 is the integer 3", `{"type":"invoke","input":"hi",${RAW_FS},"resourceCount":3.0}`],
  ["resourceCount: 1e300 is an integer", `{"type":"invoke","input":"hi",${RAW_FS},"resourceCount":1e300}`],
  ["resourceCount: 1e400 is Infinity, dropped", `{"type":"invoke","input":"hi",${RAW_FS},"resourceCount":1e400}`],
  ["gguiAttached: true", inv({ gguiAttached: true })],
  ["gguiAttached: null dropped", inv({ gguiAttached: null })],
  ["clientCatalogs: kept, deduplicated, bad entries dropped", inv({ clientCatalogs: ["guuey.a2ui.v1", "guuey.a2ui.v1", "has space", 7, "", "x".repeat(65), "x".repeat(64), "a/b@c+d~e:f-g_h"] })],
  ["clientCatalogs: capped at 16", inv({ clientCatalogs: Array.from({ length: 20 }, (_v, i) => `cat.${String(i)}`) })],
  ["clientCatalogs: none survive", inv({ clientCatalogs: ["bad id"] })],
  ["clientCatalogs: not an array", inv({ clientCatalogs: { a2ui: true } })],
  ["clientCatalogs: trailing newline in an id", inv({ clientCatalogs: ["guuey.a2ui.v1\n"] })],
  ["withheldTools: entries kept and dropped", inv({ withheldTools: [{ server: "ggui", tool: "ggui_consume", extra: 1 }, { server: "", tool: "t" }, { server: "s" }, null, ["s", "t"], "s/t", { server: "a", tool: "b" }] })],
  ["withheldTools: none survive", inv({ withheldTools: [{ server: "s", tool: "" }] })],
  ["withheldTools: empty", inv({ withheldTools: [] })],
  ["firstImpressionShown: well formed", inv({ firstImpressionShown: { heading: "Welcome to Harbor Books", message: "Glad you're here.", options: ["Find a book", "Opening hours"], extra: 1 } })],
  ["firstImpressionShown: empty message kept, empty options kept", inv({ firstImpressionShown: { heading: "H", message: "", options: [] } })],
  ["firstImpressionShown: empty heading drops it", inv({ firstImpressionShown: { heading: "", message: "m", options: [] } })],
  ["firstImpressionShown: non-string option drops it", inv({ firstImpressionShown: { heading: "H", message: "m", options: ["a", 2] } })],
  ["firstImpressionShown: array drops it", inv({ firstImpressionShown: ["H", "m", []] })],
  ["suspend: well formed", inv({ suspend: { maxEnvelopeBytes: 1024, extra: true } })],
  ["suspend: zero dropped", inv({ suspend: { maxEnvelopeBytes: 0 } })],
  ["suspend: negative dropped", inv({ suspend: { maxEnvelopeBytes: -1 } })],
  ["suspend: fraction dropped", inv({ suspend: { maxEnvelopeBytes: 1.5 } })],
  ["suspend: string dropped", inv({ suspend: { maxEnvelopeBytes: "100" } })],
  ["suspend: not an object", inv({ suspend: "yes" })],
  ["suspend: 1e300 kept", `{"type":"invoke","input":"hi",${RAW_FS},"suspend":{"maxEnvelopeBytes":1e300}}`],
  ["resume: well formed", inv({ resume: { envelope: '{"s":1}', answers: [{ askId: "a", toolCallId: "c", status: "resolved", extra: 1 }], pausedUserSeq: 3, extra: 1 } })],
  ["resume: without pausedUserSeq", inv({ resume: { envelope: "e", answers: [{ askId: "a", toolCallId: "c", status: "declined" }] } })],
  ["resume: pausedUserSeq zero kept", inv({ resume: { envelope: "e", answers: [{ askId: "a", toolCallId: "c", status: "declined" }], pausedUserSeq: 0 } })],
  ["resume: pausedUserSeq null drops it whole", inv({ resume: { envelope: "e", answers: [{ askId: "a", toolCallId: "c", status: "declined" }], pausedUserSeq: null } })],
  ["resume: pausedUserSeq negative drops it whole", inv({ resume: { envelope: "e", answers: [{ askId: "a", toolCallId: "c", status: "declined" }], pausedUserSeq: -1 } })],
  ["resume: pausedUserSeq fraction drops it whole", inv({ resume: { envelope: "e", answers: [{ askId: "a", toolCallId: "c", status: "declined" }], pausedUserSeq: 1.5 } })],
  ["resume: empty envelope drops it", inv({ resume: { envelope: "", answers: [{ askId: "a", toolCallId: "c", status: "declined" }] } })],
  ["resume: empty answers drops it", inv({ resume: { envelope: "e", answers: [] } })],
  ["resume: one bad answer drops it whole", inv({ resume: { envelope: "e", answers: [{ askId: "a", toolCallId: "c", status: "declined" }, { askId: "b", toolCallId: "", status: "resolved" }] } })],
  ["resume: unknown status drops it whole", inv({ resume: { envelope: "e", answers: [{ askId: "a", toolCallId: "c", status: "approved" }] } })],
  ["resume: envelope not a string", inv({ resume: { envelope: 1 } })],
  ["threadClose: empty object", inv({ threadClose: {} })],
  ["threadClose: members reduced to the offer", inv({ threadClose: { x: 1 } })],
  ["threadClose: array is no offer", inv({ threadClose: [] })],
  ["threadClose: true is no offer", inv({ threadClose: true })],
  ["threadClose: null is no offer", inv({ threadClose: null })],
  ["threadId: kept", inv({ threadId: THREAD_ID })],
  ["threadId: empty dropped", inv({ threadId: "" })],
  ["threadId: number dropped", inv({ threadId: 42 })],
  ["threadId: object dropped", inv({ threadId: { id: "t" } })],
  ["attachments: two images", inv({ attachments: [{ kind: "inline", mimeType: "image/png", data: "iVBORw0KGgo=", extra: 1 }, { kind: "inline", mimeType: "image/webp", data: "UklGRg==" }] })],
  ["attachments: one unknown type drops the list", inv({ attachments: [{ kind: "inline", mimeType: "image/png", data: "iVBORw0KGgo=" }, { kind: "inline", mimeType: "image/svg+xml", data: "PHN2Zz4=" }] })],
  ["attachments: data with a line break", inv({ attachments: [{ kind: "inline", mimeType: "image/png", data: "iVBO\nRw0KGgo=" }] })],
  ["attachments: data with a trailing newline", inv({ attachments: [{ kind: "inline", mimeType: "image/png", data: "iVBORw0KGgo=\n" }] })],
  ["attachments: data not padded to 4", inv({ attachments: [{ kind: "inline", mimeType: "image/png", data: "iVBORw0KGgo" }] })],
  ["attachments: empty data", inv({ attachments: [{ kind: "inline", mimeType: "image/png", data: "" }] })],
  ["attachments: data URL prefix", inv({ attachments: [{ kind: "inline", mimeType: "image/png", data: "data:image/png;base64,iVBORw0KGgo=" }] })],
  ["attachments: url kind", inv({ attachments: [{ kind: "url", mimeType: "image/png", data: "iVBORw0KGgo=" }] })],
  ["attachments: empty list", inv({ attachments: [] })],
  ["attachments: three padding characters", inv({ attachments: [{ kind: "inline", mimeType: "image/gif", data: "R0lGO===" }] })],
  ["cliSession: start", inv({ cliSession: { mode: "start", id: SESSION_ID } })],
  ["cliSession: resume with expectLastPromptSha", inv({ cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha: "e".repeat(64), extra: 1 } })],
  ["cliSession: non-UUID id kept", inv({ cliSession: { mode: "start", id: "not-a-uuid" } })],
  ["cliSession: upper-case sha drops it", inv({ cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha: "E".repeat(64) } })],
  ["cliSession: short sha drops it", inv({ cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha: "e".repeat(63) } })],
  ["cliSession: sha with a trailing newline drops it", inv({ cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha: "e".repeat(64) + "\n" } })],
  ["cliSession: null sha drops it", inv({ cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha: null } })],
  ["cliSession: unknown mode", inv({ cliSession: { mode: "fork", id: SESSION_ID } })],
  ["cliSession: empty id", inv({ cliSession: { mode: "resume", id: "" } })],
  ["cliSession: missing id", inv({ cliSession: { mode: "start" } })],
  ["cliSession: a string", inv({ cliSession: "resume" })],
  ["invoke: every optional member, in wire order", j(FULL_INVOKE)],
  ["invoke: every optional member, members sent in reverse", j(Object.fromEntries(Object.entries(FULL_INVOKE).reverse()))],
  // the previous releases' payloads (each from the matching *.prev-version.test.ts)
  ["prev: suspend/resume old Router invoke", j(PREV_OLD_INVOKE)],
  ["prev: suspend/resume new Router invoke", j(PREV_NEW_INVOKE)],
  ["prev: suspend/resume malformed new members", j({ ...PREV_OLD_INVOKE, suspend: "yes", resume: { envelope: 1 } })],
  ["prev: inputKind invoke", j(PREV_KIND_INVOKE)],
  ["prev: inputKind unknown kinds", j({ ...PREV_KIND_INVOKE, inputKind: "telepathy", history: [{ role: "user", text: "", inputKind: 7 }] })],
  ["prev: threadId old Router invoke", j(TID_OLD_INVOKE)],
  ["prev: threadId new Router invoke", j({ ...TID_OLD_INVOKE, threadId: THREAD_ID })],
  ["prev: threadId null", j({ ...TID_OLD_INVOKE, threadId: null })],
  ["prev: clientCatalogs old Router invoke", j(CAT_OLD_INVOKE)],
  ["prev: clientCatalogs new Router invoke", j({ ...CAT_OLD_INVOKE, clientCatalogs: ["guuey.a2ui.v1", "guuey.json-render.v1"] })],
  ["prev: clientCatalogs malformed", j({ ...CAT_OLD_INVOKE, clientCatalogs: { a2ui: true } })],
  ["prev: threadClose old Router invoke", j(END_OLD_INVOKE)],
  ["prev: threadClose new Router invoke", j({ ...END_OLD_INVOKE, threadClose: {} })],
  ["prev: cliSession old Router invoke", j(CLI_OLD_INVOKE)],
  ["prev: cliSession new Router invoke", j({ ...CLI_OLD_INVOKE, cliSession: { mode: "resume", id: SESSION_ID } })],
  ["prev: cliSession null", j({ ...CLI_OLD_INVOKE, cliSession: null })],
  ["prev: expectLastPromptSha new Router invoke", j({ ...BASE, input: "hello", cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha: "e".repeat(64) } })],
  ["prev: expectLastPromptSha not a string", j({ ...BASE, input: "hello", cliSession: { mode: "resume", id: SESSION_ID, expectLastPromptSha: 7 } })],
  ["prev: unknown-type invoke", j({ type: "invoke", input: "hi", identity: { userId: "u", authMode: "authenticated" }, fs: FS, history: [] })],
];

// ── read-event ───────────────────────────────────────────────────────────────────────────────────────────────────────

const helloWith = (cliSession: object): string => j({ ...NEW_HELLO, cliSession });
const sdkHelloWith = (session: object | string | null): string => j({ ...SDK_HELLO, session });
const sdkStoredWith = (patch: object): string => sdkHelloWith({ ...SDK_BLOCK, stored: { ...SDK_STORED, ...patch } });
const { stored: _sdkStored, ...SDK_START_BLOCK } = SDK_BLOCK;
const { kind: _sdkKind, ...SDK_NO_KIND } = SDK_BLOCK;
/** The SDK session block (guuey#3517, P4): kept whole, or dropped whole on any malformed member or bound breach. */
const READ_EVENT_SDK_SESSION: readonly (readonly [string, string])[] = [
  ["hello: SDK session block kept whole", sdkHelloWith(SDK_BLOCK)],
  ["hello: SDK session start block without stored", sdkHelloWith(SDK_START_BLOCK)],
  ["hello: SDK session openai-agents kind", sdkHelloWith({ ...SDK_BLOCK, kind: "openai-agents" })],
  ["hello: SDK session readError side-file kept", sdkStoredWith({ readError: "side-file", promptShas: [], lastPromptShas: [], sessionIds: [], itemCount: 0 })],
  ["hello: SDK session readError missing kept", sdkStoredWith({ readError: "missing", promptShas: [], lastPromptShas: [], sessionIds: [], itemCount: 0 })],
  ["hello: SDK session members reordered and extra", sdkHelloWith({ extra: 1, ...Object.fromEntries(Object.entries(SDK_BLOCK).reverse()), stored: { z: 1, ...Object.fromEntries(Object.entries(SDK_STORED).reverse()) } })],
  ["hello: SDK session upper-case UUID kept", sdkStoredWith({ sessionIds: [SESSION_ID.toUpperCase()] })],
  ["hello: SDK session counts written 2.0 read as integers", sdkHelloWith(SDK_BLOCK).replace('"hashVersion":1', '"hashVersion":1.0').replace('"promptBytes":120', '"promptBytes":120.0').replace('"itemCount":6', '"itemCount":6.0')],
  ["hello: SDK session beside a thread-resume block, both kept", j({ ...NEW_HELLO, session: SDK_BLOCK })],
  [`hello: SDK session ${SDK_SESSION_PROMPT_SHAS_MAX} promptShas and lastPromptShas kept`, sdkStoredWith({ promptShas: sdkShas(SDK_SESSION_PROMPT_SHAS_MAX), lastPromptShas: sdkShas(SDK_SESSION_PROMPT_SHAS_MAX) })],
  [`hello: SDK session dropped on ${SDK_SESSION_PROMPT_SHAS_MAX + 1} promptShas`, sdkStoredWith({ promptShas: sdkShas(SDK_SESSION_PROMPT_SHAS_MAX + 1) })],
  [`hello: SDK session dropped on ${SDK_SESSION_PROMPT_SHAS_MAX + 1} lastPromptShas`, sdkStoredWith({ lastPromptShas: sdkShas(SDK_SESSION_PROMPT_SHAS_MAX + 1) })],
  [`hello: SDK session ${SDK_SESSION_IDS_MAX} sessionIds kept`, sdkStoredWith({ sessionIds: sdkIds(SDK_SESSION_IDS_MAX) })],
  [`hello: SDK session dropped on ${SDK_SESSION_IDS_MAX + 1} sessionIds`, sdkStoredWith({ sessionIds: sdkIds(SDK_SESSION_IDS_MAX + 1) })],
  ["hello: SDK session dropped on an upper-case systemPromptSha256", sdkHelloWith({ ...SDK_BLOCK, systemPromptSha256: "A".repeat(64) })],
  ["hello: SDK session dropped on a 65-character headerShas.model", sdkHelloWith({ ...SDK_BLOCK, headerShas: { ...SDK_BLOCK.headerShas, model: "a".repeat(65) } })],
  ["hello: SDK session dropped on a 63-character headerShas.tools", sdkHelloWith({ ...SDK_BLOCK, headerShas: { ...SDK_BLOCK.headerShas, tools: "a".repeat(63) } })],
  ["hello: SDK session dropped on an upper-case headerShas.mcpConfig", sdkHelloWith({ ...SDK_BLOCK, headerShas: { ...SDK_BLOCK.headerShas, mcpConfig: "F".repeat(64) } })],
  ["hello: SDK session dropped on a promptSha with a trailing newline", sdkHelloWith({ ...SDK_BLOCK, promptSha: SHA + "\n" })],
  ["hello: SDK session dropped on a non-hex lastPromptSha", sdkHelloWith({ ...SDK_BLOCK, lastPromptSha: "g".repeat(64) })],
  ["hello: SDK session dropped on an upper-case fileSha256", sdkStoredWith({ fileSha256: "B".repeat(64) })],
  ["hello: SDK session dropped on a short promptShas entry", sdkStoredWith({ promptShas: [SHA, "c".repeat(63)] })],
  ["hello: SDK session dropped on a lastPromptShas entry with a trailing newline", sdkStoredWith({ lastPromptShas: [SHA + "\n"] })],
  ["hello: SDK session dropped on negative promptBytes", sdkHelloWith({ ...SDK_BLOCK, promptBytes: -1 })],
  ["hello: SDK session dropped on promptBytes past the largest double", sdkHelloWith(SDK_BLOCK).replace('"promptBytes":120', '"promptBytes":1e400')],
  ["hello: SDK session dropped on a fractional itemCount", sdkStoredWith({ itemCount: 0.5 })],
  ["hello: SDK session dropped on a string corrupt", sdkStoredWith({ corrupt: "0" })],
  ["hello: SDK session dropped on a boolean unclassified", sdkStoredWith({ unclassified: false })],
  ["hello: SDK session dropped on a null compactions", sdkStoredWith({ compactions: null })],
  ["hello: SDK session dropped on a negative compactions", sdkStoredWith({ compactions: -1 })],
  ["hello: SDK session dropped on hashVersion 0", sdkHelloWith({ ...SDK_BLOCK, hashVersion: 0 })],
  ["hello: SDK session dropped on a fractional hashVersion", sdkHelloWith({ ...SDK_BLOCK, hashVersion: 1.5 })],
  ["hello: SDK session dropped on a string hashVersion", sdkHelloWith({ ...SDK_BLOCK, hashVersion: "1" })],
  ["hello: SDK session dropped on an unknown kind", sdkHelloWith({ ...SDK_BLOCK, kind: "claude" })],
  ["hello: SDK session dropped on the framework spelling as kind", sdkHelloWith({ ...SDK_BLOCK, kind: "openai-agents-sdk" })],
  ["hello: SDK session dropped on a missing kind", sdkHelloWith(SDK_NO_KIND)],
  ["hello: SDK session dropped on a non-UUID session id", sdkStoredWith({ sessionIds: [SESSION_ID, "not-a-uuid"] })],
  ["hello: SDK session dropped on a session id with a trailing newline", sdkStoredWith({ sessionIds: [SESSION_ID + "\n"] })],
  ["hello: SDK session dropped on a braced UUID", sdkStoredWith({ sessionIds: [`{${SESSION_ID}}`] })],
  ["hello: SDK session dropped on a number session id", sdkStoredWith({ sessionIds: [7] })],
  ["hello: SDK session dropped on an unknown readError", sdkStoredWith({ readError: "gone" })],
  ["hello: SDK session dropped on a null readError", sdkStoredWith({ readError: null })],
  ["hello: SDK session dropped on a null stored", sdkHelloWith({ ...SDK_BLOCK, stored: null })],
  ["hello: SDK session dropped on a missing fileSha256", sdkStoredWith({ fileSha256: undefined })],
  ["hello: SDK session dropped on a missing sessionIds", sdkStoredWith({ sessionIds: undefined })],
  ["hello: SDK session dropped on a missing header sha", sdkHelloWith({ ...SDK_BLOCK, headerShas: { model: SHA, tools: SHA } })],
  ["hello: SDK session a string reads as none", sdkHelloWith("session")],
  ["hello: SDK session null reads as none", sdkHelloWith(null)],
  ["prev: today's JS OpenAI host hello, no SDK session", OLD_JS_OPENAI_HELLO],
  ["prev: today's JS ADK host hello, no SDK session", OLD_JS_ADK_HELLO],
];
const READ_EVENT: readonly (readonly [string, string])[] = [
  ["non-JSON: plain text", "nope"],
  ["non-JSON: NaN literal", '{"type":"text","text":NaN}'],
  ["non-JSON: excerpt cut through a surrogate pair", "y".repeat(199) + "\u{1F600}"],
  ["non-object: number", "42"],
  ["non-object: array", '["text"]'],
  ["no string type: missing", j({ text: "x" })],
  ["no string type: boolean", j({ type: true })],
  ["unknown type: a newer worker's progress, other members never kept", j({ type: "progress", pct: 40, secret: "s3cr3t" })],
  ["unknown type: literally unknown", j({ type: "unknown", x: 1 })],
  ["text", j({ type: "text", text: "hello" })],
  ["text: empty", j({ type: "text", text: "" })],
  ["text: identity members never parsed", j({ type: "text", text: "a", userId: "u", appId: "a", threadId: "t", authMode: "authenticated" })],
  ["text: missing text", j({ type: "text" })],
  ["text: text not a string", j({ type: "text", text: 5 })],
  ["done: minimal", j({ type: "done" })],
  ["done: max_turns", j({ type: "done", stopReason: "max_turns", result: "r" })],
  ["done: error", j({ type: "done", stopReason: "error", result: "r" })],
  ["done: unknown stopReason reads end_turn", j({ type: "done", stopReason: "paused", result: "r" })],
  ["done: result not a string reads empty", j({ type: "done", result: 5 })],
  ["done: endThread kept", j({ type: "done", stopReason: "end_turn", result: "bye", endThread: { code: "CHAT_FULL", message: "This chat is full.", extra: 1 } })],
  ["done: endThread lower-case code dropped", j({ type: "done", result: "", endThread: { code: "chat_full", message: "m" } })],
  ["done: endThread code of 40 kept", j({ type: "done", result: "", endThread: { code: "A".repeat(40), message: "m" } })],
  ["done: endThread code of 41 dropped", j({ type: "done", result: "", endThread: { code: "A".repeat(41), message: "m" } })],
  ["done: endThread code with a trailing newline dropped", j({ type: "done", result: "", endThread: { code: "CHAT_FULL\n", message: "m" } })],
  ["done: endThread message of 500 astral characters kept", j({ type: "done", result: "", endThread: { code: "X", message: "\u{1F600}".repeat(500) } })],
  ["done: endThread message of 501 characters dropped", j({ type: "done", result: "", endThread: { code: "X", message: "m".repeat(501) } })],
  ["done: endThread empty message dropped", j({ type: "done", result: "", endThread: { code: "X", message: "" } })],
  ["done: endThread message with a line feed kept", j({ type: "done", result: "", endThread: { code: "X", message: "a\nb" } })],
  ["done: endThread message with a tab dropped", j({ type: "done", result: "", endThread: { code: "X", message: "a\tb" } })],
  ["done: endThread message with DEL dropped", j({ type: "done", result: "", endThread: { code: "X", message: "a\u007fb" } })],
  ["done: endThread message with NEL dropped", j({ type: "done", result: "", endThread: { code: "X", message: "a\u0085b" } })],
  ["done: endThread message with a no-break space kept", j({ type: "done", result: "", endThread: { code: "X", message: "a b" } })],
  ["done: endThread not an object", j({ type: "done", result: "", endThread: 7 })],
  ["done: endThread message not a string", j({ type: "done", result: "", endThread: { code: "X", message: 1 } })],
  ["error", j({ type: "error", message: "boom" })],
  ["error: missing message", j({ type: "error" })],
  ["native: object event", j({ type: "native", framework: "claude-agent-sdk", event: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } } })],
  ["native: null event kept", j({ type: "native", framework: "google-adk", event: null })],
  ["native: missing event", j({ type: "native", framework: "google-adk" })],
  ["native: missing framework", j({ type: "native", event: {} })],
  ["native: event key order and numbers", '{"type":"native","framework":"openai-agents-sdk","event":{"z":1.50,"3":2.0,"1":[1e21,1e-7,-0],"a":{"10":1,"9":2}}}'],
  ["hello: full", j({ type: "hello", framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk", sdkVersion: "0.3.199" })],
  ["hello: sdkName and sdkVersion missing read null", j({ type: "hello", framework: "vanilla" })],
  ["hello: sdkName not a string reads null", j({ type: "hello", framework: "vanilla", sdkName: 1, sdkVersion: null })],
  ["hello: missing framework", j({ type: "hello", sdkName: "x" })],
  ["hello: capabilities kept", j({ type: "hello", framework: "google-adk", sdkName: "@google/adk", sdkVersion: "2.1.0", capabilities: ["adk.host-completion", "future.thing"] })],
  ["hello: empty capabilities read as none", j({ type: "hello", framework: "f", sdkName: null, sdkVersion: null, capabilities: [] })],
  ["hello: capabilities a string read as none", j({ type: "hello", framework: "f", sdkName: null, sdkVersion: null, capabilities: "adk.host-completion" })],
  ["hello: capabilities with a number read as none", j({ type: "hello", framework: "f", sdkName: null, sdkVersion: null, capabilities: ["ok", 7] })],
  ["hello: capabilities null read as none", j({ type: "hello", framework: "f", sdkName: null, sdkVersion: null, capabilities: null })],
  ["hello: thread-resume block kept whole", j(NEW_HELLO)],
  ["hello: thread-resume block without stored", helloWith({ ...BLOCK, stored: undefined })],
  ["hello: thread-resume block with readError", helloWith({ ...BLOCK, stored: { ...STORED, readError: "missing", systemPromptShas: [], walks: [], lastPromptShas: [], entries: [], filePromptEntries: 0 } })],
  ["hello: thread-resume block members reordered and extra", j({ ...NEW_HELLO, cliSession: { extra: 1, ...Object.fromEntries(Object.entries(BLOCK).reverse()) } })],
  ["hello: block dropped on negative promptBytes", helloWith({ ...BLOCK, promptBytes: -1 })],
  ["hello: block dropped on a missing header sha", helloWith({ ...BLOCK, headerShas: { model: SHA, permissionMode: SHA, tools: SHA } })],
  ["hello: block dropped on a string hashVersion", helloWith({ ...BLOCK, hashVersion: "1" })],
  ["hello: block dropped on an unknown readError", helloWith({ ...BLOCK, stored: { ...STORED, readError: "gone" } })],
  ["hello: block dropped on a null readError", helloWith({ ...BLOCK, stored: { ...STORED, readError: null } })],
  ["hello: block dropped on an unknown walk boundary", helloWith({ ...BLOCK, stored: { ...STORED, walks: [{ fromLastPromptLeaf: true, promptShas: [], compactSummaries: 0, boundary: "maybe" }] } })],
  ["hello: block dropped on a fractional count", helloWith({ ...BLOCK, stored: { ...STORED, unclassified: 0.5 } })],
  ["hello: block dropped on a non-string entry", helloWith({ ...BLOCK, stored: { ...STORED, entries: [1] } })],
  ["hello: block dropped on a missing benignDuplicates", helloWith({ ...BLOCK, stored: { ...STORED, benignDuplicates: undefined } })],
  ["hello: block dropped on a missing corrupt", helloWith({ ...BLOCK, stored: { ...STORED, corrupt: undefined } })],
  ["hello: block dropped on a null stored", helloWith({ ...BLOCK, stored: null })],
  ["hello: block dropped on a walk with a boolean count", helloWith({ ...BLOCK, stored: { ...STORED, walks: [{ fromLastPromptLeaf: true, promptShas: [], compactSummaries: true, boundary: "none" }] } })],
  ["hello: counts written 2.0 read as integers", `{"type":"hello","framework":"f","sdkName":null,"sdkVersion":null,"cliSession":{"hashVersion":1.0,"systemPromptSha256":"s","headerShas":{"model":"m","permissionMode":"p","tools":"t","mcpConfig":"c"},"promptSha":"p","promptBytes":2.0,"lastPromptSha":"l"}}`],
  ["hello: sessionIds kept", j({ ...IDS_HELLO, cliSession: IDS_NEW_BLOCK })],
  ["hello: older block without sessionIds", j({ ...IDS_HELLO, cliSession: IDS_OLD_BLOCK })],
  ["hello: block dropped on a non-string session id", j({ ...IDS_HELLO, cliSession: { ...IDS_OLD_BLOCK, stored: { ...IDS_OLD_STORED, sessionIds: [1] } } })],
  ["hello: block dropped on a non-array sessionIds", j({ ...IDS_HELLO, cliSession: { ...IDS_OLD_BLOCK, stored: { ...IDS_OLD_STORED, sessionIds: SESSION_ID } } })],
  ["hello: block dropped on a null sessionIds", j({ ...IDS_HELLO, cliSession: { ...IDS_OLD_BLOCK, stored: { ...IDS_OLD_STORED, sessionIds: null } } })],
  ["suspend", j({ type: "suspend", envelope: '{"s":1}', askIds: ["approval_a", "approval_b"] })],
  ["suspend: empty askIds", j({ type: "suspend", envelope: "", askIds: [] })],
  ["suspend: missing envelope", j({ type: "suspend", askIds: [] })],
  ["suspend: askIds not a list", j({ type: "suspend", envelope: "e", askIds: "a" })],
  ["suspend: askIds with a number", j({ type: "suspend", envelope: "e", askIds: ["a", 1] })],
  ["suspend: askIds missing", j({ type: "suspend", envelope: "e" })],
  // the previous releases' payloads
  ["prev: old done", j(OLD_DONE)],
  ["prev: new done with endThread", j(NEW_DONE)],
  ["prev: done with a malformed endThread", j({ ...OLD_DONE, endThread: 7 })],
  ["prev: 0.31.1 Claude scaffold hello", OLD_CLAUDE_HELLO],
  ["prev: 0.31.1 OpenAI scaffold hello", OLD_OPENAI_HELLO],
  ["prev: tool-gates hello", NEW_CLAUDE_HELLO],
  ["prev: tool-gates hello with suspend", NEW_HELLO_WITH_SUSPEND],
  ["prev: cli-session old host hello", j(OLD_HELLO)],
  ["prev: unknown-type text", j({ type: "text", text: "a" })],
  ["prev: unknown-type done", j({ type: "done", stopReason: "end_turn", result: "r" })],
  ["prev: unknown-type error", j({ type: "error", message: "m" })],
];

// ── emit ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

type EmitCall =
  | { readonly method: "text"; readonly text: string }
  | { readonly method: "done"; readonly result: string; readonly stopReason?: StopReason; readonly endThread?: EndThread }
  | { readonly method: "error"; readonly message: string }
  | { readonly method: "native"; readonly framework: string; readonly event: JsonValue }
  | {
      readonly method: "hello";
      readonly framework: string;
      readonly sdkName: string | null;
      readonly sdkVersion: string | null;
      readonly capabilities?: readonly string[];
      readonly cliSession?: HelloCliSession;
    };

function emitAll(calls: readonly EmitCall[]): string {
  let written = "";
  const emit = createEmitter({ write: (s) => (written += s) });
  for (const call of calls) {
    switch (call.method) {
      case "text":
        emit.text(call.text);
        break;
      case "done":
        emit.done(call.result, call.stopReason, call.endThread);
        break;
      case "error":
        emit.error(call.message);
        break;
      case "native":
        emit.native(call.framework, call.event);
        break;
      case "hello":
        emit.hello(call.framework, call.sdkName, call.sdkVersion, call.capabilities, call.cliSession);
        break;
    }
  }
  return written;
}

// An own `__proto__` member, which only JSON.parse can make (an object literal would set the prototype instead).
const PROTO_EVENT = JSON.parse('{"__proto__":{"x":1},"a":1}') as JsonValue;
const EMIT: readonly (readonly [string, readonly EmitCall[]])[] = [
  ["text", [{ method: "text", text: "hello" }]],
  ["text: empty", [{ method: "text", text: "" }]],
  ["text: JSON escapes", [{ method: "text", text: 'q" b\\ s/ nl\n cr\r tab\t bs\b ff\f nul\u0000 us\u001f vt\u000b' }]],
  ["text: characters written literally", [{ method: "text", text: "del\u007f nel\u0085 nbsp  é ls  ps  bom﻿ 中 \u{1F600}" }]],
  ["text: lone high surrogate", [{ method: "text", text: "a\ud800b" }]],
  ["text: lone low surrogate", [{ method: "text", text: "\udc00" }]],
  ["text: surrogates in reverse order", [{ method: "text", text: "\udc00\ud800" }]],
  ["text: a high surrogate at the end", [{ method: "text", text: "x\udbff" }]],
  ["done: default stopReason", [{ method: "done", result: "final" }]],
  ["done: max_turns", [{ method: "done", result: "r", stopReason: "max_turns" }]],
  ["done: error", [{ method: "done", result: "", stopReason: "error" }]],
  ["done: endThread", [{ method: "done", result: "This chat is full.", stopReason: "end_turn", endThread: { code: "CHAT_FULL", message: "This chat is full." } }]],
  ["done: endThread with the default stopReason", [{ method: "done", result: "r", endThread: { code: "X", message: "bye \u{1F44B}" } }]],
  ["done: endThread is written as given, not validated", [{ method: "done", result: "r", endThread: { code: "lower", message: "" } }]],
  ["error", [{ method: "error", message: "boom" }]],
  ["native: object", [{ method: "native", framework: "claude-agent-sdk", event: { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hi" }] } } }]],
  ["native: JavaScript key order", [{ method: "native", framework: "f", event: { b: 1, "10": 2, "2": 3, a: { "1": 0, z: 1, "0": 2 }, "4294967295": 4, "4294967294": 5, "01": 6 } }]],
  ["native: numbers", [{ method: "native", framework: "f", event: [0, -0, 1, -1, 1.5, 0.1, 0.3, 1e21, 1e20, 1e-7, 1e-6, 123456789012345680000, 5e-324, 1.7976931348623157e308, 2 ** 53, 2 ** 53 + 2, -1.5e-10, 4.35, 100, 25e2] }]],
  ["native: null", [{ method: "native", framework: "f", event: null }]],
  ["native: string", [{ method: "native", framework: "f", event: "s" }]],
  ["native: empty containers", [{ method: "native", framework: "f", event: { a: [], b: {}, c: [[]], d: [{}] } }]],
  ["native: a __proto__ member", [{ method: "native", framework: "f", event: PROTO_EVENT }]],
  ["native: booleans and nested nulls", [{ method: "native", framework: "f", event: [true, false, null, { t: true }] }]],
  ["hello", [{ method: "hello", framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk", sdkVersion: "0.3.199" }]],
  ["hello: nulls", [{ method: "hello", framework: "vanilla", sdkName: null, sdkVersion: null }]],
  ["hello: capabilities", [{ method: "hello", framework: "google-adk", sdkName: "@google/adk", sdkVersion: "2.1.0", capabilities: ["adk.host-completion"] }]],
  ["hello: empty capabilities write no key", [{ method: "hello", framework: "google-adk", sdkName: "@google/adk", sdkVersion: "2.1.0", capabilities: [] }]],
  ["hello: tool gates, then tool gates with suspend", [
    { method: "hello", framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk", sdkVersion: null, capabilities: [TOOL_GATES_CAPABILITY] },
    { method: "hello", framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk", sdkVersion: null, capabilities: [TOOL_GATES_CAPABILITY, HOST_SUSPEND_CAPABILITY] },
  ]],
  ["hello: thread-resume block", [{ method: "hello", framework: NEW_HELLO.framework, sdkName: NEW_HELLO.sdkName, sdkVersion: NEW_HELLO.sdkVersion, capabilities: NEW_HELLO.capabilities, cliSession: BLOCK }]],
  // The emitter writes the caller's object in the caller's key order, and the Python emitter writes its dataclass in
  // DECLARATION order (protocol.ts). So every emit input here is built in declaration order: readError first, sessionIds
  // after lastPromptShas, as HelloStoredMeasures declares them.
  ["hello: thread-resume block with readError and sessionIds", [{ method: "hello", framework: "f", sdkName: null, sdkVersion: null, capabilities: [CLI_SESSION_CAPABILITY], cliSession: { ...BLOCK, stored: {
    readError: "link",
    systemPromptShas: STORED.systemPromptShas,
    walks: STORED.walks,
    lastPromptShas: STORED.lastPromptShas,
    sessionIds: [SESSION_ID],
    entries: STORED.entries,
    unclassified: STORED.unclassified,
    corrupt: STORED.corrupt,
    benignDuplicates: STORED.benignDuplicates,
    filePromptEntries: STORED.filePromptEntries,
    fileCompactSummaries: STORED.fileCompactSummaries,
  } } }]],
  ["hello: thread-resume block without stored", [{ method: "hello", framework: "f", sdkName: null, sdkVersion: null, cliSession: { ...IDS_OLD_BLOCK, stored: undefined } }]],
  ["a turn", [
    { method: "hello", framework: "openai-agents-sdk", sdkName: "@openai/agents", sdkVersion: "0.18.0", capabilities: [TOOL_GATES_CAPABILITY] },
    { method: "native", framework: "openai-agents-sdk", event: { type: "raw_model_stream_event", data: { delta: "Hi" } } },
    { method: "text", text: "Hi" },
    { method: "done", result: "Hi" },
  ]],
];

// ── suspend-writer ───────────────────────────────────────────────────────────────────────────────────────────────────

interface SuspendWrite {
  readonly envelope: string;
  readonly askIds: readonly string[];
}
const ofJsonBytes = (bytes: number): string => "a".repeat(bytes - 2);
const withOffer = (offer: object | string): string => inv({ suspend: offer });
const SUSPEND: readonly (readonly [string, string, readonly SuspendWrite[]])[] = [
  ["no offer: no writer", j(BASE), []],
  ["a malformed offer: no writer", withOffer({ maxEnvelopeBytes: 0 }), []],
  ["the cap: written at the cap, refused one byte over", withOffer({ maxEnvelopeBytes: 100 }), [
    { envelope: ofJsonBytes(101), askIds: ["approval_c"] },
    { envelope: ofJsonBytes(100), askIds: ["approval_c"] },
  ]],
  ["the cap counts escapes and UTF-8 bytes", withOffer({ maxEnvelopeBytes: 10 }), [
    { envelope: '"€ab', askIds: [] },
    { envelope: '"€€ab', askIds: [] },
  ]],
  ["a lone surrogate counts as its six-byte escape", withOffer({ maxEnvelopeBytes: 8 }), [
    { envelope: "\ud800", askIds: [] },
    { envelope: "\ud800a", askIds: [] },
  ]],
  ["an astral character counts four bytes", withOffer({ maxEnvelopeBytes: 6 }), [
    { envelope: "\u{1F600}", askIds: [] },
    { envelope: "\u{1F600}a", askIds: [] },
  ]],
  ["the offer never raises the protocol cap", withOffer({ maxEnvelopeBytes: SUSPEND_ENVELOPE_MAX_BYTES * 4 }), [{ envelope: "small", askIds: ["a"] }]],
  ["an offer of 1e300 is the protocol cap", `{"type":"invoke","input":"hi",${RAW_FS},"suspend":{"maxEnvelopeBytes":1e300}}`, [{ envelope: "e", askIds: [] }]],
  ["a JSON envelope round-trips", withOffer({ maxEnvelopeBytes: 1024 }), [
    { envelope: JSON.stringify({ runState: "é\n\"x\"" }), askIds: ["approval_a", "approval_b"] },
  ]],
];

function runSuspend(invokeLine: string, writes: readonly SuspendWrite[]): object {
  const invoke = parseControl(invokeLine);
  if (!isInvoke(invoke)) throw new Error("suspend case: not an invoke");
  let output = "";
  const writer = createSuspendWriter({ write: (s) => (output += s) }, invoke);
  if (writer === undefined) return { writer: false };
  const results = writes.map((w) => writer.suspend(w.envelope, w.askIds));
  return { writer: true, maxEnvelopeBytes: writer.maxEnvelopeBytes, results, output };
}

// ── lines ────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Chunk = { readonly hex: string } | { readonly text: string };
const bytes = (s: string): Chunk => ({ hex: Buffer.from(s, "utf8").toString("hex") });
const rawHex = (hex: string): Chunk => ({ hex });
const EURO_LINE = Buffer.from('{"type":"invoke","input":"5 €"}\n', "utf8");
const EURO_CUT = EURO_LINE.indexOf(0xe2) + 2;
const LINES: readonly (readonly [string, readonly Chunk[]])[] = [
  ["one line", [bytes('{"type":"shutdown"}\n')]],
  ["two lines in one chunk", [bytes("a\nb\n")]],
  ["CRLF endings trimmed", [bytes("a\r\nb\r\n")]],
  ["blank and whitespace-only lines skipped", [bytes("\n  \n\t\nx\n\n")]],
  ["a line split across chunks", [bytes('{"type":'), bytes('"shutdown"}\nnext'), bytes("\n")]],
  ["a 3-byte character split across chunks", [rawHex(EURO_LINE.subarray(0, EURO_CUT).toString("hex")), rawHex(EURO_LINE.subarray(EURO_CUT).toString("hex"))]],
  ["a split character in a tail with no newline", [rawHex(EURO_LINE.subarray(0, EURO_CUT).toString("hex")), rawHex(EURO_LINE.subarray(EURO_CUT, EURO_LINE.length - 1).toString("hex"))]],
  ["a 4-byte character split three ways", [rawHex("78f0"), rawHex("9f"), rawHex("98800a")]],
  ["a tail with no newline", [bytes("a\nb")]],
  ["JavaScript trim: no-break space, BOM, separators and ideographic space", [bytes(" ﻿ x   　 \n")]],
  ["JavaScript trim keeps U+001C..U+001F and NEL", [bytes("\u001cx\u0085\u001f\n")]],
  ["vertical tab and form feed trimmed", [bytes("\u000bx\u000c\n")]],
  ["a lone carriage return does not split", [bytes("a\rb\n")]],
  ["U+2028 inside a line does not split", [bytes("a b\n")]],
  ["a NUL inside a line is kept", [rawHex("6100620a")]],
  ["an invalid byte reads as U+FFFD", [rawHex("ff780a")]],
  ["an overlong encoding", [rawHex("c0af0a")]],
  ["an encoded surrogate", [rawHex("eda0800a")]],
  ["a truncated 4-byte sequence across chunks", [rawHex("f080"), rawHex("80410a")]],
  ["an incomplete character at the end of input", [rawHex("61e282")]],
  ["string chunks", [{ text: "a\nb" }, { text: "c\n" }]],
  ["no input", []],
  ["only newlines", [bytes("\n\n\n")]],
  ["a long line in many chunks", Array.from({ length: 30 }, () => bytes("z".repeat(100))).concat([bytes("\n")])],
];

async function readLines(chunks: readonly Chunk[]): Promise<string[]> {
  const out: string[] = [];
  const source = Readable.from(chunks.map((c) => ("hex" in c ? Buffer.from(c.hex, "hex") : c.text)));
  for await (const line of lines(source)) out.push(line);
  return out;
}

// ── launch-envelope ──────────────────────────────────────────────────────────────────────────────────────────────────

const PREV_RELEASE_ENVELOPE_LINE = `${j({ v: 1, model: { wire: "anthropic", token: "turn-scoped-test" } })}\n`;
const THREAD_TOKEN_LINE = `${j({ v: 1, model: { wire: "anthropic", token: "guuey_thr_test" } })}\n`;
const LAUNCH_PARSE: readonly (readonly [string, string])[] = [
  ["empty payload", ""],
  ["only a newline", "\n"],
  ["version only", '{"v":1}\n'],
  ["version only, no newline", '{"v":1}'],
  ["two newlines", '{"v":1}\n\n'],
  ["two lines", '{"v":1}\n{"v":1}\n'],
  ["a carriage return before the newline", '{"v":1}\r\n'],
  ["surrounding JSON whitespace", ' {"v":1} \n'],
  ["truncated", '{"v":1'],
  ["NaN", '{"v":NaN}'],
  ["an array", "[]\n"],
  ["null", "null\n"],
  ["version 2", '{"v":2}\n'],
  ["version as a string", '{"v":"1"}\n'],
  ["version true", '{"v":true}\n'],
  ["version 1.0", '{"v":1.0}\n'],
  ["version missing", "{}\n"],
  ["an unknown member", '{"v":1,"x":1}\n'],
  ["an unknown member before an unsupported version", '{"v":2,"x":1}\n'],
  ["model null", '{"v":1,"model":null}\n'],
  ["model an array", '{"v":1,"model":[]}\n'],
  ["model with an unknown member", j({ v: 1, model: { wire: "anthropic", token: "t", endpoint: "x" } }) + "\n"],
  ["model wire unsupported", j({ v: 1, model: { wire: "bedrock", token: "t" } }) + "\n"],
  ["model wire missing", j({ v: 1, model: { token: "t" } }) + "\n"],
  ["model token empty", j({ v: 1, model: { wire: "openai", token: "" } }) + "\n"],
  ["model token with a space", j({ v: 1, model: { wire: "openai", token: "a b" } }) + "\n"],
  ["model token with a trailing newline escape", j({ v: 1, model: { wire: "openai", token: "abc\n" } }) + "\n"],
  ["model token non-ASCII", j({ v: 1, model: { wire: "openai", token: "té" } }) + "\n"],
  ["model token a number", j({ v: 1, model: { wire: "openai", token: 7 } }) + "\n"],
  ["model token of 4096", j({ v: 1, model: { wire: "gemini", token: "t".repeat(4096) } }) + "\n"],
  ["model token of 4097", j({ v: 1, model: { wire: "gemini", token: "t".repeat(4097) } }) + "\n"],
  ["members in reverse order", j({ model: { token: "tok", wire: "openai" }, v: 1 }) + "\n"],
  ["prev: the 0.35.0 release line", PREV_RELEASE_ENVELOPE_LINE],
  ["prev: the thread-token line", THREAD_TOKEN_LINE],
];
const LAUNCH_ENCODE: readonly (readonly [string, LaunchEnvelope])[] = [
  ["encode: version only", { v: 1 }],
  ["encode: a model capability", { v: 1, model: { wire: "anthropic", token: "turn-scoped-test" } }],
  ["encode: a malformed token is refused", { v: 1, model: { wire: "openai", token: "has space" } }],
  ["encode: a non-ASCII token is refused", { v: 1, model: { wire: "openai", token: "\u{1F511}" } }],
];

// ── the small rules ──────────────────────────────────────────────────────────────────────────────────────────────────

const END_THREAD: readonly (readonly [string, EndThread])[] = [
  ["valid", { code: "CHAT_FULL", message: "This chat is full." }],
  ["code: one letter", { code: "X", message: "m" }],
  ["code: 40 characters", { code: "A".repeat(40), message: "m" }],
  ["code: 41 characters", { code: "A".repeat(41), message: "m" }],
  ["code: empty", { code: "", message: "m" }],
  ["code: leading digit", { code: "1A", message: "m" }],
  ["code: leading underscore", { code: "_A", message: "m" }],
  ["code: lower case", { code: "Chat", message: "m" }],
  ["code: trailing newline", { code: "A\n", message: "m" }],
  ["code: non-ASCII upper case", { code: "ÉT", message: "m" }],
  ["message: empty", { code: "X", message: "" }],
  ["message: 500 characters", { code: "X", message: "m".repeat(500) }],
  ["message: 501 characters", { code: "X", message: "m".repeat(501) }],
  ["message: 500 astral characters", { code: "X", message: "\u{1F600}".repeat(500) }],
  ["message: 501 astral characters", { code: "X", message: "\u{1F600}".repeat(501) }],
  ["message: a line feed", { code: "X", message: "a\nb" }],
  ["message: a carriage return", { code: "X", message: "a\rb" }],
  ["message: NUL", { code: "X", message: "\u0000" }],
  ["message: DEL", { code: "X", message: "\u007f" }],
  ["message: a C1 control", { code: "X", message: "\u009f" }],
  ["message: no-break space", { code: "X", message: " " }],
  ["message: a lone surrogate", { code: "X", message: "\ud800" }],
];

const CLIENT_CATALOGS: readonly (readonly [string, JsonValue])[] = [
  ["two ids", ["guuey.a2ui.v1", "guuey.json-render.v1"]],
  ["repeats dropped", ["a", "b", "a"]],
  ["bad entries dropped", ["ok", "", " ", "a b", "tab\t", 7, null, ["x"], "é", "ok2"]],
  ["every allowed character", ["AZaz09._~:/@+-"]],
  ["64 characters kept", ["x".repeat(64)]],
  ["65 characters dropped", ["x".repeat(65)]],
  ["a trailing newline dropped", ["a\n"]],
  ["capped at 16, repeats do not count", ["d", "d", ...Array.from({ length: 20 }, (_v, i) => `c${String(i)}`)]],
  ["bad entries do not count toward the cap", [...Array.from({ length: 5 }, () => "bad id"), ...Array.from({ length: 16 }, (_v, i) => `c${String(i)}`)]],
  ["none survive", ["bad id"]],
  ["empty", []],
  ["an object", { a2ui: true }],
  ["a string", "guuey.a2ui.v1"],
  ["null", null],
];

type ImageCase =
  | { readonly fn: "isStandardBase64"; readonly input: string }
  | { readonly fn: "isInvokeImageMimeType"; readonly input: JsonValue }
  | { readonly fn: "invokeImagesCapabilities"; readonly input: string };
const IMAGES: readonly (readonly [string, ImageCase])[] = [
  ["base64: padded", { fn: "isStandardBase64", input: "iVBORw0KGgo=" }],
  ["base64: two pads", { fn: "isStandardBase64", input: "UklGRg==" }],
  ["base64: no pad", { fn: "isStandardBase64", input: "abcd" }],
  ["base64: empty", { fn: "isStandardBase64", input: "" }],
  ["base64: not a multiple of 4", { fn: "isStandardBase64", input: "abc" }],
  ["base64: three pads", { fn: "isStandardBase64", input: "a===" }],
  ["base64: pad in the middle", { fn: "isStandardBase64", input: "ab=c" }],
  ["base64: URL alphabet", { fn: "isStandardBase64", input: "ab-_" }],
  ["base64: trailing newline", { fn: "isStandardBase64", input: "abc\n" }],
  ["base64: line break inside", { fn: "isStandardBase64", input: "ab\ncdefg" }],
  ["base64: non-ASCII", { fn: "isStandardBase64", input: "abé=" }],
  ["mime: png", { fn: "isInvokeImageMimeType", input: "image/png" }],
  ["mime: jpeg", { fn: "isInvokeImageMimeType", input: "image/jpeg" }],
  ["mime: svg", { fn: "isInvokeImageMimeType", input: "image/svg+xml" }],
  ["mime: upper case", { fn: "isInvokeImageMimeType", input: "IMAGE/PNG" }],
  ["mime: a number", { fn: "isInvokeImageMimeType", input: 1 }],
  ["mime: null", { fn: "isInvokeImageMimeType", input: null }],
  ["capabilities: with images", { fn: "invokeImagesCapabilities", input: inv({ attachments: [{ kind: "inline", mimeType: "image/png", data: "iVBORw0KGgo=" }] }) }],
  ["capabilities: without images", { fn: "invokeImagesCapabilities", input: j(BASE) }],
  ["capabilities: malformed images read as none", { fn: "invokeImagesCapabilities", input: inv({ attachments: [{ kind: "inline", mimeType: "image/png", data: "" }] }) }],
];

function runImage(c: ImageCase): Outcome<boolean | string[]> {
  switch (c.fn) {
    case "isStandardBase64":
      return outcome(() => isStandardBase64(c.input));
    case "isInvokeImageMimeType":
      return outcome(() => isInvokeImageMimeType(c.input));
    case "invokeImagesCapabilities":
      return outcome(() => {
        const invoke = parseControl(c.input);
        if (!isInvoke(invoke)) throw new Error("images case: not an invoke");
        return invokeImagesCapabilities(invoke);
      });
  }
}

type InputKindCase =
  | { readonly fn: "isInputKind"; readonly input: JsonValue }
  | { readonly fn: "inputKindCapability"; readonly input: InputKind };
const INPUT_KIND: readonly (readonly [string, InputKindCase])[] = [
  ["known", { fn: "isInputKind", input: "context-only" }],
  ["unknown", { fn: "isInputKind", input: "telepathy" }],
  ["upper case", { fn: "isInputKind", input: "CONTEXT-ONLY" }],
  ["a number", { fn: "isInputKind", input: 7 }],
  ["null", { fn: "isInputKind", input: null }],
  ["a list holding the kind", { fn: "isInputKind", input: ["context-only"] }],
  ["capability", { fn: "inputKindCapability", input: "context-only" }],
];

function runInputKind(c: InputKindCase): Outcome<boolean | string> {
  switch (c.fn) {
    case "isInputKind":
      return outcome(() => isInputKind(c.input));
    case "inputKindCapability":
      return outcome(() => inputKindCapability(c.input));
  }
}

const MODEL_TEXT: readonly (readonly [string, { readonly text: string; readonly inputKind?: InputKind }])[] = [
  ["no kind", { text: "hello" }],
  ["no kind, empty text", { text: "" }],
  ["context-only, empty text", { text: "", inputKind: "context-only" }],
  ["context-only, whitespace only", { text: " \n\t ", inputKind: "context-only" }],
  ["context-only, JavaScript whitespace only", { text: " ﻿ 　", inputKind: "context-only" }],
  ["context-only, U+001C is not whitespace", { text: "\u001c", inputKind: "context-only" }],
  ["context-only, NEL is not whitespace", { text: "\u0085", inputKind: "context-only" }],
  ["context-only, framed page context", { text: "<page_context>a photo</page_context>", inputKind: "context-only" }],
];

const CLI_COMPARE: readonly (readonly [string, CliSessionRecord, HelloStoredMeasures])[] = [
  ["accepted", { id: SESSION_ID, lastPromptSha: SHA }, { ...STORED, sessionIds: [SESSION_ID, SESSION_ID] }],
  ["unreadable", { id: SESSION_ID, lastPromptSha: SHA }, { ...STORED, readError: "not-regular", sessionIds: [SESSION_ID] }],
  ["corrupt", { id: SESSION_ID, lastPromptSha: SHA }, { ...STORED, corrupt: 1, unclassified: 1, sessionIds: [SESSION_ID] }],
  ["unclassified", { id: SESSION_ID, lastPromptSha: SHA }, { ...STORED, unclassified: 2, sessionIds: [SESSION_ID] }],
  ["no session ids", { id: SESSION_ID, lastPromptSha: SHA }, STORED],
  ["empty session ids", { id: SESSION_ID, lastPromptSha: SHA }, { ...STORED, sessionIds: [] }],
  ["other session", { id: SESSION_ID, lastPromptSha: SHA }, { ...STORED, sessionIds: [SESSION_ID, "other"] }],
  ["no last prompt", { id: SESSION_ID, lastPromptSha: SHA }, { ...STORED, lastPromptShas: [], sessionIds: [SESSION_ID] }],
  ["last prompt differs", { id: SESSION_ID, lastPromptSha: "b".repeat(64) }, { ...STORED, sessionIds: [SESSION_ID] }],
  ["only the LAST last prompt counts", { id: SESSION_ID, lastPromptSha: "b".repeat(64) }, { ...STORED, lastPromptShas: ["b".repeat(64), SHA], sessionIds: [SESSION_ID] }],
];

const MCP_CUSTOM_DATA: readonly (readonly [string, McpToolCustomDataContext])[] = [
  ["both", { structuredContent: { surface: { id: "s" }, cache: { hit: true } }, resultMeta: { ui: { resourceUri: "ui://card" } } }],
  ["structuredContent only", { structuredContent: { a: 1 } }],
  ["resultMeta only", { resultMeta: { b: 2 } }],
  ["empty objects kept", { structuredContent: {}, resultMeta: {} }],
  ["neither", {}],
];

const CONSTANTS = {
  PROTOCOL_VERSION,
  ADK_HOST_COMPLETION_CAPABILITY,
  HOST_SUSPEND_CAPABILITY,
  TOOL_GATES_CAPABILITY,
  CLI_SESSION_CAPABILITY,
  CLI_SESSION_HASH_VERSION,
  CLI_SESSION_RESUME_FAILED,
  SDK_SESSION_CAPABILITY,
  SDK_SESSION_HASH_VERSION,
  SDK_SESSION_PROMPT_SHAS_MAX,
  SDK_SESSION_IDS_MAX,
  INVOKE_IMAGES_CAPABILITY,
  INVOKE_IMAGE_MIME_TYPES,
  SUSPEND_ENVELOPE_MAX_BYTES,
  INPUT_KINDS,
  CLIENT_CATALOGS_MAX,
  CLIENT_CATALOG_ID_MAX_CHARS,
  CLIENT_CATALOG_ID_PATTERN: CLIENT_CATALOG_ID_PATTERN.source,
  END_THREAD_CODE_PATTERN: END_THREAD_CODE_PATTERN.source,
  END_THREAD_MESSAGE_MAX_CHARS,
  CONTEXT_ONLY_TURN_TEXT,
  MODEL_TEXT_INPUT_KIND_CAPABILITIES,
  LAUNCH_ENVELOPE_FD_ENV,
  LAUNCH_ENVELOPE_FD,
  LAUNCH_ENVELOPE_VERSION,
  LAUNCH_ENVELOPE_MAX_BYTES,
  LAUNCH_ENVELOPE_DEADLINE_MS,
};

// ── the files ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("worker protocol golden corpus for the Python port", () => {
  it("parse-control.json", async () => {
    await writeGolden("parse-control.json", PARSE_CONTROL.map(([name, input]) => ({ name, input, expected: outcome(() => parseControl(input)) })));
  });

  it("read-event.json", async () => {
    await writeGolden("read-event.json", [...READ_EVENT, ...READ_EVENT_SDK_SESSION].map(([name, input]) => ({ name, input, expected: outcome(() => readEvent(input)) })));
  });

  it("emit.json", async () => {
    await writeGolden("emit.json", EMIT.map(([name, calls]) => ({ name, calls, expected: emitAll(calls) })));
  });

  it("suspend-writer.json", async () => {
    await writeGolden("suspend-writer.json", SUSPEND.map(([name, invoke, writes]) => ({ name, invoke, writes, expected: runSuspend(invoke, writes) })));
  });

  it("lines.json", async () => {
    const results: { name: string; chunks: readonly Chunk[]; expected: string[] }[] = [];
    for (const [name, chunks] of LINES) results.push({ name, chunks, expected: await readLines(chunks) });
    await writeGolden("lines.json", results);
  });

  it("launch-envelope.json", async () => {
    await writeGolden("launch-envelope.json", [
      ...LAUNCH_PARSE.map(([name, input]) => ({ name, op: "parse", input, expected: outcome(() => parseLaunchEnvelope(input)) })),
      ...LAUNCH_ENCODE.map(([name, input]) => ({ name, op: "encode", input, expected: outcome(() => encodeLaunchEnvelope(input).toString("utf8")) })),
    ]);
  });

  it("end-thread.json", async () => {
    await writeGolden("end-thread.json", END_THREAD.map(([name, input]) => ({ name, input, expected: outcome(() => endThreadProblem(input)) })));
  });

  it("client-catalogs.json", async () => {
    await writeGolden("client-catalogs.json", CLIENT_CATALOGS.map(([name, input]) => ({ name, input, expected: outcome(() => parseClientCatalogs(input)) })));
  });

  it("images.json", async () => {
    await writeGolden("images.json", IMAGES.map(([name, input]) => ({ name, ...input, expected: runImage(input) })));
  });

  it("input-kinds.json", async () => {
    await writeGolden("input-kinds.json", INPUT_KIND.map(([name, input]) => ({ name, ...input, expected: runInputKind(input) })));
  });

  it("model-text.json", async () => {
    await writeGolden("model-text.json", MODEL_TEXT.map(([name, input]) => ({ name, input, expected: outcome(() => modelTextOf(input)) })));
  });

  it("cli-session-compare.json", async () => {
    await writeGolden("cli-session-compare.json", CLI_COMPARE.map(([name, record, stored]) => ({ name, record, stored, expected: outcome(() => compareStoredSession(record, stored)) })));
  });

  it("mcp-custom-data.json", async () => {
    await writeGolden("mcp-custom-data.json", MCP_CUSTOM_DATA.map(([name, context]) => ({ name, context, expected: outcome(() => mcpToolCustomData(context)) })));
  });

  it("constants.json", async () => {
    await writeGolden("constants.json", CONSTANTS);
  });
});
