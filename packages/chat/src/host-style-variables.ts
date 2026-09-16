/**
 * The host palette a guuey surface announces to every mounted card
 * (guuey#1128 — the one guuey leg of the token-map audit that was left).
 *
 * MCP-Apps hosts announce their palette as spec `--color-*` custom
 * properties in `hostContext.styles.variables`. ggui's runtime maps the
 * slots below onto its own token ladder (ggui#572, `host-palette-bridge.ts`:
 * background primary/secondary/tertiary → `ground`/`container`/`sunken`,
 * text primary/secondary/tertiary → `onGround`+`onContainer`/`onSunken`/
 * `neutral-500`, text danger/success/warning/info → the `{family}-500`
 * stops, border primary/secondary → `outline`/`outlineVariant`) and merges
 * them BENEATH the app's own theme — the founder's ggui#573 ruling, "slice
 * wins, host fallback". So this layer never overrides a stated theme; it
 * fills exactly the tokens the theme's overlay does not derive (container,
 * outline, the neutral ladder), which is where a themed app's card was still
 * showing ggui's defaults — the audit's "black outlined buttons on a violet
 * theme". Before this, every guuey mount announced `theme` + `styles.css.fonts`
 * only, so ggui's fallback layer was always empty.
 *
 * Every value is one of the theme's OWN anchors — nothing is invented and
 * nothing is computed. The two border slots take the theme's muted ink and
 * its muted canvas: the theme's own tones for "a line on the ink side" and
 * "a hairline on the surface side". Slots the palette states nothing for
 * (the tone families, `errorContainer`) are omitted, so ggui keeps its own
 * OKLCH derivation for them — omitting beats guessing.
 */
import { hostStyleVariablesRecord, type McpUiStyles } from "@guuey/mcp-apps-host";
import type { GuueyChatTheme } from "./theme.js";
import type { ThemeMode } from "./react/theme-css.js";

/** The spec `--color-*` slots this host announces — exactly the ones ggui's bridge consumes. */
export const HOST_STYLE_VARIABLE_KEYS = [
  "--color-background-primary",
  "--color-background-secondary",
  "--color-background-tertiary",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-text-danger",
  "--color-text-success",
  "--color-text-warning",
  "--color-text-info",
  "--color-border-primary",
  "--color-border-secondary",
] as const;
export type HostStyleVariableKey = (typeof HOST_STYLE_VARIABLE_KEYS)[number];
export type HostStyleVariables = Partial<Record<HostStyleVariableKey, string>>;

/**
 * The announced palette for `mode`, from the RESOLVED theme (`resolveTheme`
 * output — the default theme states every required anchor, so the seven
 * required slots are always present; the tone slots ride only when the
 * theme states that family).
 */
export function hostStyleVariables(theme: GuueyChatTheme, mode: ThemeMode): HostStyleVariables {
  const p = theme.colors[mode];
  return {
    "--color-background-primary": p.canvas, // ggui `ground` — the canvas a card sits on
    "--color-background-secondary": p.surface, // `container` — the card itself
    "--color-background-tertiary": p.canvasMuted, // `sunken` — recessed wells
    "--color-text-primary": p.ink, // `onGround` + `onContainer`
    "--color-text-secondary": p.inkMuted, // `onSunken`
    "--color-text-tertiary": p.inkMuted, // `neutral-500` — the quietest ink is the muted ink
    "--color-text-danger": p.error, // `error-500`
    ...(p.success !== undefined ? { "--color-text-success": p.success } : {}),
    ...(p.warning !== undefined ? { "--color-text-warning": p.warning } : {}),
    ...(p.info !== undefined ? { "--color-text-info": p.info } : {}),
    "--color-border-primary": p.inkMuted, // `outline` — a line on the ink side, in the theme's own tone
    "--color-border-secondary": p.canvasMuted, // `outlineVariant` — a hairline on the surface side
  };
}

/**
 * The `styles` member of a card's `hostContext`, from the two things a guuey
 * host hands every card: the theme's `@font-face` CSS (guuey#1195) and the
 * palette above. Returns `{}` when there is nothing to say, so a mount site
 * can spread it unconditionally.
 */
export function hostContextStyles(
  fontsCss: string | undefined,
  variables: HostStyleVariables | undefined,
): { styles?: { css?: { fonts: string }; variables?: McpUiStyles } } {
  const css = fontsCss !== undefined && fontsCss !== "" ? { css: { fonts: fontsCss } } : {};
  // The spec types `variables` as EVERY key with an optional value (its own
  // note: equivalent to a Partial, shaped for zod) — the kit hands it the
  // complete record; the wire carries only the announced slots.
  const vars =
    variables !== undefined && Object.keys(variables).length > 0
      ? { variables: hostStyleVariablesRecord(variables) }
      : {};
  const styles = { ...css, ...vars };
  return Object.keys(styles).length > 0 ? { styles } : {};
}
