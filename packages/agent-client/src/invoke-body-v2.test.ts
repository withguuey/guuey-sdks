import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGJSON_VERSION, checkAgInput } from "@silverprotocol/core";
import { buildInvokeBodyV2, isRequestShapeRefusal } from "./invoke-body-v2.js";
import { AGENT_ERROR_CODES } from "./error-codes.js";
import { AgentResponseError } from "./errors.js";
import { INVOKE_BODY_V2_CASES } from "./fixtures/invoke-body-v2-cases.js";

/**
 * Request shape 2 (W6): the body is ONE silverprotocol `AgInput` start arm, and silverprotocol's own receiver check
 * accepts it. Every body this client has released lives in `fixtures/agjson-corpus/` (one file per release, appended,
 * never edited); `next.json` is the set the next release adds, pinned here to the builder.
 */
const CORPUS = new URL("./fixtures/agjson-corpus/", import.meta.url);

/** silverprotocol's receiver check accepts the body whole. */
function expectAccepted(body: unknown): void {
  const check = checkAgInput(body);
  expect(check.ok ? "ok" : `${check.code} at ${JSON.stringify(check.path)}`).toBe("ok");
}

describe("buildInvokeBodyV2 — the exact bodies", () => {
  it("a text turn: one user message whose id is the turn id, one text block, nothing else", () => {
    const body = buildInvokeBodyV2({ text: "ping", threadId: "thr_1", clientMessageId: "cm_1" });
    expect(body).toEqual({
      protocol: "agjson",
      version: AGJSON_VERSION,
      threadId: "thr_1",
      turnId: "cm_1",
      kind: "start",
      messages: [{ id: "cm_1", role: "user", content: [{ type: "text", text: "ping" }] }],
    });
    expect(Object.keys(body)).toEqual(["protocol", "version", "threadId", "turnId", "kind", "messages"]);
    expectAccepted(body);
  });

  it("a context-only turn: content [] and the kind in the guuey metadata", () => {
    const body = buildInvokeBodyV2({ text: "", threadId: "thr_1", clientMessageId: "cm_2", inputKind: "context-only" });
    expect(body).toEqual({
      protocol: "agjson",
      version: AGJSON_VERSION,
      threadId: "thr_1",
      turnId: "cm_2",
      metadata: { "guuey/inputKind": "context-only" },
      kind: "start",
      messages: [{ id: "cm_2", role: "user", content: [] }],
    });
    expectAccepted(body);
    // Beside words the words are the turn: no kind.
    expect(buildInvokeBodyV2({ text: "hi", clientMessageId: "c", inputKind: "context-only" })).not.toHaveProperty("metadata");
  });

  it("first contact: threadId \"\" whether the thread is absent or null", () => {
    const absent = buildInvokeBodyV2({ text: "Hello", clientMessageId: "cm_3" });
    const none = buildInvokeBodyV2({ text: "Hello", threadId: null, clientMessageId: "cm_3" });
    expect(absent).toEqual({
      protocol: "agjson",
      version: AGJSON_VERSION,
      threadId: "",
      turnId: "cm_3",
      kind: "start",
      messages: [{ id: "cm_3", role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    expect(none).toEqual(absent);
    expectAccepted(absent);
  });

  it("parts and turn context: the parts after the words, the context as run.context, the guuey keys as metadata", () => {
    const image = { type: "image" as const, source: { type: "base64" as const, mediaType: "image/png", data: "iVBORw0KGgo=" } };
    const doc = { type: "document" as const, source: { type: "file" as const, fileId: "upl_1" }, title: "Terms" };
    const context = { type: "text" as const, text: "The visitor is on the Pro plan." };
    const body = buildInvokeBodyV2({
      text: "compare",
      threadId: "thr_1",
      clientMessageId: "cm_4",
      parts: [image, doc],
      turnContext: [context],
      capabilities: { hitl: { ask: true, grantModes: true } },
      pageContext: { path: "/p", hostOrigin: "https://h.example" },
      mode: "rep",
      tapLabels: ["Compare", null],
    });
    expect(body).toEqual({
      protocol: "agjson",
      version: AGJSON_VERSION,
      threadId: "thr_1",
      turnId: "cm_4",
      capabilities: { hitl: { ask: true, grantModes: true } },
      metadata: {
        "guuey/pageContext": { path: "/p", hostOrigin: "https://h.example" },
        "guuey/mode": "rep",
        "guuey/tapLabels": ["Compare", null],
      },
      kind: "start",
      messages: [{ id: "cm_4", role: "user", content: [{ type: "text", text: "compare" }, image, doc] }],
      run: { context: [context] },
    });
    expectAccepted(body);
    // An empty context is the same as none.
    expect(buildInvokeBodyV2({ text: "hi", clientMessageId: "c", turnContext: [] })).not.toHaveProperty("run");
  });
});

describe("the shape-2 corpus (W6)", () => {
  it("next.json equals the builder's output for every canonical case", () => {
    const onDisk: unknown = JSON.parse(readFileSync(new URL("next.json", CORPUS), "utf8"));
    expect(onDisk).toEqual(INVOKE_BODY_V2_CASES.map((c) => buildInvokeBodyV2(c.input)));
  });

  it("every canonical case passes silverprotocol's receiver check", () => {
    for (const c of INVOKE_BODY_V2_CASES) expectAccepted(buildInvokeBodyV2(c.input));
  });

  it("every body in every corpus file still passes the receiver check (a released body is never refused)", () => {
    const files = readdirSync(CORPUS).filter((name) => name.endsWith(".json"));
    expect(files).toContain("next.json");
    for (const file of files) {
      const bodies: unknown = JSON.parse(readFileSync(new URL(file, CORPUS), "utf8"));
      expect(Array.isArray(bodies)).toBe(true);
      if (Array.isArray(bodies)) for (const body of bodies) expectAccepted(body);
    }
  });
});

describe("isRequestShapeRefusal — an older runtime's refusal of a shape-2 body (W1)", () => {
  it("is a 400 INVALID_REQUEST whose message is EXACTLY the released runtimes' sentence", () => {
    expect(isRequestShapeRefusal(new AgentResponseError("input: non-empty string required", 400, AGENT_ERROR_CODES.INVALID_REQUEST))).toBe(true);
  });

  it("cto's M3 RED: another `input: …` refusal of a shape-1 field never falls back (no re-send on a real refusal)", () => {
    for (const message of ["input: exceeds 32768 bytes", "input: must be a string", "input: non-empty string required.", " input: non-empty string required"]) {
      expect(isRequestShapeRefusal(new AgentResponseError(message, 400, AGENT_ERROR_CODES.INVALID_REQUEST))).toBe(false);
    }
  });

  it("is nothing else: another field, another code, another status, or no coded refusal at all", () => {
    const pageContext = new AgentResponseError("pageContext: path must be a string", 400, AGENT_ERROR_CODES.INVALID_REQUEST);
    const inputKind = new AgentResponseError("inputKind: context-only is not accepted by this agent yet; send text", 400, AGENT_ERROR_CODES.INVALID_REQUEST);
    const otherCode = new AgentResponseError("input: too large", 400, "ATTACHMENTS_INVALID");
    const otherStatus = new AgentResponseError("input: non-empty string required", 422, AGENT_ERROR_CODES.INVALID_REQUEST);
    for (const e of [pageContext, inputKind, otherCode, otherStatus, new Error("input: x"), "input: x", null]) {
      expect(isRequestShapeRefusal(e)).toBe(false);
    }
  });
});
