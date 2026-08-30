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

/**
 * STATED ramp slots (theme-as-code, guuey#341 spec §3 — never derived).
 * Closed per-family sets: `accent` carries the full ladder (the
 * 500/600/700 floor is a WRITE/COMPILE rule, not a schema rule — the
 * schema admits any stated subset so a stale stored document still parses);
 * the status families carry their tone-500 slot. Ramps live BESIDE the
 * palettes (`theme.ramps.{light,dark}`), never inside them — the flat
 * palette record is a load-bearing invariant (token lists are DERIVED from
 * its shape by every platform gate).
 */
export const GuueyChatAccentRamp = z
  .object({
    "100": z.string().optional(),
    "300": z.string().optional(),
    "500": z.string().optional(),
    "600": z.string().optional(),
    "700": z.string().optional(),
    "800": z.string().optional(),
    "900": z.string().optional(),
  })
  .loose();
export type GuueyChatAccentRamp = z.infer<typeof GuueyChatAccentRamp>;

export const GuueyChatErrorRamp = z
  .object({
    "500": z.string().optional(),
    "600": z.string().optional(),
    "700": z.string().optional(),
  })
  .loose();
export type GuueyChatErrorRamp = z.infer<typeof GuueyChatErrorRamp>;

export const GuueyChatToneRamp = z.object({ "500": z.string().optional() }).loose();
export type GuueyChatToneRamp = z.infer<typeof GuueyChatToneRamp>;

/** One mode's stated ramp families — every family optional. */
export const GuueyChatRampSet = z
  .object({
    accent: GuueyChatAccentRamp.optional(),
    error: GuueyChatErrorRamp.optional(),
    success: GuueyChatToneRamp.optional(),
    warning: GuueyChatToneRamp.optional(),
    info: GuueyChatToneRamp.optional(),
  })
  .loose();
export type GuueyChatRampSet = z.infer<typeof GuueyChatRampSet>;

export const GuueyChatRamps = z
  .object({
    light: GuueyChatRampSet.optional(),
    dark: GuueyChatRampSet.optional(),
  })
  .loose();
export type GuueyChatRamps = z.infer<typeof GuueyChatRamps>;

export const GuueyChatTheme = z
  .object({
    name: z.string(),
    /**
     * The app's CANONICAL presentation mode (theme-as-code §3) — what the
     * ggui stamp pins its render slice to. OPTIONAL and default-less on
     * purpose: absent = "not stated", and the platform's legacy polarity
     * derivation stands. Distinct from the VIEWER's runtime light/dark
     * choice, which stays a component prop — chat components never read
     * this field.
     */
    mode: z.enum(["light", "dark"]).optional(),
    /** BOTH palettes always present — mode is the consumer's runtime choice. */
    colors: z.object({ light: GuueyChatPalette, dark: GuueyChatPalette }).loose(),
    /** Stated ramp slots per mode — see {@link GuueyChatRamps}. */
    ramps: GuueyChatRamps.optional(),
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
 *
 * The accent is MONOCHROME (= ink) by founder ruling (guuey#521): an
 * unthemed embed must never carry a foreign accent into a host's product —
 * the old `#2f6bff` blue made every zero-config embed read "off-the-shelf
 * chat vendor" inside someone else's brand (#414's lesson, mirrored). Ink
 * as accent means the send button and user pill render as neutral
 * ink-on-canvas and disappear into any host; a brand accent is a CHOICE
 * (theme prop or one `--guuey-chat-accent` CSS variable), never a default.
 */
export const DEFAULT_CHAT_THEME: GuueyChatTheme = {
  name: "default",
  colors: {
    light: {
      accent: "#111318",
      onAccent: "#ffffff",
      ink: "#111318",
      inkMuted: "#5b6270",
      surface: "#ffffff",
      canvas: "#f7f7f5",
      canvasMuted: "#eceded",
      error: "#d64545",
    },
    dark: {
      accent: "#e8e9ee",
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
    mode: GuueyChatTheme.shape.mode.optional(),
    colors: z
      .object({ light: PartialPalette.optional(), dark: PartialPalette.optional() })
      .loose()
      .optional(),
    ramps: GuueyChatRamps.optional(),
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
  const mode = p.mode ?? base.mode;
  const ramps = mergeRamps(base.ramps, p.ramps);
  return {
    name: p.name ?? base.name,
    // `mode`/`ramps` are default-less (the package themes state neither):
    // they appear on the resolved theme only when SOME layer stated them —
    // an absent statement must stay visibly absent, not become a default.
    ...(mode !== undefined ? { mode } : {}),
    colors: {
      light: mergePalette(base.colors.light, p.colors?.light),
      dark: mergePalette(base.colors.dark, p.colors?.dark),
    },
    ...(ramps !== undefined ? { ramps } : {}),
    typography: { ...base.typography, ...(p.typography ?? {}) },
    shape: {
      radius: p.shape?.radius ?? base.shape.radius,
      density: p.shape?.density ?? base.shape.density,
    },
  };
}

/**
 * The court-override member a theme DOCUMENT may carry (guuey#519).
 * Values are theme documents themselves (validated by `resolveTheme`'s own
 * lenient parse at resolution time, so a partial or future-schema court
 * entry degrades per-token like any stored theme).
 */
const CourtOverrides = z
  .object({ courts: z.record(z.string(), z.unknown()).optional() })
  .loose();

/**
 * Per-court theme resolution (guuey#519 — the #414 rule generalized).
 *
 * A theme document may carry `courts`: explicit per-court override
 * documents keyed by serving court (`"guuey"`, `"ggui"`, …). A surface
 * resolves ITS court: the court's override resolved per-token OVER the
 * resolved base document when declared, else the base alone. **Brand is
 * never a default** — an undeclared or unknown court gets the neutral
 * base by construction, and readers that never heard of `courts`
 * (lenient parsers projecting only known tokens) keep reading the base
 * untouched, so no court can inherit another court's brand.
 *
 * Resolved themes are court-free: `courts` never survives resolution.
 * NEVER throws; unparseable input degrades exactly as `resolveTheme`.
 */
export function resolveCourtTheme(
  candidate: unknown,
  court: string,
  base: GuueyChatTheme = DEFAULT_CHAT_THEME,
): GuueyChatTheme {
  const resolvedBase = resolveTheme(candidate, base);
  const parsed = CourtOverrides.safeParse(candidate);
  if (!parsed.success) return resolvedBase;
  const override = parsed.data.courts?.[court];
  if (override === undefined) return resolvedBase;
  return resolveTheme(override, resolvedBase);
}

/** Slot-level merge of two ramp statements (candidate slots win per slot). */
function mergeRampSet(
  base: GuueyChatRampSet | undefined,
  over: GuueyChatRampSet | undefined,
): GuueyChatRampSet | undefined {
  if (base === undefined) return over;
  if (over === undefined) return base;
  const merged: GuueyChatRampSet = { ...base };
  for (const family of ["accent", "error", "success", "warning", "info"] as const) {
    const b = base[family];
    const o = over[family];
    if (o === undefined) continue;
    merged[family] = b === undefined ? o : { ...b, ...o };
  }
  return merged;
}

function mergeRamps(
  base: GuueyChatRamps | undefined,
  over: GuueyChatRamps | undefined,
): GuueyChatRamps | undefined {
  if (base === undefined) return over;
  if (over === undefined) return base;
  const light = mergeRampSet(base.light, over.light);
  const dark = mergeRampSet(base.dark, over.dark);
  return {
    ...(light !== undefined ? { light } : {}),
    ...(dark !== undefined ? { dark } : {}),
  };
}
