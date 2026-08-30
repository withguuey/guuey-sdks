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
 *
 * Stamped under INTERNAL names (`--_guuey-chat-*`), never the documented
 * `--guuey-chat-*` channel (guuey#521): the stylesheet reads every token
 * as `var(--guuey-chat-<t>, var(--_guuey-chat-<t>))`, so a host CSS
 * variable — set on any ancestor — wins per-token over the resolved
 * theme, and the two theming channels COMPOSE instead of the inline
 * stamp silently shadowing the documented one (the trap the landing
 * home-hero embed hit four rounds of).
 */
export function themeCssVars(theme: GuueyChatTheme, mode: ThemeMode): Record<string, string> {
  const palette = theme.colors[mode];
  const vars: Record<string, string> = {
    "--_guuey-chat-accent": palette.accent,
    "--_guuey-chat-on-accent": palette.onAccent,
    "--_guuey-chat-ink": palette.ink,
    "--_guuey-chat-ink-muted": palette.inkMuted,
    "--_guuey-chat-surface": palette.surface,
    "--_guuey-chat-canvas": palette.canvas,
    "--_guuey-chat-canvas-muted": palette.canvasMuted,
    "--_guuey-chat-error": palette.error,
    "--_guuey-chat-radius": RADIUS_PX[theme.shape.radius],
    "--_guuey-chat-gap": DENSITY_GAP[theme.shape.density],
    "--_guuey-chat-scale": String(theme.typography.scale ?? 1),
  };
  if (theme.typography.fontFamily !== undefined) {
    vars["--_guuey-chat-font"] = theme.typography.fontFamily;
  }
  if (theme.typography.monoFontFamily !== undefined) {
    vars["--_guuey-chat-mono-font"] = theme.typography.monoFontFamily;
  }
  return vars;
}
