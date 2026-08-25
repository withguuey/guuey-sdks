/**
 * Tone math (guuey#403 §2) — the two-panel tone pair, its perceptibility
 * floor, and the chat-palette derivation.
 *
 * The floor is CALIBRATED, not invented (ggui#633's scars): the console's
 * first cut at ΔL* 3.5 measured below perception; their shipped pair
 * (#F4F3ED warm paper vs #E4E4E2 neutral chrome) reads clearly at ΔL* 5.2
 * because the warm→neutral TEMPERATURE step does perceptual work lightness
 * alone doesn't. Hence the OR-form floor:
 *
 *     ΔL* ≥ 6  —  OR  —  a hue-temperature step (Δab ≥ 2) with ΔL* ≥ 5
 *
 * Both arms reject the failed 3.5 cut; the strict arm alone would have
 * rejected the founder-certified shipped pair. The platform's theme-doc
 * gate applies its own mirror of this rule server-side; this module is the
 * lib's own honesty (derived defaults satisfy the floor BY CONSTRUCTION —
 * pairs that land under it get the documented nudge apart, never a silent
 * pass). Calibration may RAISE the floor; it does not lower it.
 */

/** A resolved tone pair for one mode: two backgrounds + their foregrounds. */
export interface TonePair {
  /** Upper panel (app menus) background. */
  upper: string;
  /** Foreground on the upper tone. */
  upperOn: string;
  /** Lower panel (agent) background. */
  lower: string;
  /** Foreground on the lower tone. */
  lowerOn: string;
}

/**
 * The lib base defaults — the ggui#633 SHIPPED pair for light, and its
 * temperature-step mirror for dark (warm umber menu vs neutral chrome,
 * ΔL* 6.5 — the strict arm). Founder-certified "two-toned and
 * well-distinguished" in light; the dark pair keeps the identical warm→
 * neutral grammar so a mode flip changes brightness, not the layout's
 * character. Both pairs assert the floor in this package's tests.
 */
export const DEFAULT_TONES: Record<"light" | "dark", TonePair> = {
  light: {
    upper: "#F4F3ED",
    upperOn: "#1F1E1B",
    lower: "#E4E4E2",
    lowerOn: "#1A1A1C",
  },
  dark: {
    upper: "#302B24",
    upperOn: "#ECE9E2",
    lower: "#1E1E21",
    lowerOn: "#E3E3E5",
  },
};

/** CIELAB (D65) from a `#rrggbb` hex. Throws on a malformed color. */
export function hexToLab(hex: string): { L: number; a: number; b: number } {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (m === null) {
    throw new Error(
      `agent-layout tones: "${hex}" is not a #rrggbb color — tone math needs resolvable hex (CSS keywords and var() belong to the stylesheet tier, not the derivation door).`,
    );
  }
  const h = m[1];
  const chan = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255;
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const R = lin(chan(0));
  const G = lin(chan(2));
  const B = lin(chan(4));
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return {
    L: 116 * f(Y) - 16,
    a: 500 * (f(X) - f(Y)),
    b: 200 * (f(Y) - f(Z)),
  };
}

/** The perceptibility deltas between two backgrounds. */
export function toneDelta(upper: string, lower: string): { dL: number; dab: number } {
  const A = hexToLab(upper);
  const B = hexToLab(lower);
  return { dL: Math.abs(A.L - B.L), dab: Math.hypot(A.a - B.a, A.b - B.b) };
}

/** The OR-form floor (module header). */
export function meetsToneFloor(upper: string, lower: string): boolean {
  const { dL, dab } = toneDelta(upper, lower);
  return dL >= 6 || (dab >= 2 && dL >= 5);
}

/**
 * Reject-under-floor with the explanatory message (the brandAccent
 * posture): overrides that fail perceptibility throw HERE, at wiring time,
 * never render as an invisible seam.
 */
export function assertToneFloor(pair: TonePair): void {
  if (meetsToneFloor(pair.upper, pair.lower)) return;
  const { dL, dab } = toneDelta(pair.upper, pair.lower);
  throw new Error(
    `agent-layout tones: the upper/lower pair ${pair.upper}/${pair.lower} is below the perceptibility floor ` +
      `(ΔL* ${dL.toFixed(1)}, Δab ${dab.toFixed(1)}; needs ΔL* ≥ 6, or a temperature step Δab ≥ 2 with ΔL* ≥ 5). ` +
      `Two tones that measure alike defeat the category's defining behavior — pick a stronger pair.`,
  );
}

/**
 * Base-tier derivation (§2, platform's pick): tones DERIVE from the chat
 * palette's surface/canvas pair, so an already-themed app gets coherent
 * tones for free — theming chat themes the layout, no second authoring
 * step. `surface` grounds the AGENT (lower) panel — it is the chat's own
 * ground — and `canvas` grounds the MENU (upper) panel. Pairs that land
 * under the floor get the documented nudge: the upper tone walks away from
 * the lower along the lightness axis (toward white below L* 50, toward
 * black above — always INTO the pair's existing contrast direction) until
 * the strict arm passes. Deterministic, bounded, and asserted by tests.
 */
export function deriveTones(palette: {
  surface: string;
  canvas: string;
  ink: string;
}): Pick<TonePair, "upper" | "lower"> & { nudged: boolean } {
  const lower = palette.surface;
  let upper = palette.canvas;
  let nudged = false;
  if (!meetsToneFloor(upper, lower)) {
    nudged = true;
    const lowerL = hexToLab(lower).L;
    // Walk upper away from lower in sRGB mix steps until ΔL* ≥ 6. The mix
    // target keeps the walk inside the pair's own contrast direction.
    const towardWhite = hexToLab(upper).L >= lowerL;
    for (let i = 1; i <= 20 && !(toneDelta(upper, lower).dL >= 6); i++) {
      upper = mixHex(palette.canvas, towardWhite ? "#FFFFFF" : "#000000", i * 0.05);
    }
  }
  return { upper, lower, nudged };
}

/** Linear sRGB-space hex mix (`t` toward `target`). Exported for tests. */
export function mixHex(base: string, target: string, t: number): string {
  const pb = /^#([0-9a-fA-F]{6})$/.exec(base.trim());
  const pt = /^#([0-9a-fA-F]{6})$/.exec(target.trim());
  if (pb === null || pt === null) throw new Error(`agent-layout tones: mixHex needs #rrggbb inputs`);
  const out = [0, 2, 4]
    .map((i) => {
      const b = parseInt(pb[1].slice(i, i + 2), 16);
      const g = parseInt(pt[1].slice(i, i + 2), 16);
      return Math.round(b + (g - b) * Math.min(1, Math.max(0, t)))
        .toString(16)
        .padStart(2, "0");
    })
    .join("");
  return `#${out.toUpperCase()}`;
}
