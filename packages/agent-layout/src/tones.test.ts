/**
 * Tone math pins (§2): the calibrated OR-form floor, the shipped defaults
 * passing by construction, reject-under-floor, and the derivation's
 * documented nudge.
 */
import { describe, expect, it } from "vitest";
import {
  assertToneFloor,
  DEFAULT_TONES,
  deriveTones,
  hexToLab,
  meetsToneFloor,
  toneDelta,
} from "./tones.js";

describe("tone floor (calibrated on ggui#633)", () => {
  it("the shipped light pair passes via the temperature arm (ΔL* ~5.2, Δab ~2.1)", () => {
    const { dL, dab } = toneDelta(DEFAULT_TONES.light.upper, DEFAULT_TONES.light.lower);
    expect(dL).toBeGreaterThan(5);
    expect(dL).toBeLessThan(6); // the strict arm alone would reject it —
    expect(dab).toBeGreaterThanOrEqual(2); // — the OR-form is load-bearing.
    expect(meetsToneFloor(DEFAULT_TONES.light.upper, DEFAULT_TONES.light.lower)).toBe(true);
  });

  it("the dark pair passes the STRICT arm (ΔL* ≥ 6) with the temperature step preserved", () => {
    const { dL, dab } = toneDelta(DEFAULT_TONES.dark.upper, DEFAULT_TONES.dark.lower);
    expect(dL).toBeGreaterThanOrEqual(6);
    expect(dab).toBeGreaterThanOrEqual(2);
  });

  it("the console's failed first cut (ΔL* 3.5, temperature-flat) fails both arms", () => {
    // #EDEDED vs #E4E4E4: ΔL* ≈ 3.4, Δab ≈ 0 — the below-perception case.
    expect(meetsToneFloor("#EDEDED", "#E4E4E4")).toBe(false);
  });

  it("assertToneFloor rejects with the explanatory message", () => {
    expect(() =>
      assertToneFloor({ upper: "#EDEDED", upperOn: "#111111", lower: "#E4E4E4", lowerOn: "#111111" }),
    ).toThrow(/perceptibility floor/);
  });

  it("malformed hex is refused at the door, never NaN-math", () => {
    expect(() => hexToLab("var(--x)")).toThrow(/#rrggbb/);
  });
});

describe("chat-palette derivation", () => {
  it("surface grounds the agent (lower), canvas the menu (upper); a passing pair is untouched", () => {
    const d = deriveTones({ surface: "#FFFFFF", canvas: "#ECEAE4", ink: "#111111" });
    expect(d.lower).toBe("#FFFFFF");
    expect(d.upper).toBe("#ECEAE4");
    expect(d.nudged).toBe(false);
  });

  it("a pair under the floor gets the documented nudge apart until ΔL* ≥ 6", () => {
    const d = deriveTones({ surface: "#F0F0F0", canvas: "#EDEDED", ink: "#111111" });
    expect(d.nudged).toBe(true);
    expect(toneDelta(d.upper, d.lower).dL).toBeGreaterThanOrEqual(6);
    expect(d.lower).toBe("#F0F0F0"); // the agent ground never moves — chat owns it
  });

  it("the nudge walks INTO the pair's existing contrast direction (darker canvas walks darker)", () => {
    const d = deriveTones({ surface: "#F5F5F5", canvas: "#EFEFEF", ink: "#111111" });
    expect(d.nudged).toBe(true);
    expect(hexToLab(d.upper).L).toBeLessThan(hexToLab("#EFEFEF").L);
  });
});
