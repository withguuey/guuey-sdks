/**
 * guuey domains -- Manage custom domains for deployed agents
 * (`/v1/apps/:appId/domains*`, guuey#132 slice 1).
 *
 * Usage:
 *   guuey domains add chat.example.com      # Register + start DNS verification
 *   guuey domains list                      # Default domain + per-domain status
 *   guuey domains verify chat.example.com   # Run the DNS check now (exits 1 until verified)
 *   guuey domains remove chat.example.com   # Remove custom domain
 *
 * A verified domain serves the agent with automatic TLS (slice 2): `list`
 * renders the wire's `servingStatus` (provisioning/active/failed) next to
 * the verification status once the edge has state for the row.
 *
 * Two row shapes (`verificationMethod`, guuey#139):
 *   - `cname` — a subdomain: the customer CNAMEs their hostname at the
 *     `cnameTarget` returned by add/list (the app's own always-on
 *     `{appId}.{agentsDomain}` name). That same record doubles as the
 *     ownership challenge: verification passes when the domain's CNAME
 *     chain resolves there (1-min poll cron, or on demand via `verify`).
 *   - `txt` — a root/apex domain (`example.com`, auto-detected server-side
 *     by its SOA record, or forced with `--txt`): a CNAME is impossible at
 *     a zone apex, so ownership is the `txtChallenge` TXT and serving is the
 *     customer's own ALIAS/ANAME at the edge endpoint plus a `_cf-challenge`
 *     TXT (`apex` on the wire — THREE records instead of one). Only
 *     ALIAS/ANAME/flattening-capable DNS providers can do it; the recommended
 *     alternative is `www` + a registrar forward of the root.
 * Records can be created before or after `add`.
 *
 * NOT the same thing as `guuey apps update --domains`, which sets the
 * CORS/frame-ancestors origin allowlist.
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';

/**
 * Wire mirrors of `backend/libs/cli-wire/domains.ts`. The CLI is a published
 * npm package and cannot depend on the private source package, so it keeps
 * hand-written copies pinned field-for-field by the sync guard in
 * `domains.test.ts` (widget-keys precedent — see `../wire-mirror-parse.ts`).
 */
export type DomainVerificationStatus = 'pending' | 'verified' | 'failed';

/** `cname` = subdomain (the CNAME is the challenge); `txt` = zone apex. */
export type DomainVerificationMethod = 'cname' | 'txt';

/** One TXT record the customer creates: `name` → `"value"`. */
export interface DomainTxtChallenge {
  name: string;
  value: string;
}

/** Apex serving instructions — present iff the row is a `txt` row. */
export interface ApexServingWire {
  /** ALIAS/ANAME/flattened-CNAME target at the zone root: the edge endpoint. */
  aliasTarget: string;
  /** `_cf-challenge.<domain>` TXT = the edge endpoint (CloudFront ownership + DCV). */
  edgeChallenge: DomainTxtChallenge;
  /** Verify responses only: whether the edge TXT was observed on that check. */
  readonly edgeChallengeObserved?: boolean;
}

/** One custom-domain registration — the `CustomDomain` row's wire projection. */
export interface DomainWire {
  domain: string;
  appId: string;
  /** Convenience mirror of `verificationStatus === 'verified'`. */
  verified: boolean;
  verificationStatus: DomainVerificationStatus;
  /** The app's always-on name: the CNAME target for `cname` rows; for `txt`
   * rows the name the TXT value embeds (not a record to create). */
  cnameTarget: string;
  verificationMethod: DomainVerificationMethod;
  /** The ownership TXT — `txt` rows only. */
  txtChallenge?: DomainTxtChallenge;
  /** Apex serving instructions — `txt` rows only. */
  apex?: ApexServingWire;
  addedAt: string;
  verifiedAt?: string;
  /** Set when the 7-day verification window elapsed. */
  failedAt?: string;
  /** TLS/serving state on the edge (slice 2) — derived server-side; absent
   * until edge state exists for the row. */
  readonly servingStatus?: 'provisioning' | 'active' | 'failed';
}

/** `GET /v1/apps/:appId/domains` — 200. */
export interface DomainsListResponse {
  domains: DomainWire[];
  /** The always-on hostname every app serves at: `${appId}.${agentsDomain}`. */
  defaultDomain: string;
  /** guuey#137: the app's slug host, when it has claimed one. */
  slugDomain?: string;
}

/** `DELETE /v1/apps/:appId/domains` — 200. */
export interface DomainRemoveResponse {
  removed: string;
}

