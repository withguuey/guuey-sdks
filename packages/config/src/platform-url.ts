/**
 * Platform host placeholders in an external MCP `url` (guuey#1272).
 *
 * A guuey-hosted official MCP is served at a different host per environment
 * (`admin-mcp.dev.sandbox.guuey.com` · `admin-mcp.staging.sandbox.guuey.com`
 * · `admin-mcp.us-east-1.guuey.com`), so a single committed manifest could
 * not point every environment's pod at the right one — the admin agent's
 * README carried a `sed` swap for dev/staging rehearsals, one forgotten swap
 * away from a dev pod on the PRODUCTION MCP. This module is the grammar of
 * the fix: the manifest names the fact, the door names the host.
 *
 *   "url": "https://${platform.adminMcpDomain}/mcp"
 *
 * Rules (settled with oss + infra on guuey#1272):
 * - the placeholder may be the ENTIRE host component and nothing else — no
 *   port, no label around it, never in a path or a query — so the door's
 *   substitution is one host swap, not a string template a reviewer has to
 *   reason about;
 * - the facts are a CLOSED set, {@link PLATFORM_URL_FACTS}: field names of
 *   the platform's own env-domains record (`backend/amplify/cdk/env-domains.ts`
 *   in the guuey repo; `functions/shared/platform-domains.ts` is what the door
 *   reads). This list is a hand-copy — `platform-url.test.ts` reads both
 *   sides off disk when they are present and fails when they drift;
 * - `${env.NAME}` is a DIFFERENT namespace (the app's declared secrets, see
 *   `headers`); platform facts are never available there, by design.
 *
 * Sequencing, stated here because it is a deliberate trade: this schema
 * accepts a templated url BEFORE every door resolves it. An older door
 * refuses the template with its existing 400 ("url must be a URL"), which the
 * CLI prints verbatim — loud, immediate and attributable, unlike a value that
 * silently arrives as `undefined` at runtime. A templated url therefore needs
 * a door new enough to resolve it; the deployment snapshot the door stores
 * carries the RESOLVED url (every pod reads a plain URL, as before) and the
 * authored template travels beside it so `guuey pull` can write the template
 * back — the local manifest stays environment-agnostic across the round trip.
 */
import { z } from 'zod';

/** The facts a manifest may name — field names of the platform's env-domains record. */
export const PLATFORM_URL_FACTS = ['adminMcpDomain', 'platformMcpDomain', 'mcpDomain', 'apiDomain'] as const;
export type PlatformUrlFact = (typeof PLATFORM_URL_FACTS)[number];
/** The four hosts for one environment, keyed by fact — what the door resolves against. */
export type PlatformUrlFacts = Readonly<Record<PlatformUrlFact, string>>;

const PLACEHOLDER_RE = /^\$\{platform\.([A-Za-z]+)\}$/;
/** A host that parses as a URL authority and can never be a real placeholder value. */
const STAND_IN_HOST = 'platform-placeholder.invalid';

function isPlatformUrlFact(name: string): name is PlatformUrlFact {
  return (PLATFORM_URL_FACTS as readonly string[]).includes(name);
}

/**
 * The authority (host[:port]) of an `https?://` string, or `null` when the
 * string has no scheme + authority shape at all.
 */
function authorityOf(value: string): { scheme: string; authority: string; rest: string } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/i.exec(value);
  if (m === null) return null;
  return { scheme: m[1]!, authority: m[2]!, rest: m[3]! };
}

export type PlatformUrlShape =
  | { readonly kind: 'url' }
  | { readonly kind: 'template'; readonly fact: PlatformUrlFact }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Classify a manifest url: a plain URL, a valid platform template (the whole
 * host is one known placeholder and the rest parses as a URL), or invalid
 * with the reason a builder can act on.
 */
export function classifyPlatformUrl(value: string): PlatformUrlShape {
  if (!value.includes('${platform.')) {
    return z.url().safeParse(value).success ? { kind: 'url' } : { kind: 'invalid', reason: 'not a valid URL' };
  }
  const parts = authorityOf(value);
  if (parts === null) return { kind: 'invalid', reason: 'a platform placeholder needs a scheme://host URL shape' };
  const m = PLACEHOLDER_RE.exec(parts.authority);
  if (m === null) {
    return {
      kind: 'invalid',
      reason:
        'a platform placeholder may be the entire host and nothing else — `https://${platform.<fact>}/path`, no port, no label around it, never in a path or a query',
    };
  }
  const fact = m[1]!;
  if (!isPlatformUrlFact(fact)) {
    return { kind: 'invalid', reason: `unknown platform fact "${fact}" — one of ${PLATFORM_URL_FACTS.join(', ')}` };
  }
  if (parts.rest.includes('${')) {
    return { kind: 'invalid', reason: 'a platform placeholder may appear only as the host — never in a path or a query' };
  }
  const standIn = `${parts.scheme}://${STAND_IN_HOST}${parts.rest}`;
  if (!z.url().safeParse(standIn).success) return { kind: 'invalid', reason: 'not a valid URL around the placeholder' };
  return { kind: 'template', fact };
}

/** The fact a templated url names, or `null` for a plain URL. */
export function platformUrlFact(value: string): PlatformUrlFact | null {
  const shape = classifyPlatformUrl(value);
  return shape.kind === 'template' ? shape.fact : null;
}

/**
 * Resolve a templated url against one environment's facts; a plain URL is
 * returned unchanged. The door calls this when it writes a snapshot; a pod
 * never sees a template.
 */
export function resolvePlatformUrl(value: string, facts: PlatformUrlFacts): string {
  const shape = classifyPlatformUrl(value);
  if (shape.kind !== 'template') return value;
  const parts = authorityOf(value)!;
  return `${parts.scheme}://${facts[shape.fact]}${parts.rest}`;
}

/**
 * A manifest url field: a URL, or a platform-templated URL under the rules
 * above. Used for `agent.mcpServers.<name>.url` and `mcpResourceUrl`.
 */
export const PlatformUrl = z.string().superRefine((value, ctx) => {
  const shape = classifyPlatformUrl(value);
  if (shape.kind === 'invalid') ctx.addIssue({ code: 'custom', message: shape.reason });
});
