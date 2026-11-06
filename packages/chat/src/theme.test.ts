import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_GLASS,
  DEFAULT_CHAT_SHADOW,
  DEFAULT_CHAT_THEME,
  GUUEY_CHAT_THEME,
  GuueyChatFace,
  GuueyChatTheme,
  accentStandsOut,
  contrastRatio,
  paletteChipFace,
  paletteCue,
  parseOpaqueColor,
  resolveTheme,
  resolveCourtTheme,
} from "./theme.js";

describe("GuueyChatTheme", () => {
  it("both shipped themes satisfy their own schema", () => {
    expect(GuueyChatTheme.safeParse(DEFAULT_CHAT_THEME).success).toBe(true);
    expect(GuueyChatTheme.safeParse(GUUEY_CHAT_THEME).success).toBe(true);
  });

  it("guuey theme carries the widget's shipped slime/ink/fog tokens", () => {
    expect(GUUEY_CHAT_THEME.colors.light.accent).toBe("#b8ff3a");
    expect(GUUEY_CHAT_THEME.colors.light.canvas).toBe("#f6f5ee");
    expect(GUUEY_CHAT_THEME.colors.dark.canvas).toBe("#0e1014");
    // Saturated accents deliberately identical across modes (widget posture).
    expect(GUUEY_CHAT_THEME.colors.dark.accent).toBe(GUUEY_CHAT_THEME.colors.light.accent);
  });

  it("resolves per-token: a half-configured theme falls back token-by-token", () => {
    const resolved = resolveTheme({ name: "acme", colors: { light: { accent: "#ff0000" } } });
    expect(resolved.name).toBe("acme");
    expect(resolved.colors.light.accent).toBe("#ff0000");
    // Every unspecified token is the default's, not undefined.
    expect(resolved.colors.light.ink).toBe(DEFAULT_CHAT_THEME.colors.light.ink);
    expect(resolved.colors.dark).toEqual(DEFAULT_CHAT_THEME.colors.dark);
    expect(resolved.shape).toEqual(DEFAULT_CHAT_THEME.shape);
  });

  it("parses leniently: unknown keys pass through, never rejected (evolution rule)", () => {
    const stored = {
      name: "future",
      colors: { light: { accent: "#123456", holoGlow: "#abcdef" } },
      motion: { speed: "fast" }, // a token group this version has never heard of
    };
    const resolved = resolveTheme(stored);
    expect(resolved.colors.light.accent).toBe("#123456");
    // And the SCHEMA itself keeps unknown keys when parsed directly.
    const parsed = GuueyChatTheme.safeParse({ ...DEFAULT_CHAT_THEME, extra: true });
    expect(parsed.success).toBe(true);
  });

  it("mode (theme-as-code §3): a stated value survives resolution, absence stays absent", () => {
    const resolved = resolveTheme({ mode: "dark", colors: { light: { accent: "#c9a227" } } });
    expect(resolved.mode).toBe("dark");
    // The package defaults state no mode — an unstated theme must not grow
    // one out of resolution; base mode stands when the candidate is silent.
    const bare = resolveTheme({ colors: {} });
    expect("mode" in bare).toBe(false);
    expect(resolveTheme({ colors: {} }, resolved).mode).toBe("dark");
  });

  /**
   * The theming revision (guuey#1128 §3, joint spec signed off 2026-09-10):
   * the vocabulary gains the ANCHORS the card derivation reads — a second
   * accent (ggui `tertiary`) and the tone anchors — and loses `ramps`:
   * ladders are DERIVED by ggui's one producer from the anchors, never
   * stated, so a stated ladder is dead vocabulary and leaves the schema
   * (pre-launch, no shim).
   */
  it("v2 palette anchors resolve per-token and stay absent when no layer states them", () => {
    const resolved = resolveTheme({
      colors: {
        light: { secondaryAccent: "#7c3aed", onSecondaryAccent: "#ffffff", success: "#15803d" },
        dark: { warning: "#f59e0b", info: "#38bdf8" },
      },
    });
    expect(resolved.colors.light.secondaryAccent).toBe("#7c3aed");
    expect(resolved.colors.light.onSecondaryAccent).toBe("#ffffff");
    expect(resolved.colors.light.success).toBe("#15803d");
    expect(resolved.colors.dark.warning).toBe("#f59e0b");
    expect(resolved.colors.dark.info).toBe("#38bdf8");
    // Unstated anywhere (the package defaults state none of them) — absent,
    // not defaulted: the card derivation treats absence as "derive".
    expect("secondaryAccent" in resolved.colors.dark).toBe(false);
    expect("success" in resolved.colors.dark).toBe(false);
    expect("warning" in resolved.colors.light).toBe(false);
    for (const token of ["secondaryAccent", "onSecondaryAccent", "success", "warning", "info"]) {
      expect(token in DEFAULT_CHAT_THEME.colors.light).toBe(false);
      expect(token in GUUEY_CHAT_THEME.colors.light).toBe(false);
    }
  });

  it("typography gains headingFontFamily + faces; faces replace wholesale, never merge per element", () => {
    const base = resolveTheme({
      typography: {
        headingFontFamily: "Fraunces, serif",
        faces: [{ family: "Fraunces", src: "https://fonts.gstatic.com/s/fraunces/a.woff2", weight: "400 700" }],
      },
    });
    expect(base.typography.headingFontFamily).toBe("Fraunces, serif");
    expect(base.typography.faces).toHaveLength(1);
    const over = resolveTheme(
      { typography: { faces: [{ family: "Inter", src: "https://fonts.gstatic.com/s/inter/b.woff2" }] } },
      base,
    );
    expect(over.typography.headingFontFamily).toBe("Fraunces, serif");
    expect(over.typography.faces).toEqual([{ family: "Inter", src: "https://fonts.gstatic.com/s/inter/b.woff2" }]);
    expect("faces" in DEFAULT_CHAT_THEME.typography).toBe(false);
    expect(GuueyChatFace.safeParse({ family: "Inter", src: "https://x.test/a.woff2" }).success).toBe(true);
    expect(GuueyChatFace.safeParse({ family: "Inter" }).success).toBe(false);
  });

  it("shape gains shadow (colour + intensity); a candidate statement wins whole, silence inherits the base's", () => {
    const resolved = resolveTheme({ shape: { shadow: { color: "#00000080", intensity: 0.4 } } });
    expect(resolved.shape.shadow).toEqual({ color: "#00000080", intensity: 0.4 });
    expect(resolveTheme({ shape: { shadow: { intensity: 0.1 } } }, resolved).shape.shadow).toEqual({ intensity: 0.1 });
    expect(resolveTheme({ colors: {} }, resolved).shape.shadow).toEqual({ color: "#00000080", intensity: 0.4 });
    // A base that states none leaves it absent (the member is default-less at the schema level).
    const bare: GuueyChatTheme = { ...DEFAULT_CHAT_THEME, shape: { radius: "soft", density: "comfortable" } };
    expect("shadow" in resolveTheme({ colors: {} }, bare).shape).toBe(false);
  });

  /**
   * guuey#1151 — glass is ONE value in the theme document (one value
   * in door 1, not the design): the widget
   * CHROME's translucency + backdrop blur. Carried next to `shadow` in the
   * v2 vocabulary so it is never a migration; chrome-only, never a card.
   */
  it("shape gains glass (opacity + blur) — chrome-only; a candidate statement wins whole, silence inherits the base's", () => {
    const resolved = resolveTheme({ shape: { glass: { opacity: 0.72, blur: 20 } } });
    expect(resolved.shape.glass).toEqual({ opacity: 0.72, blur: 20 });
    expect(resolveTheme({ shape: { glass: { opacity: 0.9 } } }, resolved).shape.glass).toEqual({ opacity: 0.9 });
    expect(resolveTheme({ colors: {} }, resolved).shape.glass).toEqual({ opacity: 0.72, blur: 20 });
    const bare: GuueyChatTheme = { ...DEFAULT_CHAT_THEME, shape: { radius: "soft", density: "comfortable" } };
    expect("glass" in resolveTheme({ colors: {} }, bare).shape).toBe(false);
    // Shape only (the platform's write gate holds the bands): `opacity` is
    // required — a glass statement without one is no statement — `blur` optional.
    const Glass = GuueyChatTheme.shape.shape.shape.glass.unwrap();
    expect(Glass.safeParse({ opacity: 0.5 }).success).toBe(true);
    expect(Glass.safeParse({ blur: 8 }).success).toBe(false);
  });

  /**
   * guuey#1176 — the widget's DEFAULT look is
   * guuey.com's frosted glass. The numbers are the home hero's embedded
   * chat verbatim (`apps/landing/src/components/HomeChat.css` `.homechat.on`:
   * line 36 `rgba(246, 245, 238, 0.82)`, line 37 `blur(14px)`, line 39
   * `0 24px 60px rgba(14, 16, 20, 0.22)`). Both shipped themes state them,
   * so an unthemed app and a theme that states nothing about glass or
   * shadow both inherit them; `glass: { opacity: 1 }` is the opt-out — a
   * statement, which wins whole like any other.
   */
  describe("frosted glass is the default (guuey#1176)", () => {
    it("the two values are guuey.com's, and both shipped themes state them", () => {
      expect(DEFAULT_CHAT_GLASS).toEqual({ opacity: 0.82, blur: 14 });
      expect(DEFAULT_CHAT_SHADOW).toEqual({ color: "#0e1014", intensity: 0.22 });
      for (const theme of [DEFAULT_CHAT_THEME, GUUEY_CHAT_THEME]) {
        expect(theme.shape.glass).toEqual(DEFAULT_CHAT_GLASS);
        expect(theme.shape.shadow).toEqual(DEFAULT_CHAT_SHADOW);
      }
      // Values, not the shared object: a consumer mutating a resolved theme
      // (the console's draft) must never reach the package constant.
      expect(DEFAULT_CHAT_THEME.shape.glass).not.toBe(DEFAULT_CHAT_GLASS);
      expect(GUUEY_CHAT_THEME.shape.shadow).not.toBe(DEFAULT_CHAT_SHADOW);
    });

    it("a theme that states no glass or shadow inherits the default's — the base fallback, not a special case", () => {
      const themed = resolveTheme({ name: "acme", colors: { light: { accent: "#ff0000" } } });
      expect(themed.shape.glass).toEqual(DEFAULT_CHAT_GLASS);
      expect(themed.shape.shadow).toEqual(DEFAULT_CHAT_SHADOW);
      // …and over the guuey identity too (portal's base).
      expect(resolveTheme({ colors: {} }, GUUEY_CHAT_THEME).shape.glass).toEqual(DEFAULT_CHAT_GLASS);
    });

    it("`glass: { opacity: 1 }` opts out — the statement survives resolution whole (no blur rides along)", () => {
      const opaque = resolveTheme({ shape: { glass: { opacity: 1 } } });
      expect(opaque.shape.glass).toEqual({ opacity: 1 });
      // The opt-out is a statement like any other: a further layer that is
      // silent keeps it; one that states glass again wins whole.
      expect(resolveTheme({ colors: {} }, opaque).shape.glass).toEqual({ opacity: 1 });
      expect(resolveTheme({ shape: { glass: { opacity: 0.6 } } }, opaque).shape.glass).toEqual({ opacity: 0.6 });
    });
  });

  it("`ramps` is no longer vocabulary: a stored ladder passes the lenient parse as an unknown key and is never projected", () => {
    expect("ramps" in GuueyChatTheme.shape).toBe(false);
    const stored = {
      mode: "light",
      colors: { light: { accent: "#c9a227" } },
      ramps: { light: { accent: { "500": "#c9a227", "600": "#a9861c", "700": "#8a6d15" } } },
    };
    expect(GuueyChatTheme.safeParse({ ...DEFAULT_CHAT_THEME, ...stored, colors: DEFAULT_CHAT_THEME.colors }).success).toBe(true);
    expect("ramps" in resolveTheme(stored)).toBe(false);
  });

  it("never throws: garbage input resolves to the base theme untouched", () => {
    expect(resolveTheme(null)).toEqual(DEFAULT_CHAT_THEME);
    expect(resolveTheme("#not-a-theme")).toEqual(DEFAULT_CHAT_THEME);
    expect(resolveTheme(42, GUUEY_CHAT_THEME)).toEqual(GUUEY_CHAT_THEME);
  });
});

