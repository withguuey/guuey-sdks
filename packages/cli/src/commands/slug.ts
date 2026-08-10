/**
 * guuey slug -- Claim, change or release your agent's public slug
 * (`/v1/apps/:appId/slug`, guuey#137 slice 3).
 *
 * Usage:
 *   guuey slug claim weather-bot        # Claim (or change to) weather-bot
 *   guuey slug claim weather-bot --app-id <id>
 *   guuey slug release                  # Give the slug back
 *
 * A slug buys BOTH standalone surfaces at once: the portal path
 * (`/agent/<slug>`) and the `<slug>.agents…` subdomain. The app's uuid
 * address keeps working — a slug is an alias, never a replacement. Slugs
 * are free on every plan.
 *
 * **The host comes from the server, verbatim.** This command does NOT
 * derive `<slug>.<agentsDomain>` locally: only the server knows the env's
 * slug-agents family, and the previous local derivation printed nothing at
 * all for users of the published CLI (there is no `agentsDomain` in
 * `amplify_outputs.json`) and the WRONG family in production — a bug
 * non-prod coincidence hid, since the two families coincide there.
 *
 * The shape rules below MIRROR `backend/libs/cli-wire/slug.ts`. The CLI is
 * a published npm package and cannot depend on the private source package,
 * so `slug.test.ts` pins both the regex's source text and the reserved
 * list against it (the `domains.test.ts` precedent).
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';

/** Shortest claimable slug. */
export const SLUG_MIN_LENGTH = 3;
/** Longest claimable slug. */
export const SLUG_MAX_LENGTH = 50;

/** Mirror of the wire's slug shape — kept on ONE line for the sync guard. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

/** Mirror of the wire's reserved-name denylist. */
export const RESERVED_SLUGS = [
  'about',
  'account',
  'accounts',
  'admin',
  'administrator',
  'agent',
  'agents',
  'api',
  'app',
  'apps',
  'assets',
  'auth',
  'billing',
  'blog',
  'cdn',
  'chat',
  'console',
  'contact',
  'credentials',
  'dashboard',
  'demo',
  'dev',
  'docs',
  'download',
  'downloads',
  'email',
  'embed',
  'ggui',
  'graphql',
  'guuey',
  'help',
  'identity',
  'internal',
  'legal',
  'login',
  'logout',
  'mail',
  'mcp',
  'media',
  'oauth',
  'origin',
  'portal',
  'pricing',
  'privacy',
  'prod',
  'production',
  'register',
  'render',
  'root',
  'sandbox',
  'security',
  'settings',
  'signin',
  'signup',
  'sso',
  'staging',
  'static',
  'status',
  'store',
  'studio',
  'support',
  'system',
  'terms',
  'test',
  'user',
  'users',
  'webhook',
  'webhooks',
  'widget',
  'widgets',
  'www',
] as const;

/**
 * Wire mirrors of `backend/libs/cli-wire/slug.ts`, pinned field-for-field
 * by the sync guard in `slug.test.ts`.
 */
export interface SlugClaimResponse {
  appId: string;
  slug: string;
  /** `<slug>.<slugAgentsDomain>` — server-computed; printed verbatim. */
  host: string;
  /** The slug this claim replaced. Absent on a first claim. */
  previousSlug?: string;
}

/** `DELETE /v1/apps/:appId/slug` — 200. */
export interface SlugReleaseResponse {
  released: string;
}

interface RequestContext {
  pat: string;
  baseUrl: string;
  appId: string;
}

/** Shared prologue: auth + REST base URL + target appId (flag over config). */
function requestContext(flags?: Record<string, string | true>): RequestContext {
  const auth = requireAuth();
  const config = resolveConfig();
  const flagValue = flags?.['app-id'];
  const appId = typeof flagValue === 'string' ? flagValue : config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey pull --app-id <id>" to bind an existing app, or "guuey create" to scaffold a new project first.');
    process.exit(1);
  }

  if (!config.apiUrl) {
    out.error('REST API URL not configured.');
    process.exit(1);
  }

  return { pat: auth.pat, baseUrl: config.apiUrl.replace(/\/$/, ''), appId };
}

/** Render the cliApi error envelope (`{ error: { code, message } }`) and exit 1. */
async function handleApiError(res: Response): Promise<never> {
  let message: string;
  try {
    const body: unknown = await res.json();
    message = out.apiErrorMessage(body, `HTTP ${res.status}`);
  } catch {
    message = `HTTP ${res.status} ${res.statusText}`;
  }
  out.error(message);
  process.exit(1);
}

export async function slugClaim(
  slug: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (!slug) {
    out.error('Usage: guuey slug claim <slug>');
    process.exit(1);
  }

  // Client-side shape check only — uniqueness is the server's call, and it
  // is the only thing that can decide it (one conditional transaction).
  const normalised = slug.trim().toLowerCase();
  if (!SLUG_RE.test(normalised)) {
    out.error(
      `Invalid slug: "${slug}". Use ${SLUG_MIN_LENGTH}–${SLUG_MAX_LENGTH} characters: ` +
        'lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
    );
    process.exit(1);
  }
  if (RESERVED_SLUGS.some((reserved) => reserved === normalised)) {
    out.error(`Slug "${normalised}" is reserved. Pick another one.`);
    process.exit(1);
  }

  const { pat, baseUrl, appId } = requestContext(flags);

  const res = await fetch(`${baseUrl}/apps/${appId}/slug`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify({ slug: normalised }),
  });

  if (!res.ok) await handleApiError(res);

  const data = (await res.json()) as SlugClaimResponse;

  console.log('');
  out.success(`Slug claimed: ${data.slug}`);
  console.log(`  URL:  https://${data.host}`);
  console.log(`  Also: /agent/${data.slug} on the portal`);
  if (data.previousSlug && data.previousSlug !== data.slug) {
    console.log(`  Previous slug: ${data.previousSlug} (its address stops resolving)`);
  }
  console.log('');
}

export async function slugRelease(
  flags?: Record<string, string | true>,
): Promise<void> {
  const { pat, baseUrl, appId } = requestContext(flags);

  const res = await fetch(`${baseUrl}/apps/${appId}/slug`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${pat}` },
  });

  if (!res.ok) await handleApiError(res);

  const data = (await res.json()) as SlugReleaseResponse;

  console.log('');
  out.success(`Slug ${data.released} released — its address stops resolving.`);
  console.log('');
}
