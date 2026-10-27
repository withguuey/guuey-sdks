/**
 * The kit's pulse breathes text colour, never opacity: a mute is a colour.
 * Every pulsed element is text, and the trough is an opaque mix of the ink
 * and the muted ink (its contrast is pinned in theme.contrast.test.ts), so a
 * pulsing line never dips under the muted ink's contrast. Read from the
 * shipped stylesheet and the renderer.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, DEFAULT_CHAT_THEME, GUUEY_CHAT_THEME, parseOpaqueColor, type GuueyChatPalette, type OpaqueRgb } from "./theme.js";

const raw = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const renderer = readFileSync(fileURLToPath(new URL("./react/components.tsx", import.meta.url)), "utf8");

function keyframes(name: string): string {
  const start = raw.indexOf(`@keyframes ${name}`);
  if (start < 0) throw new Error(`no @keyframes ${name}`);
  let depth = 0;
  for (let i = raw.indexOf("{", start); i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    if (raw[i] === "}" && --depth === 0) return raw.slice(start, i + 1);
  }
  throw new Error("unbalanced");
}

describe("the pulse is a colour breath, never an opacity fade", () => {
  it("animates color to the opaque ink / muted-ink midpoint and nothing else", () => {
    const body = keyframes("guuey-chat-pulse");
    expect(body).not.toMatch(/opacity/);
    expect(body.replace(/\s+/g, " ")).toMatch(
      /color: color-mix\( in srgb, var\(--guuey-chat-ink, var\(--_guuey-chat-ink\)\) 50%, var\(--guuey-chat-ink-muted, var\(--_guuey-chat-ink-muted\)\) \)/,
    );
  });

  it("the negotiating view pulses its words, not the box around them (the words carry their own colour)", () => {
    expect(renderer).toMatch(/<p className="guuey-chat-shimmer" role="status">/);
    expect(renderer).not.toMatch(/guuey-chat-view-negotiating guuey-chat-shimmer/);
  });
});

// ── every frame of the breath, as a browser may interpolate it ─────────────

/** Selectors that carry the pulse or the shimmer, each a text element. */
const PULSED = [".guuey-chat-pulse", ".guuey-chat-shimmer"];

describe("reduced motion stops every pulsed element", () => {
  it("each pulsed class is set to `animation: none` under prefers-reduced-motion: reduce", () => {
    const start = raw.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = raw.slice(start, raw.indexOf("}", raw.indexOf("animation: none", start)) + 1);
    for (const selector of PULSED) expect(block, selector).toContain(selector);
    expect(block).toMatch(/animation:\s*none/);
  });
});

const linear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const gamma = (v: number): number => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

/** sRGB → Oklab (Ottosson's reference matrices). */
function toOklab(c: OpaqueRgb): [number, number, number] {
  const [r, g, b] = [linear(c.r), linear(c.g), linear(c.b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Oklab → sRGB, rounded to 8 bits. */
function fromOklab([L, a, b]: [number, number, number]): OpaqueRgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const mixRgb = (a: OpaqueRgb, b: OpaqueRgb, t: number): OpaqueRgb => ({
  r: Math.round(lerp(a.r, b.r, t)),
  g: Math.round(lerp(a.g, b.g, t)),
  b: Math.round(lerp(a.b, b.b, t)),
});

/** Every 5% frame from the rest colour to the trough, interpolated in sRGB and in Oklab. */
function frames(rest: OpaqueRgb, trough: OpaqueRgb): OpaqueRgb[] {
  const [restLab, troughLab] = [toOklab(rest), toOklab(trough)];
  const out: OpaqueRgb[] = [];
  for (let step = 0; step <= 20; step++) {
    const t = step / 20;
    out.push(mixRgb(rest, trough, t));
    out.push(fromOklab([lerp(restLab[0], troughLab[0], t), lerp(restLab[1], troughLab[1], t), lerp(restLab[2], troughLab[2], t)]));
  }
  return out;
}

function rgb(palette: GuueyChatPalette, key: "ink" | "inkMuted" | "surface" | "canvas" | "canvasMuted"): OpaqueRgb {
  const parsed = parseOpaqueColor(palette[key]);
  if (parsed === null) throw new Error(`the palette's ${key} is not an opaque colour`);
  return parsed;
}

describe("every frame of the breath clears AA for normal text on every shipped ground", () => {
  for (const theme of [DEFAULT_CHAT_THEME, GUUEY_CHAT_THEME]) {
    for (const mode of ["light", "dark"] as const) {
      const palette = theme.colors[mode];
      const trough = mixRgb(rgb(palette, "ink"), rgb(palette, "inkMuted"), 0.5);
      // A pulsed line rests on the muted ink (status, history, the negotiating label) or the ink (reasoning).
      for (const rest of ["inkMuted", "ink"] as const) {
        for (const ground of ["surface", "canvas", "canvasMuted"] as const) {
          it(`${theme.name} ${mode}: ${rest} → trough on ${ground}`, () => {
            const g = rgb(palette, ground);
            const worst = Math.min(...frames(rgb(palette, rest), trough).map((f) => contrastRatio(f, g)));
            expect(worst).toBeGreaterThanOrEqual(4.5);
          });
        }
      }
    }
  }

  it("the check is not vacuous: the old opacity trough (muted ink at 0.55 over its ground) fails AA", () => {
    const light = DEFAULT_CHAT_THEME.colors.light;
    for (const ground of ["surface", "canvas", "canvasMuted"] as const) {
      const g = rgb(light, ground);
      expect(contrastRatio(mixRgb(g, rgb(light, "inkMuted"), 0.55), g)).toBeLessThan(4.5);
    }
  });

  it("the Oklab path round-trips the palette's colours, so its frames are real colours", () => {
    for (const hex of ["#111318", "#5b6270", "#f7f7f5", "#b8ff3a", "#4e740d", "#0e1014"]) {
      const c = parseOpaqueColor(hex);
      if (c === null) throw new Error(hex);
      expect(fromOklab(toOklab(c))).toEqual(c);
    }
  });
});