async function apiRequest(
  pat: string,
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pat}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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

/** List glyphs keyed on the wire's `verificationStatus` — NOT inferred from
 * the `verified` boolean, which cannot distinguish pending from failed. */
const STATUS_LABEL: Record<DomainVerificationStatus, string> = {
  pending: '⏳ pending',
  verified: '✓ verified',
  failed: '✗ failed',
};

/** Serving/TLS glyphs for the slice-2 `servingStatus` axis. Rendered only
 * when the wire carries the field — absent means the edge has no state for
 * the row yet, and printing a guess would be a lie. */
const SERVING_LABEL: Record<NonNullable<DomainWire['servingStatus']>, string> = {
  provisioning: '⏳ TLS provisioning',
  active: '🔒 serving',
  failed: '✗ TLS failed',
};

/**
 * Print the record(s) the customer must create for this row — ONE line for a
 * cname row, the three-record apex block for a txt row (guuey#139). Shared
 * by add and verify so the two can never disagree about what to create.
 */
function printRecords(data: DomainWire): void {
  if (data.verificationMethod === 'txt' && data.txtChallenge && data.apex) {
    console.log('  This is a root (apex) domain — create these THREE records at your DNS provider:');
    console.log('');
    console.log('    1. Ownership (TXT):');
    console.log(`       ${data.txtChallenge.name}  →  TXT  →  ${data.txtChallenge.value}`);
    console.log('    2. Serving (ALIAS / ANAME / flattened CNAME at the root):');
    console.log(`       ${data.domain}  →  ALIAS  →  ${data.apex.aliasTarget}`);
    console.log('    3. Edge certificate (TXT):');
    console.log(`       ${data.apex.edgeChallenge.name}  →  TXT  →  ${data.apex.edgeChallenge.value}`);
    console.log('');
    console.log('  Your DNS provider must support ALIAS/ANAME/CNAME-flattening at the root (Route 53,');
    console.log('  Cloudflare, DNSimple, and others do; many do not). If yours does not, serve at');
    console.log(`  www.${data.domain} with one CNAME and forward the root at your registrar — the`);
    console.log('  recommended setup either way. If we ever move our edge, records 2 and 3 must be');
    console.log('  updated by you; subdomain records never change.');
    return;
  }
  console.log('  Create a CNAME record:');
  console.log(`    ${data.domain}  →  ${data.cnameTarget}`);
}

export async function domainsAdd(
  domain: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (!domain) {
    out.error('Usage: guuey domains add <domain> [--txt]');
    process.exit(1);
  }

  // Client-side shape check only — ownership/anti-squat is the server's call.
  const DOMAIN_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  if (!DOMAIN_REGEX.test(domain)) {
    out.error(`Invalid domain: "${domain}". Example: chat.example.com`);
    process.exit(1);
  }

  const { pat, baseUrl, appId } = requestContext(flags);

  console.log('');
  console.log(`  Adding domain: ${domain}`);

  // `--txt` forces apex (TXT) verification — for a zone the server's SOA
  // probe cannot see yet. Absent ⇒ the server decides.
  const body: { domain: string; verificationMethod?: DomainVerificationMethod } =
    flags?.['txt'] === true ? { domain, verificationMethod: 'txt' } : { domain };
  const res = await apiRequest(pat, baseUrl, 'POST', `/apps/${appId}/domains`, body);

  if (!res.ok) await handleApiError(res);

  const data = (await res.json()) as DomainWire;

  console.log('');
  if (data.verificationStatus === 'verified') {
    out.success(`Domain ${domain} added and verified.`);
  } else if (data.verificationStatus === 'failed') {
    // Idempotent re-add of a row whose 7-day verification window elapsed —
    // `verified` is false here just like pending, which is why this branches
    // on `verificationStatus` (same doctrine as STATUS_LABEL above).
    console.log(
      `  ✗ ${domain} failed verification — the 7-day window expired before its ` +
        `${data.verificationMethod === 'txt' ? 'ownership TXT' : 'CNAME'} resolved.`,
    );
    console.log('');
    console.log('  Fix the record(s):');
    printRecords(data);
    console.log('');
    console.log(`  Then run "guuey domains verify ${domain}" to restart verification.`);
  } else {
    out.success(`Domain ${domain} added (DNS verification pending).`);
    console.log('');
    printRecords(data);
    console.log('');
    console.log('  DNS propagation may take a few minutes; run "guuey domains verify" to check now.');
  }
  console.log('');
}

