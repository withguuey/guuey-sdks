/**
 * The CSS projection of `GuueyChatTheme` (spec §6): the schema is the
 * cross-platform contract; this maps one mode's tokens onto the
 * `--guuey-chat-*` custom properties the shipped stylesheet consumes. RN
 * (3c) maps the same object to style values instead — no CSS here is
 * load-bearing for the view-model.
 */
import { CHIP_FACES, paletteChipFace, paletteCue, type ChipFaceTokens, type GuueyChatPalette, type GuueyChatTheme } from "../theme.js";

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
 * One mode's tokens as inline custom properties for the kit's roots — the
 * `<Transcript>` root and the `<GuueyChat>` surface that wraps it plus the
 * chrome outside it (chips, composer, clear-row, link-ask; guuey#1126).
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
/** A palette token read through both channels: `onAccent` → `var(--guuey-chat-on-accent, var(--_guuey-chat-on-accent))`. */
function tokenRef(token: keyof GuueyChatPalette): string {
  const name = token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `var(--guuey-chat-${name}, var(--_guuey-chat-${name}))`;
}

/** A chip face (`CHIP_FACES`) as the three internal properties the stylesheet's chip reads. */
function chipFaceVars(face: ChipFaceTokens): Record<string, string> {
  return {
    "--_guuey-chat-chip-fill": tokenRef(face.fill),
    "--_guuey-chat-chip-ink": tokenRef(face.ink),
    "--_guuey-chat-chip-edge": face.edge === undefined ? "transparent" : tokenRef(face.edge),
  };
}

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
    // Always stamped: an unstated cue derives from the accent and canvas.
    "--_guuey-chat-cue": paletteCue(palette),
    // The Retry chip's face (`paletteChipFace`), stamped as references to the
    // token channels so a host's accent, ink or surface variable still
    // reaches the chip; a host can also set --guuey-chat-chip-* itself.
    ...chipFaceVars(CHIP_FACES[paletteChipFace(palette)]),
    "--_guuey-chat-radius": RADIUS_PX[theme.shape.radius],
    "--_guuey-chat-gap": DENSITY_GAP[theme.shape.density],
    "--_guuey-chat-scale": String(theme.typography.scale ?? 1),
  };
  if (palette.link !== undefined) {
    vars["--_guuey-chat-link"] = palette.link;
  }
  if (theme.typography.fontFamily !== undefined) {
    vars["--_guuey-chat-font"] = theme.typography.fontFamily;
  }
  if (theme.typography.monoFontFamily !== undefined) {
    vars["--_guuey-chat-mono-font"] = theme.typography.monoFontFamily;
  }
  // guuey#1280: the DISPLAY face. Declared on the theme since the type roles
  // landed and consumed nowhere on the web until now, so a theme stating a
  // heading family had it silently dropped and headings inherited the body
  // font. Heading and body differ on 6 of the 8 real host pages landing
  // sampled for the harvest fixture, so this is the common case, not an edge.
  if (theme.typography.headingFontFamily !== undefined) {
    vars["--_guuey-chat-heading-font"] = theme.typography.headingFontFamily;
    // The panel title wears the stated face at the kit's in-app title size,
    // weight 400: a display face often ships one weight, and the title's 600
    // would synthesize a fake bold. Unstated, the title stays as it was.
    vars["--_guuey-chat-header-title-size"] = "20px";
    vars["--_guuey-chat-header-title-weight"] = "400";
    // A2UI titles and headings, same reason (styles.css reads it, 600 unstated).
    vars["--_guuey-chat-heading-weight"] = "400";
  }
  return vars;
}