describe("resolveCourtTheme (guuey#519)", () => {
  const doc = {
    name: "neutral-base",
    colors: { light: { accent: "#2f6bff" } },
    courts: {
      guuey: { name: "brand", colors: { light: { accent: "#0e1014", onAccent: "#b8ff3a" } } },
    },
  };

  it("resolves the declared court's override per-token over the base", () => {
    const resolved = resolveCourtTheme(doc, "guuey");
    expect(resolved.name).toBe("brand");
    expect(resolved.colors.light.accent).toBe("#0e1014");
    expect(resolved.colors.light.onAccent).toBe("#b8ff3a");
    // Unstated tokens fall through: base doc, then the default theme.
    expect(resolved.colors.light.ink).toBe(DEFAULT_CHAT_THEME.colors.light.ink);
  });

  it("an undeclared court gets the base alone — brand never leaks by default", () => {
    const resolved = resolveCourtTheme(doc, "ggui");
    expect(resolved.name).toBe("neutral-base");
    expect(resolved.colors.light.accent).toBe("#2f6bff");
  });

  it("resolved themes are court-free and junk input degrades like resolveTheme", () => {
    expect("courts" in resolveCourtTheme(doc, "guuey")).toBe(false);
    expect(resolveCourtTheme(42, "guuey")).toEqual(resolveTheme(42));
    expect(resolveCourtTheme({ courts: "not-an-object" }, "guuey").name).toBe(
      DEFAULT_CHAT_THEME.name,
    );
  });
});

