/**
 * The CSS projection of `GuueyChatTheme` (spec §6): the schema is the
 * cross-platform contract; this maps one mode's tokens onto the
 * `--guuey-chat-*` custom properties the shipped stylesheet consumes. RN
 * (3c) maps the same object to style values instead — no CSS here is
 * load-bearing for the view-model.
 */
import type { GuueyChatTheme } from "../theme.js";

export type ThemeMode = "light" | "dark";

const RADIUS_PX: Record<GuueyChatTheme["shape"]["radius"], string> = {
  none: "0px",
  soft: "10px",
  round: "18px",
};

const DENSITY_GAP: Record<GuueyChatTheme["shape"]["density"], string> = {
  compact: "6px",
  comfortable: "10px",
};

/**
 * One mode's tokens as inline custom properties for the transcript root.
 * Returned as a plain record so callers can spread it into `style` or emit
 * a stylesheet from it.
 */
export function themeCssVars(theme: GuueyChatTheme, mode: ThemeMode): Record<string, string> {
  const palette = theme.colors[mode];
  const vars: Record<string, string> = {
    "--guuey-chat-accent": palette.accent,
    "--guuey-chat-on-accent": palette.onAccent,
    "--guuey-chat-ink": palette.ink,
    "--guuey-chat-ink-muted": palette.inkMuted,
    "--guuey-chat-surface": palette.surface,
    "--guuey-chat-canvas": palette.canvas,
    "--guuey-chat-canvas-muted": palette.canvasMuted,
    "--guuey-chat-error": palette.error,
    "--guuey-chat-radius": RADIUS_PX[theme.shape.radius],
    "--guuey-chat-gap": DENSITY_GAP[theme.shape.density],
    "--guuey-chat-scale": String(theme.typography.scale ?? 1),
  };
  if (theme.typography.fontFamily !== undefined) {
    vars["--guuey-chat-font"] = theme.typography.fontFamily;
  }
  if (theme.typography.monoFontFamily !== undefined) {
    vars["--guuey-chat-mono-font"] = theme.typography.monoFontFamily;
  }
  return vars;
}
