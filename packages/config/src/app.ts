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
});

/** Static TypeScript type for the app section. */
export type GuueyApp = z.infer<typeof AppSectionV1>;