describe("link token (guuey#528)", () => {
  it("the neutral default's link equals ink — monochrome, underline distinguishes", () => {
    expect(DEFAULT_CHAT_THEME.colors.light.link).toBe(DEFAULT_CHAT_THEME.colors.light.ink);
    expect(DEFAULT_CHAT_THEME.colors.dark.link).toBe(DEFAULT_CHAT_THEME.colors.dark.ink);
  });

  it("the guuey identity carries the AA-clearing brand green on light, the ladder's slime on dark", () => {
    expect(GUUEY_CHAT_THEME.colors.light.link).toBe("#47700d");
    expect(GUUEY_CHAT_THEME.colors.dark.link).toBe("#b8ff3a");
  });

  it("the guuey identity's light error clears AA on every light ground; dark keeps its own", () => {
    expect(GUUEY_CHAT_THEME.colors.light.error).toBe("#b23a2a");
    expect(GUUEY_CHAT_THEME.colors.dark.error).toBe("#ff5b5b");
  });

  it("a pre-#528 theme (no link) resolves with the default's link — additive evolution holds", () => {
    const resolved = resolveTheme({ name: "old", colors: { light: { accent: "#123456" } } });
    expect(resolved.colors.light.link).toBe(DEFAULT_CHAT_THEME.colors.light.link);
    expect(resolved.colors.light.accent).toBe("#123456");
  });
});

