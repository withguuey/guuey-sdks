/**
 * guuey#2381 — the §6 bounds as one table, and the two measuring helpers every
 * check uses. Each bound's at-the-bound and over-the-bound behaviour is
 * pinned where it bites (validate.test.ts, fold.test.ts, plan.a2ui.test.ts).
 */
import { describe, expect, it } from "vitest";
import { A2UI_CARRIER_MAX_UNITS } from "@guuey/mcp-apps-host/narrowing";
import { A2UI_LIMITS, jsonUnits, truncateUnits } from "./limits.js";

describe("A2UI_LIMITS (spec §6)", () => {
  it("pins every bound", () => {
    expect(A2UI_LIMITS).toEqual({
      carrierUnits: 16_384,
      messagesPerCarrier: 32,
      surfacesPerCarrier: 4,
      componentsPerSurface: 200,
      treeDepth: 12,
      childrenPerContainer: 50,
      listItems: 100,
      textUnits: 4_000,
      labelUnits: 200,
      choiceOptions: 50,
      urlUnits: 2_048,
      dataModelUnits: 8_192,
      dataPathDepth: 8,
      dataPathSegmentUnits: 64,
      actionContextKeys: 32,
      actionPayloadUnits: 4_096,
      itemsPerTranscript: 64,
      textFieldMaxLength: 4_000,
    });
  });

  it("the carrier bound is the carrier reader's own, one number", () => {
    expect(A2UI_LIMITS.carrierUnits).toBe(A2UI_CARRIER_MAX_UNITS);
  });
});

describe("jsonUnits", () => {
  it("counts UTF-16 code units of the JSON text", () => {
    expect(jsonUnits({ a: "b" })).toBe(9);
    expect(jsonUnits("😀")).toBe(4);
  });
});

describe("truncateUnits", () => {
  it("leaves a string at the bound alone", () => {
    expect(truncateUnits("abcd", 4)).toEqual({ text: "abcd", truncated: false });
  });

  it("cuts a string over the bound to the bound, the last unit an ellipsis", () => {
    expect(truncateUnits("abcde", 4)).toEqual({ text: "abc…", truncated: true });
  });

  it("never splits a surrogate pair", () => {
    // "ab😀" is 4 units; cut to 3 keeps "ab" + ellipsis, not half the emoji.
    const out = truncateUnits("ab😀c", 4);
    expect(out).toEqual({ text: "ab…", truncated: true });
    expect(out.text.length).toBeLessThanOrEqual(4);
  });
});
