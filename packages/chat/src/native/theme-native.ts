/**
 * The React Native theme projection (spec §6): `GuueyChatTheme` is the
 * cross-platform contract; CSS custom properties are the WEB projection
 * (`react/theme-css.ts`), and this module is the native one — the same
 * schema resolved into a flat token object RN components read as style
 * values. No new vocabulary: every field here derives from the schema.
 */
import { CHIP_FACES, paletteChipFace, paletteCue, resolveTheme, type GuueyChatPalette, type GuueyChatTheme } from "../theme.js";

export type NativeThemeMode = "light" | "dark";

/** The resolved style tokens the native components consume. */
export interface NativeChatTokens {
  /** The mode-resolved palette (per-token fallback already applied). */
  palette: GuueyChatPalette;
  /** The palette's cue (`paletteCue`): the streaming caret and other one-bit strokes. */
  cue: string;
  /**
   * A small action chip on the canvas (Retry on a failed send), by
   * `paletteChipFace`: the accent fill under on-accent words, or the hollow
   * face (surface fill, 1px ink edge, ink words) when the accent does not
   * stand out on the canvas. `edge` is undefined on the accent face.
   */
  chip: { fill: string; ink: string; edge: string | undefined };
  /** shape.radius → px: none 0, soft 10, round 18. */
  radius: number;
  /** shape.density → the bubble padding / row gap pair. */
  pad: number;
  gap: number;
  /** typography — undefined means the platform default font. */
  fontFamily: string | undefined;
  monoFontFamily: string | undefined;
  /**
   * guuey#1280 — the DISPLAY face. `undefined` means "no distinct heading
   * family stated", and a heading then renders in `fontFamily` exactly as
   * before; the web fallback chain says the same thing with `inherit`.
   */
  headingFontFamily: string | undefined;
  /** Base body size in sp, typography.scale applied (default 15). */
  fontSize: number;
}

const RADIUS: Record<GuueyChatTheme["shape"]["radius"], number> = {
  none: 0,
  soft: 10,
  round: 18,
};

/** The palette's chip face (`CHIP_FACES`) as native colours. */
function nativeChip(palette: GuueyChatPalette): NativeChatTokens["chip"] {
  const face = CHIP_FACES[paletteChipFace(palette)];
  return { fill: palette[face.fill], ink: palette[face.ink], edge: face.edge === undefined ? undefined : palette[face.edge] };
}

/** Resolve a (possibly partial/stale) theme + mode into native tokens. */
export function resolveNativeTheme(theme: GuueyChatTheme, mode: NativeThemeMode): NativeChatTokens {
  const resolved = resolveTheme(theme);
  const palette = resolved.colors[mode];
  const comfortable = resolved.shape.density === "comfortable";
  return {
    palette,
    cue: paletteCue(palette),
    chip: nativeChip(palette),
    radius: RADIUS[resolved.shape.radius],
    pad: comfortable ? 12 : 8,
    gap: comfortable ? 10 : 6,
    fontFamily: resolved.typography.fontFamily,
    monoFontFamily: resolved.typography.monoFontFamily,
    headingFontFamily: resolved.typography.headingFontFamily,
    fontSize: Math.round(15 * (resolved.typography.scale ?? 1)),
  };
}
