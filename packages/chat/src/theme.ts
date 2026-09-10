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
 *
 * The theming revision (guuey#1128 §1/§3, the joint spec with ggui#987):
 * the palette carries the ANCHORS a card's whole colour system derives
 * from — ggui's `deriveThemeVariables` is the ONE producer of every ladder,
 * container pair and on-colour (OKLCH, from these anchors), so the theme
 * states anchors only. The nine below map onto ggui's roles: `canvas` →
 * `ground`, `surface` → `container`, `canvasMuted` → `sunken`, `ink` →
 * `onGround`/`onContainer`, `inkMuted` → `onSunken`, `accent` →
 * `primary-500`, `error` → `error-500`. The optional five are the
 * revision's additions; absent means "derive" (tertiary = primary) or
 * "family absent" (the tones).
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
    /**
     * Anchor color (guuey#528) — OPTIONAL by the evolution rule (a stored
     * pre-#528 theme must keep passing the strict write gate); the default
     * theme states it, so RESOLVED themes always carry it. Stated wins on
     * the card side; unstated derives `primary-600`.
     */
    link: z.string().optional(),
    /** The second accent (ggui `tertiary-500` / `onTertiary`) — the host evidence's "two accent roles". */
    secondaryAccent: z.string().optional(),
    onSecondaryAccent: z.string().optional(),
    /** Tone anchors (ggui `{family}-500`); a family is absent on the card until its anchor is stated. */
    success: z.string().optional(),
    warning: z.string().optional(),
    info: z.string().optional(),
  })
  .loose();
export type GuueyChatPalette = z.infer<typeof GuueyChatPalette>;

/**
 * One declared face (D3 — "theme declares faces; widget loads, hands to
 * cards"). `src` MUST be an `https:` URL on an admitted host — the
 * platform's write gate enforces the allow-list; this schema is shape only.
 * The widget injects the `@font-face` rule and hands it to the card via
 * `hostContext.styles.css.fonts`; the card never fetches on its own.
 */
export const GuueyChatFace = z
  .object({
    family: z.string(),
    src: z.string(),
    weight: z.string().optional(),
    style: z.string().optional(),
    display: z.string().optional(),
  })
  .loose();
export type GuueyChatFace = z.infer<typeof GuueyChatFace>;

export const GuueyChatTheme = z
  .object({
    name: z.string(),
    /**
     * The app's DEFAULT APPEARANCE (theme-as-code §3, revised by D4): the
     * mode the overlay pins when the host announces nothing. OPTIONAL and
     * default-less on purpose: absent = "not stated". The VIEWER's runtime
     * light/dark choice outranks it everywhere and stays a component prop —
     * chat components never read this field.
     */
    mode: z.enum(["light", "dark"]).optional(),
    /** BOTH palettes always present — mode is the consumer's runtime choice. */
    colors: z.object({ light: GuueyChatPalette, dark: GuueyChatPalette }).loose(),
    typography: z
      .object({
        fontFamily: z.string().optional(),
        monoFontFamily: z.string().optional(),
        /** Display face (ggui `font-family-heading`); falls back to the body family. */
        headingFontFamily: z.string().optional(),
        /** ONE size knob — ggui's `font.ramp.base` multiplier; the eight stops derive. */
        scale: z.number().optional(),
        /** Declared faces — see {@link GuueyChatFace}. Replaces wholesale on resolution. */
        faces: z.array(GuueyChatFace).optional(),
      })
      .loose(),
    shape: z
      .object({
        radius: z.enum(["none", "soft", "round"]),
        /** The WIDGET's own knob (D7: density is a generator PROFILE — never projected to cards). */
        density: z.enum(["compact", "comfortable"]),
        /** Shadow colour / intensity (0–1) — the per-app half of elevation; the ladder is ggui's. */
        shadow: z
          .object({ color: z.string().optional(), intensity: z.number().optional() })
          .loose()
          .optional(),
        /**
         * Glass (guuey#1151) — the widget CHROME's translucency: `opacity`
         * is the chrome fill's alpha in 0–1 (1 = opaque, i.e. glass off),
         * `blur` the backdrop blur in px (0–64; the loader applies 16px when
         * unstated). CHROME ONLY: the host-page panel, ask bar and cold-open
         * shell, and inside the frame the full-bleed canvas strips (page
         * root, header, composer strip, footer). It never reaches generated
         * cards or bubbles — the (1b) coverage attestation lists it as
         * uncovered BY DESIGN. Shape only here (the platform's write gate
         * holds the bands); one value in the document, next to `shadow`, so
         * it is never a migration.
         */
        glass: z
          .object({ opacity: z.number(), blur: z.number().optional() })
          .loose()
          .optional(),
      })
      .loose(),
    /**
     * Per-court override DOCUMENTS (guuey#519), keyed by serving court —
     * declared vocabulary (guuey#536: the manifest grammar mirrors this
     * schema key-for-key, so the member must be stated, not passthrough).
     * Entries are partial theme documents; `resolveCourtTheme` owns the
     * per-token layering and resolved themes are always court-free.
     */
    courts: z.record(z.string(), z.unknown()).optional(),
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
      link: "#111318",
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
      link: "#e8e9ee",
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
      // slime-4, the founder-minted brand link green (guuey#528, 08-30) —
      // the ladder had no readable green at link weight on light.
      link: "#4e7a0e",
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
      // On dark the ladder's own slime IS readable at link weight — the
      // #528 ruling minted slime-4 for LIGHT, where #b8ff3a is not.
      link: "#b8ff3a",
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
    typography: GuueyChatTheme.shape.typography.optional(),
    shape: GuueyChatTheme.shape.shape.partial().loose().optional(),
  })
  .loose();

/** The known token set — the per-token fallback iterates THIS, so unknown
 * (future-schema) keys are preserved by the parse but never projected.
 * DERIVED from the schema so a palette addition cannot be forgotten here. */
const PALETTE_TOKENS = Object.keys(GuueyChatPalette.shape) as ReadonlyArray<
  keyof typeof GuueyChatPalette.shape
>;

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
  const shadow = p.shape?.shadow ?? base.shape.shadow;
  const glass = p.shape?.glass ?? base.shape.glass;
  return {
    name: p.name ?? base.name,
    // `mode` is default-less (the package themes state none): it appears on
    // the resolved theme only when SOME layer stated it — an absent
    // statement must stay visibly absent, not become a default. The same
    // holds for the optional palette anchors, `faces`, `shadow` and `glass`.
    ...(mode !== undefined ? { mode } : {}),
    colors: {
      light: mergePalette(base.colors.light, p.colors?.light),
      dark: mergePalette(base.colors.dark, p.colors?.dark),
    },
    // Member-wise over the base; a stated `faces` list REPLACES the base's
    // (a face list is one declaration, never merged per element).
    typography: { ...base.typography, ...(p.typography ?? {}) },
    shape: {
      radius: p.shape?.radius ?? base.shape.radius,
      density: p.shape?.density ?? base.shape.density,
      ...(shadow !== undefined ? { shadow } : {}),
      ...(glass !== undefined ? { glass } : {}),
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
