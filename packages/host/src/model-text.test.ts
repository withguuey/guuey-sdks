/**
 * guuey#2549 — one substitution for a context-only turn, the same on the current turn and in the
 * history the model reads on every later turn (cto's replay-parity condition).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { inputKindCapability } from "@guuey/worker";
import { CONTEXT_ONLY_TURN_TEXT, HOST_INPUT_KIND_CAPABILITIES, modelInputOf, modelTextOf } from "./model-text.js";
import { withContextPreamble } from "./preamble.js";

afterEach(() => vi.restoreAllMocks());

describe("modelTextOf / modelInputOf", () => {
  it("an ordinary turn's text is untouched, kind or not", () => {
    expect(modelTextOf({ text: "hello" })).toBe("hello");
    // The kind is a hint, not a constraint: text that is present wins.
    expect(modelTextOf({ text: "what is this?", inputKind: "context-only" })).toBe("what is this?");
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

  it("the host declares exactly the capability the worker protocol names", () => {
    expect(HOST_INPUT_KIND_CAPABILITIES).toEqual([inputKindCapability("context-only")]);
  });
});

describe("replay parity (cto RED)", () => {
  it("the current turn's model text equals what the history preamble replays for that stored turn", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const now = modelInputOf({ input: "", inputKind: "context-only" });
    const later = withContextPreamble("SYSTEM", [{ role: "user", text: "", inputKind: "context-only" }], undefined, undefined);
    expect(later).toContain(`: ${now}`);
    // And no empty user line is ever replayed for it.
    expect(later).not.toMatch(/: \n/);
  });
});
