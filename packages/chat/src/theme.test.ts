import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_GLASS,
  DEFAULT_CHAT_SHADOW,
  DEFAULT_CHAT_THEME,
  GUUEY_CHAT_THEME,
  GuueyChatFace,
  GuueyChatTheme,
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
   * guuey#1151 — glass is ONE value in the theme document (the founder:
   * "Glass becomes one value in door 1, not the design"): the widget
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
   * guuey#1176 — the founder's hotfix: the widget's DEFAULT look is
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

  it("the guuey identity carries the founder-minted slime-4 on light, the ladder's slime on dark", () => {
    expect(GUUEY_CHAT_THEME.colors.light.link).toBe("#4e7a0e");
    expect(GUUEY_CHAT_THEME.colors.dark.link).toBe("#b8ff3a");
  });

  it("a pre-#528 theme (no link) resolves with the default's link — additive evolution holds", () => {
    const resolved = resolveTheme({ name: "old", colors: { light: { accent: "#123456" } } });
    expect(resolved.colors.light.link).toBe(DEFAULT_CHAT_THEME.colors.light.link);
    expect(resolved.colors.light.accent).toBe("#123456");
  });
});