export async function domainsList(
  flags?: Record<string, string | true>,
): Promise<void> {
  const { pat, baseUrl, appId } = requestContext(flags);

  const res = await apiRequest(pat, baseUrl, 'GET', `/apps/${appId}/domains`);

  if (!res.ok) await handleApiError(res);

  const data = (await res.json()) as DomainsListResponse;

  console.log('');
  console.log(`  Default: ${data.defaultDomain}`);
  // The slug host is not a `domains` row — it is guuey-owned and managed by
  // `guuey slug`, so it prints beside the default rather than in the list.
  if (data.slugDomain) console.log(`  Slug:    ${data.slugDomain}`);

  if (data.domains.length === 0) {
    console.log('  No custom domains configured.');
  } else {
    console.log('');
    for (const d of data.domains) {
      const serving =
        d.servingStatus !== undefined ? `  ${SERVING_LABEL[d.servingStatus]}` : '';
      // An apex row has no CNAME target to point at — its serving record is
      // the ALIAS at the edge endpoint (guuey#139).
      const target =
        d.verificationMethod === 'txt' && d.apex
          ? `ALIAS ${d.apex.aliasTarget}`
          : d.cnameTarget;
      console.log(
        `  ${d.domain}  ${STATUS_LABEL[d.verificationStatus]}${serving}  →  ${target}`,
      );
    }
  }
  console.log('');
}

export async function domainsVerify(
  domain: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (!domain) {
    out.error('Usage: guuey domains verify <domain>');
    process.exit(1);
  }

  const { pat, baseUrl, appId } = requestContext(flags);

  console.log('');
  console.log(`  Verifying DNS for ${domain}...`);

  const res = await apiRequest(pat, baseUrl, 'POST', `/apps/${appId}/domains/verify`, { domain });

  if (!res.ok) await handleApiError(res);

  const data = (await res.json()) as DomainWire;

  console.log('');
  if (data.verificationStatus === 'verified') {
    if (data.verificationMethod === 'txt' && data.apex && data.servingStatus !== 'active') {
      // An apex row: ownership is settled, but serving needs the customer's
      // _cf-challenge TXT too — the server just re-checked it (guuey#139).
      if (data.apex.edgeChallengeObserved === true) {
        out.success(
          `Domain ${domain} verified — edge record ${data.apex.edgeChallenge.name} found; ` +
            'serving is converging and TLS provisions in the background.',
        );
      } else {
        out.success(`Domain ${domain} verified (ownership).`);
        console.log('');
        console.log('  Serving is waiting on the edge certificate record — create (or wait for):');
        console.log(
          `    ${data.apex.edgeChallenge.name}  →  TXT  →  ${data.apex.edgeChallenge.value}`,
        );
        console.log(`  and the root ALIAS: ${data.domain}  →  ALIAS  →  ${data.apex.aliasTarget}`);
        console.log(`  Then run "guuey domains verify ${domain}" again to pick it up immediately.`);
      }
      console.log('');
      return;
    }
    out.success(
      `Domain ${domain} verified — TLS is provisioning, usually live in minutes.`,
    );
    console.log('');
    return;
  }

  // Not verified → exit 1 like every other failure path in this file, so
  // scripts can branch on the result instead of scraping output.
  const record = data.verificationMethod === 'txt' ? 'ownership TXT record' : 'CNAME record';
  if (data.verificationStatus === 'failed') {
    // The server re-arms the verification window on every verify call, so
    // "fix the record and run verify" is truthful remediation.
    out.error(`Verification failed — the 7-day verification window expired. Fix the ${record}:`);
    printRecords(data);
    console.log('');
    console.log(`  Then run "guuey domains verify ${domain}" to restart verification.`);
  } else {
    out.error(
      `${data.verificationMethod === 'txt' ? 'Ownership TXT' : 'CNAME'} not found yet. ` +
        'Create (or wait for) the record(s):',
    );
    printRecords(data);
  }
  console.log('');
  process.exit(1);
}

export async function domainsRemove(
  domain: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (!domain) {
    out.error('Usage: guuey domains remove <domain>');
    process.exit(1);
  }

  const { pat, baseUrl, appId } = requestContext(flags);

  const res = await apiRequest(pat, baseUrl, 'DELETE', `/apps/${appId}/domains`, { domain });

  if (!res.ok) await handleApiError(res);

  const data = (await res.json()) as DomainRemoveResponse;

  console.log('');
  out.success(`Domain ${data.removed} removed.`);
  console.log('');
}