describe("cue token: the one-bit strokes and the focus ring", () => {
  it("the guuey identity states its stroke green on light and the slime on dark", () => {
    expect(GUUEY_CHAT_THEME.colors.light.cue).toBe("#4e740d");
    expect(GUUEY_CHAT_THEME.colors.dark.cue).toBe("#b8ff3a");
  });

  it("the neutral default states none, so it derives: its accent clears 3:1 on its canvas", () => {
    expect(DEFAULT_CHAT_THEME.colors.light.cue).toBeUndefined();
    expect(paletteCue(DEFAULT_CHAT_THEME.colors.light)).toBe(DEFAULT_CHAT_THEME.colors.light.accent);
    expect(paletteCue(DEFAULT_CHAT_THEME.colors.dark)).toBe(DEFAULT_CHAT_THEME.colors.dark.accent);
  });

  it("a stated cue wins over the derivation", () => {
    expect(paletteCue({ ...DEFAULT_CHAT_THEME.colors.light, cue: "#123456" })).toBe("#123456");
  });

  it("an accent under 3:1 on the canvas derives the muted ink, never the invisible accent", () => {
    const light = { ...DEFAULT_CHAT_THEME.colors.light, accent: "#b8ff3a", canvas: "#f6f5ee" };
    expect(paletteCue(light)).toBe(light.inkMuted);
  });

  it("an accent or canvas it cannot measure derives the muted ink", () => {
    for (const accent of ["oklch(0.7 0.2 140)", "rgba(10, 20, 30, 0.5)", "slime"]) {
      expect(paletteCue({ ...DEFAULT_CHAT_THEME.colors.light, accent })).toBe(DEFAULT_CHAT_THEME.colors.light.inkMuted);
    }
    expect(paletteCue({ ...DEFAULT_CHAT_THEME.colors.light, canvas: "transparent" })).toBe(
      DEFAULT_CHAT_THEME.colors.light.inkMuted,
    );
  });

  it("measures #rgb and rgb() the same as #rrggbb", () => {
    expect(paletteCue({ ...DEFAULT_CHAT_THEME.colors.light, accent: "#111", canvas: "rgb(247, 247, 245)" })).toBe("#111");
  });

  it("a layer that restates the accent without a cue drops the inherited guuey cue, so it derives", () => {
    const resolved = resolveTheme({ colors: { light: { accent: "#0055ff" }, dark: { canvas: "#000000" } } }, GUUEY_CHAT_THEME);
    expect(resolved.colors.light.cue).toBeUndefined();
    expect(resolved.colors.dark.cue).toBeUndefined();
    expect(paletteCue(resolved.colors.light)).toBe("#0055ff");
  });

  it("a layer that restates only the canvas over a base that states a cue drops that cue and derives against the new canvas", () => {
    expect(GUUEY_CHAT_THEME.colors.light.cue).toBe("#4e740d");
    const light = resolveTheme({ colors: { light: { canvas: "#ffffff" } } }, GUUEY_CHAT_THEME).colors.light;
    expect(light.accent).toBe(GUUEY_CHAT_THEME.colors.light.accent);
    expect(light.cue).toBeUndefined();
    expect(paletteCue(light)).toBe(GUUEY_CHAT_THEME.colors.light.inkMuted);
    const dark = resolveTheme({ colors: { dark: { canvas: "#000000" } } }, GUUEY_CHAT_THEME).colors.dark;
    expect(dark.cue).toBeUndefined();
    expect(paletteCue(dark)).toBe(GUUEY_CHAT_THEME.colors.dark.accent);
  });

  it("a layer that states its own cue keeps it, and one that leaves accent and canvas alone inherits the base's", () => {
    expect(
      resolveTheme({ colors: { light: { accent: "#ff5500", cue: "#aa3300" } } }, GUUEY_CHAT_THEME).colors.light.cue,
    ).toBe("#aa3300");
    expect(resolveTheme({ colors: { light: { ink: "#000000" } } }, GUUEY_CHAT_THEME).colors.light.cue).toBe("#4e740d");
  });

  it("a stored theme from before the cue resolves and derives one (additive evolution)", () => {
    const old = { name: "acme", colors: { light: { accent: "#0055ff" }, dark: { accent: "#88aaff" } } };
    expect(paletteCue(resolveTheme(old).colors.light)).toBe("#0055ff");
  });
});

