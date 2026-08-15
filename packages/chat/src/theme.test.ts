import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_THEME,
  GUUEY_CHAT_THEME,
  GuueyChatTheme,
  resolveTheme,
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

  it("never throws: garbage input resolves to the base theme untouched", () => {
    expect(resolveTheme(null)).toEqual(DEFAULT_CHAT_THEME);
    expect(resolveTheme("#not-a-theme")).toEqual(DEFAULT_CHAT_THEME);
    expect(resolveTheme(42, GUUEY_CHAT_THEME)).toEqual(GUUEY_CHAT_THEME);
  });
});
