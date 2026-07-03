import { describe, it, expect } from "vitest";
import { makeNormalizer } from "./normalize.js";

describe("makeNormalizer", () => {
  it("returns a push/flush-able Normalizer for claude-agent-sdk", () => {
    const n = makeNormalizer("claude-agent-sdk");
    expect(typeof n.push).toBe("function");
    expect(typeof n.flush).toBe("function");
  });

  it("returns a push/flush-able Normalizer for openai-agents-sdk", () => {
    const n = makeNormalizer("openai-agents-sdk");
    expect(typeof n.push).toBe("function");
    expect(typeof n.flush).toBe("function");
  });

  it("throws AGJSON_NO_NORMALIZER:<framework> for an unknown framework", () => {
    expect(() => makeNormalizer("google-adk")).toThrow("AGJSON_NO_NORMALIZER:google-adk");
  });
});
