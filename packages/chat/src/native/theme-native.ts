/**
 * The React Native theme projection (spec §6): `GuueyChatTheme` is the
 * cross-platform contract; CSS custom properties are the WEB projection
 * (`react/theme-css.ts`), and this module is the native one — the same
 * schema resolved into a flat token object RN components read as style
 * values. No new vocabulary: every field here derives from the schema.
 */
import { resolveTheme, type GuueyChatPalette, type GuueyChatTheme } from "../theme.js";

export type NativeThemeMode = "light" | "dark";

/** The resolved style tokens the native components consume. */
export interface NativeChatTokens {
  /** The mode-resolved palette (per-token fallback already applied). */
  palette: GuueyChatPalette;
  /** shape.radius → px: none 0, soft 10, round 18. */
  radius: number;
  /** shape.density → the bubble padding / row gap pair. */
  pad: number;
  gap: number;
  /** typography — undefined means the platform default font. */
  fontFamily: string | undefined;
  monoFontFamily: string | undefined;
  /** Base body size in sp, typography.scale applied (default 15). */
  fontSize: number;
}

const RADIUS: Record<GuueyChatTheme["shape"]["radius"], number> = {
  none: 0,
  soft: 10,
  round: 18,
};

/** Resolve a (possibly partial/stale) theme + mode into native tokens. */
export function resolveNativeTheme(theme: GuueyChatTheme, mode: NativeThemeMode): NativeChatTokens {
  const resolved = resolveTheme(theme);
  const palette = resolved.colors[mode];
  const comfortable = resolved.shape.density === "comfortable";
  return {
    palette,
    radius: RADIUS[resolved.shape.radius],
    pad: comfortable ? 12 : 8,
    gap: comfortable ? 10 : 6,
    fontFamily: resolved.typography.fontFamily,
    monoFontFamily: resolved.typography.monoFontFamily,
    fontSize: Math.round(15 * (resolved.typography.scale ?? 1)),
  };
}
