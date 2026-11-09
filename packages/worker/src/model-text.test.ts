/**
 * guuey#2549 — one substitution for a context-only turn, shared by `@guuey/host` and every
 * `serveNative` worker that declares {@link MODEL_TEXT_INPUT_KIND_CAPABILITIES}.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { inputKindCapability } from "./protocol.js";
import { CONTEXT_ONLY_TURN_TEXT, MODEL_TEXT_INPUT_KIND_CAPABILITIES, modelInputOf, modelTextOf } from "./model-text.js";

afterEach(() => vi.restoreAllMocks());

describe("modelTextOf / modelInputOf", () => {
  it("an ordinary turn's text is untouched", () => {
    expect(modelTextOf({ text: "hello" })).toBe("hello");
  });

  it("a context-only turn keeps the Router's page-context frame and adds the sentence after it", () => {
    const framed = "<page_context nonce=x>a photo</page_context>\n\n";
    expect(modelTextOf({ text: framed, inputKind: "context-only" })).toBe(`${framed}\n\n${CONTEXT_ONLY_TURN_TEXT}`);
  });

  it("an empty context-only turn reads the one fixed sentence, never an empty string", () => {
    expect(modelTextOf({ text: "", inputKind: "context-only" })).toBe(CONTEXT_ONLY_TURN_TEXT);
    expect(modelTextOf({ text: "  ", inputKind: "context-only" })).toBe(CONTEXT_ONLY_TURN_TEXT);
    expect(CONTEXT_ONLY_TURN_TEXT.trim().length).toBeGreaterThan(0);
  });

  it("an empty turn WITHOUT a kind is not invented into a sentence", () => {
    expect(modelTextOf({ text: "" })).toBe("");
  });

  it("the substitution is logged as metadata only (the kind, never text)", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    expect(modelInputOf({ input: "", inputKind: "context-only" })).toBe(CONTEXT_ONLY_TURN_TEXT);
    expect(modelInputOf({ input: "typed words" })).toBe("typed words");
    expect(writes).toEqual(["[guuey] input substituted: kind=context-only\n"]);
  });

  it("the declared capabilities are exactly the kinds modelTextOf handles, by the protocol's own name", () => {
    expect(MODEL_TEXT_INPUT_KIND_CAPABILITIES).toEqual([inputKindCapability("context-only")]);
  });
});
