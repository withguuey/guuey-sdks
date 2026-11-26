import { AGJSON_VERSION } from "@silverprotocol/core";
import { describe, expect, it } from "vitest";
import { DevShape2Refused, SHAPE1_ONLY_MEMBERS, invokeShapeOf, parseDevShape2 } from "./invoke-shape2.js";

const start = (extra: object = {}, content: object[] = [{ type: "text", text: "hello" }]) => ({
  protocol: "agjson",
  version: AGJSON_VERSION,
  kind: "start",
  threadId: "",
  turnId: "m1",
  messages: [{ id: "m1", role: "user", content }],
  ...extra,
});
const refusal = (body: object): string => {
  try {
    parseDevShape2(body);
  } catch (err) {
    if (err instanceof DevShape2Refused) return err.message;
    throw err;
  }
  throw new Error("not refused");
};

describe("detection: the Router's §1.1 table, own members only", () => {
  it("protocol alone is shape 2, input alone is shape 1, both is ambiguous, neither is neither", () => {
    expect(invokeShapeOf({ protocol: "agjson" })).toBe("shape2");
    expect(invokeShapeOf({ protocol: "other" })).toBe("shape2");
    expect(invokeShapeOf({ input: "hi" })).toBe("shape1");
    expect(invokeShapeOf({ input: "hi", protocol: "agjson" })).toBe("ambiguous");
    expect(invokeShapeOf({ messages: [] })).toBe("neither");
    expect(invokeShapeOf(Object.create({ protocol: "agjson" }) as object)).toBe("neither");
  });
});

describe("a start body: what the local turn gets", () => {
  it("the text blocks joined by a blank line, and the session id from metadata", () => {
    const body = start({ metadata: { "guuey/sessionId": "s-1", "other/key": 1 } }, [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ]);
    expect(parseDevShape2(body)).toEqual({ input: "line one\n\nline two", sessionId: "s-1", notDelivered: 0, resume: false });
  });
  it("counts every non-text block and the run context as not delivered locally, never refusing by kind", () => {
    const body = start({ run: { context: [{ type: "text", text: "ctx" }] } }, [
      { type: "image", source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" } },
      { type: "audio", source: { type: "base64", mediaType: "audio/wav", data: "UklGRg==" } },
      { type: "file", source: { type: "file", fileId: "agent-a/t/f1" } },
      { type: "text", text: "listen" },
    ]);
    expect(parseDevShape2(body)).toEqual({ input: "listen", sessionId: undefined, notDelivered: 4, resume: false });
  });
  it("a resume is an empty turn text, as the shape-1 dev path reads one", () => {
    const body = {
      protocol: "agjson",
      version: AGJSON_VERSION,
      kind: "resume",
      threadId: "t",
      turnId: "r1",
      answers: [{ askId: "a1", status: "resolved" }],
    };
    expect(parseDevShape2(body)).toEqual({ input: "", sessionId: undefined, notDelivered: 0, resume: true });
  });
});

describe("the refusals carry the Router's prefixes (W1: never the fallback face)", () => {
  const cases: Array<[string, object, string]> = [
    ["the protocol's own check", start({ version: "9.0.0" }), "agjson: version: major-mismatch"],
    ["an unlisted block type", start({}, [{ type: "video" }]), "agjson: messages.0.content.0.type: unknown-value"],
    ["tool-result", { protocol: "agjson", version: AGJSON_VERSION, kind: "tool-result", threadId: "t", turnId: "x", results: [] }, "input_kind_unsupported: tool-result"],
    ["two messages", start({ messages: [{ id: "m1", role: "user", content: [] }, { id: "m2", role: "user", content: [] }] }), "messages: exactly one user message"],
    ["an assistant message", start({ messages: [{ id: "m1", role: "assistant", content: [] }] }), "messages: exactly one user message"],
    ["turnId mismatch", start({ turnId: "other" }), "turnId: must equal messages[0].id"],
    ["a session id that is not a string", start({ metadata: { "guuey/sessionId": 5 } }), "sessionId: non-empty string required when provided"],
    ["an empty session id", start({ metadata: { "guuey/sessionId": "" } }), "sessionId: non-empty string required when provided"],
    ["an empty resume", { protocol: "agjson", version: AGJSON_VERSION, kind: "resume", threadId: "t", turnId: "r", answers: [] }, "resume.answers: 1..32 answers required"],
  ];
  for (const [name, body, message] of cases) {
    it(name, () => expect(refusal(body)).toBe(message));
  }
  it("every shape-1-only member in a shape-2 body is ambiguous by name", () => {
    for (const name of SHAPE1_ONLY_MEMBERS) {
      expect(refusal(start({ [name]: "x" }))).toBe(`invoke_shape_ambiguous: ${name}`);
    }
  });
  it("no refusal ever starts with `input:` (the fallback trigger)", () => {
    for (const [, body] of cases) expect(refusal(body).startsWith("input:")).toBe(false);
    for (const name of SHAPE1_ONLY_MEMBERS) expect(refusal(start({ [name]: "x" })).startsWith("input:")).toBe(false);
  });
});
