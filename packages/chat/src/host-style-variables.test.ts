import { EMPTY_HOST_STYLE_VARIABLES, announcedHostStyleVariables } from "@guuey/mcp-apps-host";
import { describe, expect, it } from "vitest";
import { HOST_STYLE_VARIABLE_KEYS, hostContextStyles, hostStyleVariables } from "./host-style-variables.js";
import { DEFAULT_CHAT_THEME, type GuueyChatTheme } from "./theme.js";

/** The default theme with the three tone families stated for light — the optional slots' positive case. */
const TONED: GuueyChatTheme = {
  ...DEFAULT_CHAT_THEME,
  colors: {
    ...DEFAULT_CHAT_THEME.colors,
    light: { ...DEFAULT_CHAT_THEME.colors.light, success: "#1a7f37", warning: "#b7791f", info: "#2563eb" },
  },
};

describe("hostStyleVariables — the theme's own anchors on the spec's `--color-*` slots (guuey#1128)", () => {
  it("maps the resolved theme's anchors for the mode, nothing invented", () => {
    const p = DEFAULT_CHAT_THEME.colors.dark;
    expect(hostStyleVariables(DEFAULT_CHAT_THEME, "dark")).toEqual({
      "--color-background-primary": p.canvas,
      "--color-background-secondary": p.surface,
      "--color-background-tertiary": p.canvasMuted,
      "--color-text-primary": p.ink,
      "--color-text-secondary": p.inkMuted,
      "--color-text-tertiary": p.inkMuted,
      "--color-text-danger": p.error,
      "--color-border-primary": p.inkMuted,
      "--color-border-secondary": p.canvasMuted,
    });
  });

  it("follows the mode: light and dark announce different canvases", () => {
    const light = hostStyleVariables(DEFAULT_CHAT_THEME, "light");
    const dark = hostStyleVariables(DEFAULT_CHAT_THEME, "dark");
    expect(light["--color-background-primary"]).toBe(DEFAULT_CHAT_THEME.colors.light.canvas);
    expect(dark["--color-background-primary"]).toBe(DEFAULT_CHAT_THEME.colors.dark.canvas);
    expect(light["--color-background-primary"]).not.toBe(dark["--color-background-primary"]);
  });

  it("announces a tone slot only when the theme states that family — omitting beats guessing", () => {
    const unstated = hostStyleVariables(DEFAULT_CHAT_THEME, "light");
    expect("--color-text-success" in unstated).toBe(false);
    expect("--color-text-warning" in unstated).toBe(false);
    expect("--color-text-info" in unstated).toBe(false);
    const stated = hostStyleVariables(TONED, "light");
    expect(stated["--color-text-success"]).toBe("#1a7f37");
    expect(stated["--color-text-warning"]).toBe("#b7791f");
    expect(stated["--color-text-info"]).toBe("#2563eb");
    // the dark palette of the same theme states none of them
    expect("--color-text-success" in hostStyleVariables(TONED, "dark")).toBe(false);
  });

  it("never announces a slot outside the set ggui's bridge consumes", () => {
    const keys = Object.keys(hostStyleVariables(TONED, "light"));
    expect(keys.length).toBe(HOST_STYLE_VARIABLE_KEYS.length);
    for (const key of keys) expect(HOST_STYLE_VARIABLE_KEYS).toContain(key);
  });
});

describe("hostContextStyles — one `styles` member for fonts + palette", () => {
  const css = "@font-face{font-family:x}";
  const vars = hostStyleVariables(DEFAULT_CHAT_THEME, "light");

  it("composes css.fonts and the spec-typed variables record", () => {
    const both = hostContextStyles(css, vars);
    expect(both.styles?.css).toEqual({ fonts: css });
    // the record hands the spec every key (its type); the wire is exactly the announced slots
    expect(Object.keys(both.styles?.variables ?? {}).length).toBe(Object.keys(EMPTY_HOST_STYLE_VARIABLES).length);
    expect(announcedHostStyleVariables(both.styles!.variables!)).toEqual(vars);
    expect(JSON.parse(JSON.stringify(both)).styles.variables).toEqual(vars);
  });

  it("omits what is absent and returns {} when there is nothing to say", () => {
    expect(hostContextStyles("", vars).styles?.css).toBeUndefined();
    expect(hostContextStyles(css, undefined)).toEqual({ styles: { css: { fonts: css } } });
    expect(hostContextStyles(css, {})).toEqual({ styles: { css: { fonts: css } } });
    expect(hostContextStyles(undefined, {})).toEqual({});
    expect(hostContextStyles("", undefined)).toEqual({});
  });
});
