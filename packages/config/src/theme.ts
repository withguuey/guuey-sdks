/**
 * `guuey.json#app.theme` — the app's chat theme AS CODE (theme-as-code,
 * guuey#341 spec §2/§3).
 *
 * The manifest block IS the stored `GuueyApp.chatTheme` document (the
 * `@guuey/chat` `GuueyChatTheme` vocabulary — ONE document, never a second
 * theme language), submitted STRICTLY: unknown keys reject loudly in CI
 * where the stored/read tier stays lenient (strict submit, lenient store —
 * the reconcile philosophy split, spec D3). The schemas here are
 * hand-mirrored strict twins of the kit's lenient ones; `theme.sync.test.ts`
 * pins the vocabularies key-for-key so the mirror cannot drift (the same
 * pattern as the CLI's wire mirrors — this package must not carry the kit
 * as a runtime dependency just to borrow eight key names).
 *
 * Colour VALUES are validated server-side by the platform's one grammar
 * (6/8-digit hex + canonical `rgb()`/`rgba()` — `validateChatTheme`); this
 * schema deliberately checks shape only, so the CLI's plan/apply surfaces
 * the server validator's exact message rather than a divergent local one.
 *
 * Sections a manifest omits (`name`, `typography`, `shape`) are filled with
 * the kit defaults by the SERVER's one derivation site at reconcile time —
 * constants, so the fill is deterministic and the idempotency byte-match
 * holds.
 */
import { z } from 'zod';

const ColorValue = z.string().min(1).max(64);

/** One mode's full palette — every token stated (the kit requires complete palettes). */
export const ThemePaletteV1 = z.strictObject({
  accent: ColorValue,
  onAccent: ColorValue,
  ink: ColorValue,
  inkMuted: ColorValue,
  surface: ColorValue,
  canvas: ColorValue,
  canvasMuted: ColorValue,
  error: ColorValue,
  /**
   * Anchor colour (guuey#528) — OPTIONAL: a palette slot a manifest may
   * leave unstated (the kit's neutral default = ink covers it), unlike the
   * eight required tokens above. Stated → validated + emitted; unstated →
   * not emitted (the stated-vocabulary rule).
   */
  link: ColorValue.optional(),
  /**
   * The theming revision's anchors (guuey#1128 §1/§3): the second accent
   * (ggui `tertiary`) and the tone anchors. Every ladder, container pair
   * and on-colour is DERIVED from anchors by ggui's one producer — a
   * manifest states anchors only; `ramps` left the vocabulary with it.
   */
  secondaryAccent: ColorValue.optional(),
  onSecondaryAccent: ColorValue.optional(),
  success: ColorValue.optional(),
  warning: ColorValue.optional(),
  info: ColorValue.optional(),
});
export type ThemePaletteV1 = z.infer<typeof ThemePaletteV1>;

/** One declared face (D3). `src` must be `https:` on an admitted host — the server's write gate decides. */
export const ThemeFaceV1 = z.strictObject({
  family: z.string().min(1).max(200),
  src: z.string().min(1).max(2048),
  weight: z.string().min(1).max(40).optional(),
  style: z.string().min(1).max(40).optional(),
  display: z.string().min(1).max(40).optional(),
});
export type ThemeFaceV1 = z.infer<typeof ThemeFaceV1>;

/** Shadow colour / intensity — the per-app half of elevation. */
export const ThemeShadowV1 = z.strictObject({
  color: ColorValue.optional(),
  intensity: z.number().min(0).max(1).optional(),
});
export type ThemeShadowV1 = z.infer<typeof ThemeShadowV1>;

/**
 * The manifest theme block. `mode` is REQUIRED (spec §3): a theme managed
 * as code states its default appearance — the mode the overlay pins when
 * the host announces nothing (the host's runtime mode outranks it, D4).
 */
const ThemeTypographyV1 = z
  .strictObject({
    fontFamily: z.string().min(1).max(200).optional(),
    monoFontFamily: z.string().min(1).max(200).optional(),
    headingFontFamily: z.string().min(1).max(200).optional(),
    scale: z.number().min(0.75).max(1.5).optional(),
    faces: z.array(ThemeFaceV1).max(8).optional(),
  })
  .optional();
const ThemeShapeV1 = z
  .strictObject({
    radius: z.enum(['none', 'soft', 'round']),
    density: z.enum(['compact', 'comfortable']),
    shadow: ThemeShadowV1.optional(),
  })
  .optional();

/**
 * Court keys — short machine identifiers (`"guuey"`, `"ggui"`, …).
 * SYNC: mirrors `COURT_KEY_RE` in `backend/libs/cli-wire/chat-theme.ts`
 * (the server's strict courts write gate) — the two ends of the apply
 * pipe must agree on the key grammar.
 */
const CourtKeyV1 = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/**
 * One court's override document (guuey#519 / the #536 grammar completion):
 * a PARTIAL theme — every member optional (present members merge per-token
 * over the base at resolution), palettes partial, and no nested `courts`
 * (courts do not nest — the server gate enforces the same).
 */
export const AppCourtThemeV1 = z.strictObject({
  name: z.string().min(1).max(64).optional(),
  mode: z.enum(['light', 'dark']).optional(),
  colors: z
    .strictObject({
      light: ThemePaletteV1.partial().optional(),
      dark: ThemePaletteV1.partial().optional(),
    })
    .optional(),
  typography: ThemeTypographyV1,
  shape: z
    .strictObject({
      radius: z.enum(['none', 'soft', 'round']).optional(),
      density: z.enum(['compact', 'comfortable']).optional(),
      shadow: ThemeShadowV1.optional(),
    })
    .optional(),
});
export type AppCourtThemeV1 = z.infer<typeof AppCourtThemeV1>;

export const AppThemeV1 = z.strictObject({
  name: z.string().min(1).max(64).optional(),
  mode: z.enum(['light', 'dark']),
  colors: z.strictObject({ light: ThemePaletteV1, dark: ThemePaletteV1 }),
  typography: ThemeTypographyV1,
  shape: ThemeShapeV1,
  /**
   * Per-court override documents (guuey#519 — brand is never a default:
   * the base above stays court-neutral, a court's look exists only under
   * its explicit key, and an undeclared court resolves to the base).
   */
  courts: z.record(CourtKeyV1, AppCourtThemeV1).optional(),
});
export type GuueyAppTheme = z.infer<typeof AppThemeV1>;
