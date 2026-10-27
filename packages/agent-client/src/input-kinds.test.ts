import { describe, expect, it } from "vitest";
import { INPUT_KINDS, isInputKind, isInputKindRefusal, readAcceptedInputKinds } from "./input-kinds.js";

describe("input kinds (guuey#2549)", () => {
  it("knows exactly the context-only kind", () => {
    expect([...INPUT_KINDS]).toEqual(["context-only"]);
    expect(isInputKind("context-only")).toBe(true);
    expect(isInputKind("telepathy")).toBe(false);
    expect(isInputKind(undefined)).toBe(false);
  });

  it("reads a session frame's offer: known kinds once, in order; anything malformed is no offer", () => {
    expect(readAcceptedInputKinds({ threadId: "t", accepts: { inputKinds: ["context-only"] } })).toEqual(["context-only"]);
    expect(readAcceptedInputKinds({ accepts: { inputKinds: ["telepathy", "context-only", "context-only"] } })).toEqual(["context-only"]);
    expect(readAcceptedInputKinds({ threadId: "t" })).toEqual([]);
    expect(readAcceptedInputKinds({ accepts: { inputKinds: "context-only" } })).toEqual([]);
    expect(readAcceptedInputKinds({ accepts: ["context-only"] })).toEqual([]);
    expect(readAcceptedInputKinds({ accepts: null })).toEqual([]);
    expect(readAcceptedInputKinds(null)).toEqual([]);
  });

  it("recognises both runtimes' refusal of a turn without text, and nothing else", () => {
    expect(isInputKindRefusal("input: non-empty string required")).toBe(true);
    expect(isInputKindRefusal("inputKind: context-only is not accepted by this agent yet; send text")).toBe(true);
    expect(isInputKindRefusal("pageContext: too large")).toBe(false);
    expect(isInputKindRefusal("inputKind: unknown kind")).toBe(false);
    expect(isInputKindRefusal("x input: non-empty string required")).toBe(false);
  });
});
