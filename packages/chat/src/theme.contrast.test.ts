/**
 * The shipped palettes' text colours stay readable on every ground they can
 * sit on: WCAG 2.x AA for normal text (4.5:1), both modes. Every app that
 * states no colour of its own inherits one of these, so a shipped theme that
 * regresses regresses every such app at once.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_THEME, GUUEY_CHAT_THEME, type GuueyChatPalette } from "./theme.js";

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

/** `color-mix(in srgb, top share, ground)` for two opaque `#rrggbb` colours, each channel rounded to 8 bits. */
function mix(top: string, share: number, ground: string): string {
  const channels = (hex: string): number[] => {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (match === null) throw new Error(`not a #rrggbb colour: ${hex}`);
    return [match[1], match[2], match[3]].map((part) => Number.parseInt(part ?? "", 16));
  };
  const [t, g] = [channels(top), channels(ground)];
  return `#${t
    .map((value, i) => Math.round(share * value + (1 - share) * (g[i] ?? 0)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** WCAG 2.x contrast ratio between two colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** A colour a shipped palette must state: a theme that leaves one unset fails here, loudly. */
function colour(palette: GuueyChatPalette, key: (typeof TEXT)[number] | (typeof GROUNDS)[number] | "onAccent" | "accent"): string {
  const value = palette[key];
  if (value === undefined) throw new Error(`the palette states no ${key}`);
  return value;
}

const AA_NORMAL = 4.5;
/** Text colours, and the grounds each may sit on (an error line can sit in a sunken well). */
const TEXT = ["ink", "inkMuted", "error", "link"] as const;
const GROUNDS = ["surface", "canvas", "canvasMuted"] as const;

describe("the shipped palettes clear AA for normal text on every ground, both modes", () => {
  for (const theme of [DEFAULT_CHAT_THEME, GUUEY_CHAT_THEME]) {
    for (const mode of ["light", "dark"] as const) {
      const palette = theme.colors[mode];
      for (const text of TEXT) {
        for (const ground of GROUNDS) {
          it(`${theme.name} ${mode}: ${text} on ${ground}`, () => {
            expect(contrast(colour(palette, text), colour(palette, ground))).toBeGreaterThanOrEqual(AA_NORMAL);
          });
        }
      }
      it(`${theme.name} ${mode}: onAccent on accent (the send button)`, () => {
        expect(contrast(colour(palette, "onAccent"), colour(palette, "accent"))).toBeGreaterThanOrEqual(AA_NORMAL);
      });
      // The error panel's ground is `color-mix(in srgb, error 7%, surface)` (styles.css).
      it(`${theme.name} ${mode}: error on the error panel`, () => {
        const panel = mix(colour(palette, "error"), 0.07, colour(palette, "surface"));
        expect(contrast(colour(palette, "error"), panel)).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }
  }

  it("the check is not vacuous: the previous light colours fail where they were replaced", () => {
    const light = DEFAULT_CHAT_THEME.colors.light;
    for (const ground of GROUNDS) {
      expect(contrast("#d64545", colour(light, ground))).toBeLessThan(AA_NORMAL);
    }
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    // The guuey theme's previous light link and error: the link fails on the muted canvas,
    // the error fails on every light ground and on its own panel.
    const guuey = GUUEY_CHAT_THEME.colors.light;
    expect(contrast("#4e7a0e", colour(guuey, "canvasMuted"))).toBeLessThan(AA_NORMAL);
    for (const ground of GROUNDS) {
      expect(contrast("#ff5b5b", colour(guuey, ground))).toBeLessThan(AA_NORMAL);
    }
    expect(contrast("#ff5b5b", mix("#ff5b5b", 0.07, colour(guuey, "surface")))).toBeLessThan(AA_NORMAL);
  });
});