describe("the opaque colour measure the cue uses, exported for every surface that measures", () => {
  it("parses #rgb, #rrggbb and opaque rgb()/rgba(), case- and space-insensitive", () => {
    expect(parseOpaqueColor("#0F0")).toEqual({ r: 0, g: 255, b: 0 });
    expect(parseOpaqueColor(" #4e740d ")).toEqual({ r: 0x4e, g: 0x74, b: 0x0d });
    expect(parseOpaqueColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3 });
    expect(parseOpaqueColor("RGBA(1 2 3 / 100%)")).toEqual({ r: 1, g: 2, b: 3 });
    expect(parseOpaqueColor("rgba(1, 2, 3, 0.995)")).toEqual({ r: 1, g: 2, b: 3 });
  });

  it("answers null for anything it cannot measure as opaque", () => {
    for (const input of ["rgba(1, 2, 3, 0.5)", "transparent", "slime", "hsl(90 100% 50%)", "#12345", "#1234567"]) {
      expect(parseOpaqueColor(input)).toBeNull();
    }
  });

  it("measures WCAG 2.x contrast: 21:1 black on white, symmetric", () => {
    const black = parseOpaqueColor("#000");
    const white = parseOpaqueColor("#fff");
    if (black === null || white === null) throw new Error("the fixtures parse");
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
  });
});

describe("the chip face: an accent chip only where the accent stands out", () => {
  it("is the accent face when the accent clears 3:1 on the canvas", () => {
    expect(accentStandsOut(DEFAULT_CHAT_THEME.colors.light)).toBe(true);
    expect(paletteChipFace(DEFAULT_CHAT_THEME.colors.light)).toBe("accent");
    expect(paletteChipFace(GUUEY_CHAT_THEME.colors.dark)).toBe("accent");
  });

  it("is the hollow face for the light slime on fog, and for colours it cannot measure", () => {
    expect(accentStandsOut(GUUEY_CHAT_THEME.colors.light)).toBe(false);
    expect(paletteChipFace(GUUEY_CHAT_THEME.colors.light)).toBe("hollow");
    expect(paletteChipFace({ ...DEFAULT_CHAT_THEME.colors.light, accent: "rebeccapurple" })).toBe("hollow");
  });

  it("ignores a stated cue: the face reads the accent against the canvas", () => {
    expect(paletteChipFace({ ...GUUEY_CHAT_THEME.colors.light, cue: "#000000" })).toBe("hollow");
  });
});
