import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_THEME,
  GUUEY_CHAT_THEME,
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

  it("mode + ramps (theme-as-code §3): stated values survive resolution, absence stays absent", () => {
    const stored = {
      mode: "dark",
      colors: { light: { accent: "#c9a227" } },
      ramps: { light: { accent: { "500": "#c9a227", "600": "#a9861c", "700": "#8a6d15" } } },
    };
    const resolved = resolveTheme(stored);
    expect(resolved.mode).toBe("dark");
    expect(resolved.ramps?.light?.accent?.["600"]).toBe("#a9861c");
    // The package defaults state NEITHER — an unstated theme must not
    // grow a mode or ramps out of resolution.
    const bare = resolveTheme({ colors: {} });
    expect("mode" in bare).toBe(false);
    expect("ramps" in bare).toBe(false);
  });

  it("ramps merge slot-wise over a base statement; base mode stands when the candidate is silent", () => {
    const base = resolveTheme({
      mode: "light",
      ramps: { light: { accent: { "500": "#111111", "600": "#222222" } } },
    });
    const over = resolveTheme({ ramps: { light: { accent: { "600": "#999999" } } } }, base);
    expect(over.mode).toBe("light");
    expect(over.ramps?.light?.accent?.["500"]).toBe("#111111");
    expect(over.ramps?.light?.accent?.["600"]).toBe("#999999");
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
