/**
 * The default palette's text colours stay readable on every ground they can
 * sit on: WCAG 2.x AA for normal text (4.5:1), both modes. Every app that
 * states no colour of its own inherits these, so a default that regresses
 * regresses every such app at once.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_THEME, type GuueyChatPalette } from "./theme.js";

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => {
    const v = Number.parseInt(part ?? "", 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG 2.x contrast ratio between two colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** A colour the default palette must state: a default that leaves one unset fails here, loudly. */
function colour(palette: GuueyChatPalette, key: (typeof TEXT)[number] | (typeof GROUNDS)[number] | "onAccent" | "accent"): string {
  const value = palette[key];
  if (value === undefined) throw new Error(`the default palette states no ${key}`);
  return value;
}

const AA_NORMAL = 4.5;
/** Text colours, and the grounds each may sit on (an error line can sit in a sunken well). */
const TEXT = ["ink", "inkMuted", "error", "link"] as const;
const GROUNDS = ["surface", "canvas", "canvasMuted"] as const;

describe("the default palette clears AA for normal text on every ground, both modes", () => {
  for (const mode of ["light", "dark"] as const) {
    const palette = DEFAULT_CHAT_THEME.colors[mode];
    for (const text of TEXT) {
      for (const ground of GROUNDS) {
        it(`${mode}: ${text} on ${ground}`, () => {
          expect(contrast(colour(palette, text), colour(palette, ground))).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    }
    it(`${mode}: onAccent on accent (the send button)`, () => {
      expect(contrast(colour(palette, "onAccent"), colour(palette, "accent"))).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  it("the check is not vacuous: the previous light error colour fails on every light ground", () => {
    const light = DEFAULT_CHAT_THEME.colors.light;
    for (const ground of GROUNDS) {
      expect(contrast("#d64545", colour(light, ground))).toBeLessThan(AA_NORMAL);
    }
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});
