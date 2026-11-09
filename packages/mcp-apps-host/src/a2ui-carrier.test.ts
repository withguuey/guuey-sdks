/**
 * guuey#2381 — the A2UI carrier reader: marker extraction and the byte bound
 * only, never the schema (that is `@guuey/chat/a2ui`'s validator).
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { A2UI_CARRIER_KEY, A2UI_CARRIER_MAX_UNITS, a2uiCarrierUnits, readA2uiCarrier } from "./narrowing.js";
import { toolResultViewMount } from "./card-mount.js";

const carrier: JsonValue = {
  format: "a2ui",
  version: "v0.9",
  messages: [{ version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "guuey.a2ui.v1" } }],
};

/** A carrier whose JSON is exactly `units` UTF-16 code units long. */
function carrierOfUnits(units: number): JsonValue {
  const empty = a2uiCarrierUnits({ pad: "" });
  return { pad: "x".repeat(units - empty) };
}

describe("readA2uiCarrier", () => {
  it("the marker key is com.guuey/a2ui and the bound is the planner's giant threshold", () => {
    expect(A2UI_CARRIER_KEY).toBe("com.guuey/a2ui");
    expect(A2UI_CARRIER_MAX_UNITS).toBe(16_384);
  });

  it("reads the marker's value from structuredContent, beside other keys", () => {
    expect(readA2uiCarrier({ structuredContent: { other: 1, [A2UI_CARRIER_KEY]: carrier } })).toEqual({
      kind: "carrier",
      carrier,
      via: "structuredContent",
      units: a2uiCarrierUnits(carrier),
    });
  });

  it("no marker, a non-object structuredContent, or nothing at all is not a carrier", () => {
    expect(readA2uiCarrier({})).toBeUndefined();
    expect(readA2uiCarrier({ structuredContent: { a2ui: carrier } })).toBeUndefined();
    expect(readA2uiCarrier({ structuredContent: [carrier] })).toBeUndefined();
    expect(readA2uiCarrier({ structuredContent: "com.guuey/a2ui" })).toBeUndefined();
    expect(readA2uiCarrier({ structuredContent: null })).toBeUndefined();
    // The persistence elision marker is not the carrier.
    expect(readA2uiCarrier({ structuredContent: { "com.guuey/elided": { bytes: 9 } } })).toBeUndefined();
  });

  it("reads a plain-object uiData holding the marker (a stamped _meta.ui moves structuredContent there)", () => {
    const block = { uiData: { [A2UI_CARRIER_KEY]: carrier } };
    expect(readA2uiCarrier(block)).toMatchObject({ kind: "carrier", carrier, via: "uiData" });
    // ...which never mounts: it carries no uri, no text, no ui:// locator.
    expect(toolResultViewMount({ type: "tool-result", toolCallId: "c", content: [], ...block })).toBeUndefined();
  });

  it("structuredContent wins over uiData", () => {
    const other: JsonValue = { format: "a2ui", version: "v0.9", messages: [] };
    expect(
      readA2uiCarrier({ structuredContent: { [A2UI_CARRIER_KEY]: carrier }, uiData: { [A2UI_CARRIER_KEY]: other } }),
    ).toMatchObject({ via: "structuredContent", carrier });
  });

  it("the value is not judged: any JSON under the marker is the carrier (the validator judges it)", () => {
    expect(readA2uiCarrier({ structuredContent: { [A2UI_CARRIER_KEY]: 7 } })).toMatchObject({ kind: "carrier", carrier: 7 });
  });

  it("a carrier at the bound is read; one unit over is oversize (the value handed on only to name its surfaces)", () => {
    const atBound = carrierOfUnits(A2UI_CARRIER_MAX_UNITS);
    expect(a2uiCarrierUnits(atBound)).toBe(A2UI_CARRIER_MAX_UNITS);
    expect(readA2uiCarrier({ structuredContent: { [A2UI_CARRIER_KEY]: atBound } })?.kind).toBe("carrier");
    const over = carrierOfUnits(A2UI_CARRIER_MAX_UNITS + 1);
    expect(readA2uiCarrier({ structuredContent: { [A2UI_CARRIER_KEY]: over } })).toEqual({
      kind: "oversize",
      carrier: over,
      via: "structuredContent",
      units: A2UI_CARRIER_MAX_UNITS + 1,
    });
  });

  it("units are UTF-16 code units of the JSON text (an astral character counts two)", () => {
    expect(a2uiCarrierUnits("😀")).toBe(4);
    expect(a2uiCarrierUnits({ a: 1 })).toBe(7);
  });
});
