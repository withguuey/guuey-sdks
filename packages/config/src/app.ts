/**
 * `guuey.json#app` — the App Store / Portal listing section.
 *
 * Describes how the deployable surfaces to end-users in Portal Discover
 * and (optionally) at a custom domain. Read by the platform on first
 * deploy to upsert an `AgentListing` row.
 *
 * Lives at the same level as `agent` and `ggui` sections — the artifact
 * (agent or mcp-server) is what's deployable; this section is presentation.
 */
import { z } from 'zod';
import { AppThemeV1, type GuueyAppTheme } from './theme.js';

/**
 * Slug used for the public URL and App Store listing. Forms part of the
 * agent's reachable hostname: `<slug>.agents.<env>.guuey.com`.
 *
 * Slug uniqueness is enforced platform-side via the `SlugClaim` model.
 * Matches `[a-z0-9][a-z0-9-]{1,62}` — lowercase, hyphens, no leading dash.
 */
const SlugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
    'must be lowercase alphanumeric with optional internal hyphens',
  );

/**
 * Tag for App Store discovery. Free-form short strings; no curated taxonomy
 * in α — Portal renders them as plain text chips for now.
 */
const TagSchema = z.string().min(1).max(32);

/**
 * Custom domain for the agent (e.g. `chef.example.com`). Optional.
 *
 * α requires explicit lifecycle: `guuey domain add <fqdn>` → user configures
 * CNAME at registrar → `guuey domain verify <fqdn>` → platform requests
 * per-domain ACM cert + attaches Ingress rule. Just setting this field does
 * NOT auto-provision — the CLI warns when set without an attached domain
 * record (see design doc §10.3).
 */
const CustomDomainSchema = z
  .string()
  .min(4)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    'must be a valid fully-qualified domain name',
  );

/**
 * End-user auth modes an app record accepts — mirrors the platform's
 * `USER_AUTH_MODES` (`@guuey-private/types` `security/user-auth-mode.ts`),
 * which this published package cannot import; the backend pins the two
 * lists equal (`handlers/reconcile.test.ts`).
 */
export const APP_USER_AUTH_MODES = ['anonymous', 'native_pool', 'byo'] as const;
export type AppUserAuthMode = (typeof APP_USER_AUTH_MODES)[number];

/**
 * `guuey.json#app.access` — the app record's ACCESS POLICY, declared in the
 * manifest so `guuey agent apply` (agents-as-code, guuey#190) converges it
 * alongside the agent definition. Field names ARE the platform API's
 * (`PUT /v1/apps/:id` / the reconcile `config` block): no translation.
 *
 * PUT-per-field semantics: a field that is absent is left untouched by a
 * reconcile (never reset). `userAuthConfig: null` is the explicit "clear the
 * issuer binding". The hosted `GuueyApp` row remains the only enforcement
 * source — this block is the DECLARATION reconcile makes it agree with;
 * the pod ignores it.
 *
 * Tier is deliberately absent (admin plane, never CI); slug/customDomain/
 * listing stay declared-not-converged (they have their own ceremonies).
 */
export const AppAccessV1 = z.strictObject({
  userAuthMode: z.enum(APP_USER_AUTH_MODES).optional(),
  userAuthConfig: z
    .strictObject({
      issuerUrl: z.string().min(1),
      audience: z.string().min(1),
    })
    .nullable()
    .optional(),
  allowedDomains: z.array(z.string().min(1)).optional(),
  guestAccess: z.boolean().nullable().optional(),
});

/** Static TypeScript type for `app.access`. */
export type GuueyAppAccess = z.infer<typeof AppAccessV1>;

/**
 * `guuey.json#app.page` — the STANDALONE PAGE's posture, declared in the
 * manifest so `guuey agent apply` converges it (posture-as-code, guuey#286;
 * requested by the first agents-as-code consumer, ggui#558). Field names ARE
 * the platform's `standalonePage` patch vocabulary (`PUT /v1/apps/:id` /
 * the reconcile `config` block, cli-wire `STANDALONE_PAGE_FIELDS`) — no
 * translation; the backend pins the two lists equal
 * (`handlers/reconcile.test.ts`, the APP_USER_AUTH_MODES pattern).
 *
 * Patch semantics, same as the PUT: an absent member is left untouched by a
 * reconcile, `null` clears the member to its default (page on, indexable, no
 * copy/CTA/endpoint). Values are shape-checked only — caps, the https rule
 * and the CTA both-or-neither pairing are the platform validator's
 * (`validateStandalonePagePatch`), so the CLI surfaces its exact message
 * (the same split as `app.theme`'s colour grammar).
 *
 * `slug` stays OUT: claiming has uniqueness/release semantics (a ceremony,
 * not a converged field). But the posture here REACHES the slug ceremony's
 * automatic arm: the first-Live default-slug claim (guuey#249) consults it
 * and skips when `enabled: false` — `--page off` in git means no auto-named
 * public host, ever.
 */
export const AppPageV1 = z.strictObject({
  enabled: z.boolean().nullable().optional(),
  welcomeCopy: z.string().nullable().optional(),
  ctaLabel: z.string().nullable().optional(),
  ctaUrl: z.string().nullable().optional(),
  identityEndpointUrl: z.string().nullable().optional(),
  noindex: z.boolean().nullable().optional(),
});

/** Static TypeScript type for `app.page`. */
export type GuueyAppPage = z.infer<typeof AppPageV1>;

/**
 * `app.theme` as a file reference — `{ "file": "theme.json" }`, the same
 * convention as `agent.systemPrompt` (guuey#400). The file's CONTENT is the
 * same {@link AppThemeV1} vocabulary — no new grammar. Resolution is
 * CLI-side (the loader reads the file relative to `guuey.json`); the server
 * only ever sees the inline document and 400s an unresolved reference.
 *
 * Discrimination against the inline form is unambiguous: a `{file}`-only
 * strict object can never collide with the theme vocabulary (which
 * requires `mode`/`colors`).
 */
export const ThemeFileRefV1 = z.strictObject({ file: z.string().min(1) });
export type ThemeFileRef = z.infer<typeof ThemeFileRefV1>;

/** Narrow an `app.theme` value to the `{ file }` reference form. */
export function isThemeFileRef(
  theme: ThemeFileRef | GuueyAppTheme,
): theme is ThemeFileRef {
  return 'file' in theme;
}

/**
 * The app section schema. All fields optional in v1 — a project may carry
 * the bare minimum at first and grow the listing as it publishes.
 */
export const AppSectionV1 = z.strictObject({
  slug: SlugSchema.optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(500).optional(),
  iconUrl: z.url().optional(),
  tags: z.array(TagSchema).max(10).optional(),
  customDomain: CustomDomainSchema.optional(),
  /** Access policy converged by `guuey agent apply` — see {@link AppAccessV1}. */
  access: AppAccessV1.optional(),
  /**
   * Chat theme AS CODE, converged by `guuey agent apply` — the inline
   * document ({@link AppThemeV1}) or a `{ file }` reference the CLI
   * resolves ({@link ThemeFileRefV1}).
   */
  theme: z.union([ThemeFileRefV1, AppThemeV1]).optional(),
  /** Standalone-page posture converged by `guuey agent apply` — see {@link AppPageV1}. */
  page: AppPageV1.optional(),
});

/** Static TypeScript type for the app section. */
export type GuueyApp = z.infer<typeof AppSectionV1>;
