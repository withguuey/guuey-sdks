import { describe, expect, it } from "vitest";
import { structurallyEqual } from "./structural-identity.js";

describe("structurallyEqual", () => {
  it("treats separately-minted equal literals as equal (the inline-prop shape)", () => {
    expect(
      structurallyEqual(
        { view: { timeoutMs: 8000, presentation: "chips" } },
        { view: { timeoutMs: 8000, presentation: "chips" } },
      ),
    ).toBe(true);
  });

  it("sees value differences at any depth", () => {
    expect(
      structurallyEqual(
        { view: { timeoutMs: 8000, presentation: "chips" } },
        { view: { timeoutMs: 8000, presentation: "inline" } },
      ),
    ).toBe(false);
    expect(structurallyEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(structurallyEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("compares arrays elementwise", () => {
    expect(structurallyEqual([1, "x", { k: true }], [1, "x", { k: true }])).toBe(true);
    expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("compares functions by reference — a fresh closure churns, a hoisted one holds", () => {
    const hoisted = (): string => "t";
    expect(structurallyEqual({ humanizeTitle: hoisted }, { humanizeTitle: hoisted })).toBe(true);
    expect(
      structurallyEqual({ humanizeTitle: () => "t" }, { humanizeTitle: () => "t" }),
    ).toBe(false);
  });

  it("never treats undefined/null/primitive mixes as equal objects", () => {
    expect(structurallyEqual(undefined, undefined)).toBe(true);
    expect(structurallyEqual(undefined, {})).toBe(false);
    expect(structurallyEqual(null, {})).toBe(false);
    expect(structurallyEqual(NaN, NaN)).toBe(true);
  });
});
