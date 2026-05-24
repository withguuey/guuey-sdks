/**
 * guuey slug -- Claim a public slug for your deployed agent.
 *
 * A slug shortens the agent subdomain from
 *   `{uuid}.agents.{envDomain}` → `{slug}.agents.{envDomain}`.
 * The UUID subdomain stays live — slugs are purely an ergonomic alias.
 *
 * Usage:
 *   guuey slug claim weather-bot        # Claim weather-bot for this app
 *   guuey slug claim weather-bot --app-id <id>
 */

import { requireAuth } from '../auth';
import { resolveConfig, loadAmplifyOutputs } from '../config';
import * as out from '../output';

/** Shared with the backend resolver — kept in sync manually. */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,29}[a-z0-9])?$/;

interface ClaimResponse {
  success: boolean;
  slug: string;
  previousSlug?: string | null;
}

export async function slugClaim(
  slug: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (!slug) {
    out.error('Usage: guuey slug claim <slug>');
    process.exit(1);
  }
  const normalised = slug.trim().toLowerCase();
  if (!SLUG_RE.test(normalised) || normalised.length < 3 || normalised.length > 30) {
    out.error(
      'Invalid slug. Must be 3–30 chars, lowercase a-z/0-9, hyphens allowed in the middle only.',
    );
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();
  const appId = (flags?.['app-id'] as string) ?? config.appId;
  if (!appId) {
    out.error('No app ID found. Run "guuey link" or "guuey create" first.');
    process.exit(1);
  }

  if (!config.apiUrl) {
    out.error('REST API URL not configured.');
    process.exit(1);
  }
  const baseUrl = config.apiUrl.replace(/\/$/, '');

  const res = await fetch(`${baseUrl}/apps/${appId}/slug`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.pat}`,
    },
    body: JSON.stringify({ slug: normalised }),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Failed: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as ClaimResponse;

  // Best-effort discovery of the public agents domain so we can print a ready-to-paste URL.
  const amplify = loadAmplifyOutputs() as Record<string, string | undefined>;
  const agentsDomain = amplify.agentsDomain ?? process.env.AGENTS_DOMAIN;

  console.log('');
  out.success(`Slug claimed: ${data.slug}`);
  if (agentsDomain) {
    console.log(`  URL:  https://${data.slug}.${agentsDomain}`);
  }
  if (data.previousSlug && data.previousSlug !== data.slug) {
    console.log(`  Previous slug: ${data.previousSlug} (old DNS will stop resolving)`);
  }
}
