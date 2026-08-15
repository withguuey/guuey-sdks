/**
 * Theme = platform data (wave-3a design §6, founder-ratified).
 *
 * ONE serializable token schema, four consumers: this package's default
 * theme, the per-app theme configured on platform.guuey.com (console editor
 * + app-record field + runtime delivery — a platform-lane slice sharing this
 * schema), the widget (defaults to the app's configured theme), and portal
 * (defaults to the GUUEY theme, per-app override).
 *
 * EVOLUTION RULE (spec §6): this schema becomes PERSISTED platform data —
 * changes are additive-only, parsing is LENIENT (unknown keys pass through,
 * never rejected), and every new token ships with a default-theme fallback.
 * A stored theme from any earlier schema version must always parse:
 * `resolveTheme` merges per-token over the default, so a half-configured (or
 * old-schema) app theme can never produce an unreadable surface.
 *
 * The React kit (3b) projects these as `--guuey-chat-*` CSS custom
 * properties; RN (3c) maps the same object to style values — the schema is
 * the cross-platform contract, CSS is one projection.
 */
import { z } from "zod";

/**
 * One mode's palette — grounded in the widget's shipped `--guuey-*`
 * custom-property precedent (`apps/widget/src/app/globals.css`).
 */
export const GuueyChatPalette = z
  .object({
    accent: z.string(),
    onAccent: z.string(),
    ink: z.string(),
    inkMuted: z.string(),
    surface: z.string(),
    canvas: z.string(),
    canvasMuted: z.string(),
    error: z.string(),
  })
  .loose();
export type GuueyChatPalette = z.infer<typeof GuueyChatPalette>;

export const GuueyChatTheme = z
  .object({
    name: z.string(),
    /** BOTH palettes always present — mode is the consumer's runtime choice. */
    colors: z.object({ light: GuueyChatPalette, dark: GuueyChatPalette }).loose(),
    typography: z
      .object({
        fontFamily: z.string().optional(),
        monoFontFamily: z.string().optional(),
        scale: z.number().optional(),
      })
      .loose(),
    shape: z
      .object({
        radius: z.enum(["none", "soft", "round"]),
        density: z.enum(["compact", "comfortable"]),
      })
      .loose(),
  })
  .loose();
export type GuueyChatTheme = z.infer<typeof GuueyChatTheme>;

/**
 * The brand-neutral-but-polished package default — the theme a builder gets
 * before configuring anything, and the per-token fallback floor every other
 * theme resolves against.
 */
export const DEFAULT_CHAT_THEME: GuueyChatTheme = {
  name: "default",
  colors: {
    light: {
      accent: "#2f6bff",
      onAccent: "#ffffff",
      ink: "#111318",
      inkMuted: "#5b6270",
      surface: "#ffffff",
      canvas: "#f7f7f5",
      canvasMuted: "#eceded",
      error: "#d64545",
    },
    dark: {
      accent: "#5c8dff",
      onAccent: "#0b0d12",
      ink: "#e8e9ee",
      inkMuted: "#9aa0ac",
      surface: "#1b1e26",
      canvas: "#0f1116",
      canvasMuted: "#1b1e26",
      error: "#ff6b6b",
    },
  },
  typography: {},
  shape: { radius: "soft", density: "comfortable" },
};

/**
 * The guuey visual identity — portal's default, and the look an app
 * "unleashes" its own theme against. Values are the widget's shipped
 * slime/ink/fog tokens verbatim; the saturated accents deliberately do not
 * change between modes (they read the same on any canvas — the widget's own
 * documented posture).
 */
export const GUUEY_CHAT_THEME: GuueyChatTheme = {
  name: "guuey",
  colors: {
    light: {
      accent: "#b8ff3a",
      onAccent: "#0e1014",
      ink: "#0e1014",
      inkMuted: "#1a1d24",
      surface: "#ffffff",
      canvas: "#f6f5ee",
      canvasMuted: "#ecebe0",
      error: "#ff5b5b",
    },
    dark: {
      accent: "#b8ff3a",
      onAccent: "#0e1014",
      ink: "#e7e8ec",
      inkMuted: "#9aa0ac",
      surface: "#1a1d24",
      canvas: "#0e1014",
      canvasMuted: "#1a1d24",
      error: "#ff5b5b",
    },
  },
  typography: {},
  shape: { radius: "soft", density: "comfortable" },
};

/** The candidate shape `resolveTheme` accepts: anything partial, unknown, or stale. */
const PartialPalette = GuueyChatPalette.partial();
const PartialTheme = z
  .object({
    name: z.string().optional(),
    colors: z
      .object({ light: PartialPalette.optional(), dark: PartialPalette.optional() })
      .loose()
      .optional(),
    typography: GuueyChatTheme.shape.typography.optional(),
    shape: GuueyChatTheme.shape.shape.partial().loose().optional(),
  })
  .loose();

/** The known token set — the per-token fallback iterates THIS, so unknown
 * (future-schema) keys are preserved by the parse but never projected. */
const PALETTE_TOKENS = [
  "accent",
  "onAccent",
  "ink",
  "inkMuted",
  "surface",
  "canvas",
  "canvasMuted",
  "error",
] as const;

function mergePalette(
  base: GuueyChatPalette,
  over: z.infer<typeof PartialPalette> | undefined,
): GuueyChatPalette {
  if (!over) return { ...base };
  const merged: GuueyChatPalette = { ...base };
  for (const token of PALETTE_TOKENS) {
    const value = over[token];
    if (typeof value === "string") merged[token] = value;
  }
  return merged;
}

/**
 * Resolve a stored (possibly partial, possibly old-schema, possibly not even
 * object-shaped) theme against a base — per-token fallback, lenient parse.
 * NEVER throws: unparseable input resolves to the base theme untouched.
 */
export function resolveTheme(
  candidate: unknown,
  base: GuueyChatTheme = DEFAULT_CHAT_THEME,
): GuueyChatTheme {
  const parsed = PartialTheme.safeParse(candidate);
  if (!parsed.success) return { ...base, colors: { light: { ...base.colors.light }, dark: { ...base.colors.dark } } };
  const p = parsed.data;
  return {
    name: p.name ?? base.name,
    colors: {
      light: mergePalette(base.colors.light, p.colors?.light),
      dark: mergePalette(base.colors.dark, p.colors?.dark),
    },
    typography: { ...base.typography, ...(p.typography ?? {}) },
    shape: {
      radius: p.shape?.radius ?? base.shape.radius,
      density: p.shape?.density ?? base.shape.density,
    },
  };
}
