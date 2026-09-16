/**
 * The spec's `hostContext.styles.variables` record, complete (guuey#1128).
 *
 * `@modelcontextprotocol/ext-apps` types `McpUiStyles` as
 * `Record<McpUiStyleVariableKey, string | undefined>` — every key PRESENT,
 * value optional — and says why in its own doc: "rather than
 * `Partial<Record<K, string>>` for compatibility with Zod schema generation.
 * Both are functionally equivalent for validation." So a host that announces
 * a partial palette must hand the type a complete record whose unset slots
 * are `undefined`. On the wire the two are the same bytes (`JSON.stringify`
 * drops `undefined`), the app-side `applyHostStyleVariables` skips
 * `undefined` values, and ggui's bridge takes `string | undefined` per slot.
 *
 * {@link EMPTY_HOST_STYLE_VARIABLES} is that complete record with nothing
 * set — a MIRROR of the spec's key union that the compiler enforces both
 * ways (`Record<McpUiStyleVariableKey, undefined>`: a key missing here or a
 * key the spec dropped is a type error the moment the dependency moves), and
 * `host-style-variables.test.ts` pins it against the spec's own zod schema
 * at runtime. {@link hostStyleVariablesRecord} completes a partial palette.
 */
import type { McpUiStyleVariableKey, McpUiStyles } from "@modelcontextprotocol/ext-apps";

export type { McpUiStyleVariableKey, McpUiStyles };

/** Every spec style-variable key, unset. Spread a partial palette over it. */
export const EMPTY_HOST_STYLE_VARIABLES: Readonly<Record<McpUiStyleVariableKey, undefined>> = {
  "--color-background-primary": undefined,
  "--color-background-secondary": undefined,
  "--color-background-tertiary": undefined,
  "--color-background-inverse": undefined,
  "--color-background-ghost": undefined,
  "--color-background-info": undefined,
  "--color-background-danger": undefined,
  "--color-background-success": undefined,
  "--color-background-warning": undefined,
  "--color-background-disabled": undefined,
  "--color-text-primary": undefined,
  "--color-text-secondary": undefined,
  "--color-text-tertiary": undefined,
  "--color-text-inverse": undefined,
  "--color-text-ghost": undefined,
  "--color-text-info": undefined,
  "--color-text-danger": undefined,
  "--color-text-success": undefined,
  "--color-text-warning": undefined,
  "--color-text-disabled": undefined,
  "--color-border-primary": undefined,
  "--color-border-secondary": undefined,
  "--color-border-tertiary": undefined,
  "--color-border-inverse": undefined,
  "--color-border-ghost": undefined,
  "--color-border-info": undefined,
  "--color-border-danger": undefined,
  "--color-border-success": undefined,
  "--color-border-warning": undefined,
  "--color-border-disabled": undefined,
  "--color-ring-primary": undefined,
  "--color-ring-secondary": undefined,
  "--color-ring-inverse": undefined,
  "--color-ring-info": undefined,
  "--color-ring-danger": undefined,
  "--color-ring-success": undefined,
  "--color-ring-warning": undefined,
  "--font-sans": undefined,
  "--font-mono": undefined,
  "--font-weight-normal": undefined,
  "--font-weight-medium": undefined,
  "--font-weight-semibold": undefined,
  "--font-weight-bold": undefined,
  "--font-text-xs-size": undefined,
  "--font-text-sm-size": undefined,
  "--font-text-md-size": undefined,
  "--font-text-lg-size": undefined,
  "--font-heading-xs-size": undefined,
  "--font-heading-sm-size": undefined,
  "--font-heading-md-size": undefined,
  "--font-heading-lg-size": undefined,
  "--font-heading-xl-size": undefined,
  "--font-heading-2xl-size": undefined,
  "--font-heading-3xl-size": undefined,
  "--font-text-xs-line-height": undefined,
  "--font-text-sm-line-height": undefined,
  "--font-text-md-line-height": undefined,
  "--font-text-lg-line-height": undefined,
  "--font-heading-xs-line-height": undefined,
  "--font-heading-sm-line-height": undefined,
  "--font-heading-md-line-height": undefined,
  "--font-heading-lg-line-height": undefined,
  "--font-heading-xl-line-height": undefined,
  "--font-heading-2xl-line-height": undefined,
  "--font-heading-3xl-line-height": undefined,
  "--border-radius-xs": undefined,
  "--border-radius-sm": undefined,
  "--border-radius-md": undefined,
  "--border-radius-lg": undefined,
  "--border-radius-xl": undefined,
  "--border-radius-full": undefined,
  "--border-width-regular": undefined,
  "--shadow-hairline": undefined,
  "--shadow-sm": undefined,
  "--shadow-md": undefined,
  "--shadow-lg": undefined,
};

/** The spec-typed record for a partial palette: the announced slots set, every other slot `undefined`. */
export function hostStyleVariablesRecord(partial: Readonly<Partial<McpUiStyles>>): McpUiStyles {
  return { ...EMPTY_HOST_STYLE_VARIABLES, ...partial };
}

/** The slots a record actually announces (the wire's view of it). */
export function announcedHostStyleVariables(record: Readonly<McpUiStyles>): Partial<Record<McpUiStyleVariableKey, string>> {
  const out: Partial<Record<McpUiStyleVariableKey, string>> = {};
  for (const [key, value] of Object.entries(record) as Array<[McpUiStyleVariableKey, string | undefined]>) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
