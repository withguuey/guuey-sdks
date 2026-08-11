/**
 * `guuey apps` — App management via the ggui REST API.
 *
 * All operations use PAT auth against the platform REST API.
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { resolveConfig, saveConfig, loadConfig } from '../config';
import { isLoggedIn, requireAuth } from '../auth';
import { login } from './login';
import * as out from '../output';

/**
 * `GET /v1/apps`'s per-app projection — a strict subset of the server's
 * `AppWire` (`backend/libs/cli-wire/apps.ts`), pinned field-for-field by
 * `wire-sync.test.ts`.
 *
 * NOT a member: `hasBYOK`. It was declared and rendered here (a `BYOK`
 * column in `apps list`, a `BYOK:` line in `apps get`) but `toWire` has
 * NEVER sent it — the field lives on the `GuueyApp` model and is reachable
 * over AppSync, not over this REST surface — so both readings were
 * permanently `undefined` and both surfaces permanently printed `no`. The
 * sync guard is what surfaced it (guuey#33); `guuey byok list` is the
 * command that actually knows. Same bug class as the `displayName` note
 * below, found the same way.
 */
interface AppSummary {
  id: string;
  /**
   * The cliApi wire field is `displayName` (see
   * `backend/amplify/functions/cliApi/handlers/apps.ts#AppWire`) — NOT
   * `name`. Reading `.name` here silently rendered an empty column (S5).
   */
  displayName: string;
  createdAt: string;
}

/**
 * `GET /v1/apps/:id`. Only fields the server's `AppWire` actually sends —
 * `stylingPrompt` / `webhookUrl` / `rateLimitPerMinute` used to be
 * declared here and printed below, but `toWire` has never returned them,
 * so those lines were permanently dead. They are Console-managed fields;
 * the CLI does not read or write them.
 */
interface AppDetail extends AppSummary {
  allowedDomains?: string[];
  userAuthMode?: string | null;
  userAuthConfig?: { issuerUrl: string | null; audience: string | null } | null;
  /**
   * Standalone-page branding, echoed as stored (guuey#149) — so
   * `guuey apps get` shows what `guuey apps update --brand-*` wrote.
   */
  brandIconUrl?: string | null;
  brandOgImageUrl?: string | null;
  brandAccent?: string | null;
  welcomeCopy?: string | null;
}

interface AppAccessState {
  guestAccess: boolean | null;
  guestDailyMessageLimit: number | null;
}

interface AppListing {
  name: string;
  status?: string;
  visibility?: string;
}

/**
 * Production portal origin for the printed share link — deliberately a
 * single hardcoded constant, not `resolveConfig().portalUrl`. Sandbox/dev
 * envs serve the same `/agent/<appId>` route at a different origin; the
 * `--help` text calls that out rather than making this command silently
 * env-aware.
 */
const PORTAL_ORIGIN = 'https://app.guuey.com';

function getApiBase(): string {
  const config = resolveConfig();
  const apiUrl = config.apiUrl;
  if (!apiUrl) {
    throw new Error(
      'REST API URL not configured. Ensure amplify_outputs.json is present or set GUUEY_API_URL.',
    );
  }
  return apiUrl.replace(/\/$/, '');
}

async function apiRequest(method: string, path: string, body?: unknown): Promise<Response> {
  const auth = requireAuth();
  return fetch(`${getApiBase()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.pat}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function handleError(res: Response, prefix?: string): Promise<never> {
  let message: string;
  try {
    // cliApi's envelope is `{ error: { code, message } }` (see
    // backend/amplify/functions/shared/response.ts#httpError); older
    // surfaces used `{ error: string }`. `out.apiErrorMessage` renders
    // both and never yields "[object Object]".
    const body: unknown = await res.json();
    message = out.apiErrorMessage(body, `HTTP ${res.status}`);
  } catch {
    message = `HTTP ${res.status} ${res.statusText}`;
  }
  out.error(prefix ? `${prefix}: ${message}` : message);
  process.exit(1);
}

/**
 * Build one `out.table` row for `guuey apps list` (pure — no I/O), so the
 * Name-column-uses-`displayName` fix (S5) is unit-testable without a
 * `fetch` mock.
 */
export function appsListRow(a: AppSummary): Record<string, string> {
  return {
    ID: a.id,
    Name: a.displayName,
    Created: a.createdAt?.slice(0, 10) ?? '-',
  };
}

/**
 * Handle `guuey apps list`.
 */
export async function appsList(opts: { json?: boolean }): Promise<void> {
  const res = await apiRequest('GET', '/apps');
  if (!res.ok) return handleError(res);

  const data = (await res.json()) as { apps: AppSummary[] };

  if (opts.json) {
    out.json(data.apps);
    return;
  }

  out.table(data.apps.map(appsListRow));
}

/**
 * Handle `guuey apps get [appId]`.
 */
export async function appsGet(
  appId: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass --app-id or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  const res = await apiRequest('GET', `/apps/${resolved}`);
  if (!res.ok) return handleError(res);

  const data = (await res.json()) as { app: AppDetail };

  if (opts.json) {
    out.json(data.app);
    return;
  }

  const app = data.app;
  console.log(`App: ${app.displayName} (${app.id})`);
  if (app.userAuthMode) console.log(`  Auth Mode:    ${app.userAuthMode}`);
  if (app.userAuthConfig?.issuerUrl)
    console.log(`  Issuer:       ${app.userAuthConfig.issuerUrl}`);
  if (app.userAuthConfig?.audience)
    console.log(`  Audience:     ${app.userAuthConfig.audience}`);
  if (app.allowedDomains?.length)
    console.log(`  Domains:      ${app.allowedDomains.join(', ')}`);
  if (app.brandIconUrl) console.log(`  Brand Icon:   ${app.brandIconUrl}`);
  if (app.brandOgImageUrl) console.log(`  OG Image:     ${app.brandOgImageUrl}`);
  if (app.brandAccent) console.log(`  Brand Accent: ${app.brandAccent}`);
  if (app.welcomeCopy) console.log(`  Welcome Copy: ${app.welcomeCopy}`);
  console.log(`  Created:      ${app.createdAt}`);
}

/**
 * Handle `guuey apps create`.
 */
export async function appsCreate(opts: {
  name?: string;
  json?: boolean;
}): Promise<void> {
  if (!opts.name) {
    out.error('App name is required. Use: guuey apps create --name "My App"');
    process.exit(1);
  }

  // Auto-login if not authenticated
  if (!isLoggedIn()) {
    console.log('Not logged in — opening browser to authenticate...\n');
    await login();
  }

  // cliApi POST /v1/apps expects `displayName` and returns `{ app: {...} }`
  // (the app's own PAT already authorizes deploys — no separate per-app API
  // key is minted anywhere in the CLI).
  const res = await apiRequest('POST', '/apps', {
    displayName: opts.name,
  });

  if (!res.ok) return handleError(res, 'Failed to create app');

  const data = (await res.json()) as { app: { id: string; displayName: string } };
  const appId = data.app.id;

  // Auto-configure the CLI with the new app id.
  const existing = loadConfig();
  existing.appId = appId;
  saveConfig(existing);

  if (opts.json) {
    out.json({ appId, displayName: data.app.displayName });
    return;
  }

  out.success(`Created app "${opts.name}"`);
  console.log('');
  console.log(`  App ID:   ${appId}`);
  console.log('');
  console.log('  Auto-configured: app-id saved to ~/.guuey/config.json');
}

/**
 * Request body for `PUT /v1/apps/:id`. Mirrors the handler's
 * `UpdateAppBody` (`backend/amplify/functions/cliApi/handlers/apps.ts`) —
 * one contract, both sides.
 *
 * This used to be a `Record<string, unknown>` filled with field names the
 * handler never mapped (`name`, `stylingPrompt`, `webhookUrl`,
 * `rateLimitPerMinute`), so EVERY flag of `guuey apps update` 400'd with
 * "No updatable fields provided". A typed body is what keeps the two
 * sides from drifting apart again silently.
 */
export interface UpdateAppRequest {
  displayName?: string;
  description?: string;
  allowedDomains?: string[];
  userAuthMode?: string;
  userAuthConfig?: { issuerUrl: string; audience: string } | null;
  /** Widget wave-2 embed identity-mode policy (ratification #3). */
  widgetEmbedIdentity?: 'identified' | 'anonymous' | null;
  /**
   * Standalone-page branding (guuey#137 slice 3). `null` clears the stored
   * value. These are the APP's branding, not a store listing's: they show up
   * on the agent's own page whether or not it is listed in Discover, which is
   * why `guuey apps publish --icon-url` is gone and these live here.
   *
   * The server validates shape (https, `#rrggbb`, ≤280 single-line copy) plus
   * a WCAG-AA contrast floor on the accent, and returns a 400 naming the
   * field — this command deliberately does NOT mirror those rules, so there
   * is one place to read them and no chance of the two drifting.
   */
  brandIconUrl?: string | null;
  brandOgImageUrl?: string | null;
  brandAccent?: string | null;
  welcomeCopy?: string | null;
  /**
   * Standalone-page "C" identity-endpoint URL (guuey#137 slice 3): an https URL
   * on the builder's own site the standalone page fetches with credentials to
   * mint an identified token. `null` clears it. Sent verbatim — the server owns
   * the shape rule (https, ≤2048, no control chars) and returns a field-named
   * 400, exactly like the branding fields above; one place to read it, no drift.
   */
  identityEndpointUrl?: string | null;
}

/**
 * `--clear` on any branding flag means "unset it". An empty string means the
 * same thing and is accepted for shell-friendliness (`--brand-accent ""`);
 * anything else goes to the server verbatim, unvalidated — see
 * {@link UpdateAppRequest}'s branding block for why the CLI does not mirror
 * the server's rules.
 */
function brandFlagValue(raw: string): string | null {
  return raw === 'clear' || raw.trim() === '' ? null : raw;
}

// ─── Brand-asset upload wire mirrors (guuey#138) ───────────────────────
//
// Mirrors of `backend/libs/cli-wire/brand-assets.ts`, pinned field-for-field
// (and, for the content-type list, member-for-member in order) by the SYNC
// GUARD block in `apps.test.ts` — the CLI is published npm and cannot import
// the private wire package; see `../wire-mirror-parse.ts`.
//
// `BRAND_ASSET_MAX_BYTES` and `MAX_BRAND_ASSETS_PER_APP` are deliberately
// NOT mirrored: `wire-mirror-parse.ts` has no numeric-constant parser, so a
// mirrored number would be an unguardable second copy. The CLI sends
// `contentLength` verbatim and renders the server's field-named 400.

/** Mirror of the wire's declared-type allowlist. GIF and SVG are refused. */
const BRAND_ASSET_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** The two `GuueyApp` columns an upload may target — nothing else. */
type BrandAssetField = 'brandIconUrl' | 'brandOgImageUrl';

/** `POST /v1/apps/:appId/brand-assets/upload`. */
export interface BrandAssetUploadBody {
  field: BrandAssetField;
  contentType: string;
  contentLength: number;
}

/** The presign. `contentType` is the SIGNED value — the PUT must send it
 * byte-for-byte or S3 403s with an opaque `SignatureDoesNotMatch`. */
export interface BrandAssetUploadResponse {
  uploadUrl: string;
  uploadId: string;
  expiresIn: number;
  contentType: string;
}

/** `POST /v1/apps/:appId/brand-assets/commit` — the `uploadId`, never a key. */
export interface BrandAssetCommitBody {
  field: BrandAssetField;
  uploadId: string;
}

/** The commit receipt: the row is already written; `url` is the CDN URL now
 * stored in `field`'s column. */
export interface BrandAssetCommitResponse {
  url: string;
  field: BrandAssetField;
}

/**
 * Extension → declared content type for the `--brand-*-file` flags. Local
 * pre-flight only — the server sniffs the actual bytes at commit and owns
 * the rule; what this buys is a legible refusal before any network call,
 * plus the declared value the presign body requires. The result is narrowed
 * through the mirrored allowlist, so a mapping entry can never drift
 * outside what the sync guard pins.
 */
function brandAssetContentTypeFor(
  filePath: string,
): (typeof BRAND_ASSET_CONTENT_TYPES)[number] | null {
  const byExtension: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  const declared = byExtension[extname(filePath).toLowerCase()];
  return BRAND_ASSET_CONTENT_TYPES.find((t) => t === declared) ?? null;
}

/**
 * One `--brand-*-file` upload: presign → PUT the bytes → commit (guuey#138).
 * The commit itself writes the app row's `field` column, so there is no
 * follow-up `PUT /apps/:id` for this field — an upload is an immediate
 * single-field save.
 */
async function uploadBrandAssetFile(
  appId: string,
  field: BrandAssetField,
  filePath: string,
): Promise<BrandAssetCommitResponse> {
  const contentType = brandAssetContentTypeFor(filePath);
  if (contentType === null) {
    out.error(
      `Cannot infer an image type from ${filePath} — use a .png, .jpg/.jpeg or .webp ` +
        'file. GIF and SVG are not accepted; export a raster for an SVG logo.',
    );
    process.exit(1);
  }

  // `Buffer<ArrayBuffer>`, not bare `Buffer`: the bare annotation widens to
  // `ArrayBufferLike`, which `fetch`'s `BodyInit` refuses — the parameterized
  // type is what `readFileSync` actually returns (`NonSharedBuffer`).
  let bytes: Buffer<ArrayBuffer>;
  try {
    bytes = readFileSync(filePath);
  } catch {
    out.error(`Cannot read file: ${filePath}`);
    process.exit(1);
  }

  const uploadBody: BrandAssetUploadBody = {
    field,
    contentType,
    contentLength: bytes.length,
  };
  const presignRes = await apiRequest('POST', `/apps/${appId}/brand-assets/upload`, uploadBody);
  if (!presignRes.ok) return handleError(presignRes, `Failed to start ${field} upload`);
  const presign = (await presignRes.json()) as BrandAssetUploadResponse;

  // Content-Type MUST be the presign response's echoed value — it is a
  // signed header, so any variant spelling 403s. Same PUT shape as the
  // deploy tarball upload.
  const putRes = await fetch(presign.uploadUrl, {
    method: 'PUT',
    body: bytes,
    headers: {
      'Content-Type': presign.contentType,
      'Content-Length': String(bytes.length),
    },
  });
  if (!putRes.ok) {
    // A typed message, never the raw S3 XML: a 403 here usually means the
    // presign window elapsed — re-running mints a fresh URL.
    out.error(
      `Upload of ${filePath} was refused by storage (HTTP ${putRes.status}). ` +
        'Re-run the command to mint a fresh upload URL.',
    );
    process.exit(1);
  }

  const commitBody: BrandAssetCommitBody = { field, uploadId: presign.uploadId };
  const commitRes = await apiRequest('POST', `/apps/${appId}/brand-assets/commit`, commitBody);
  if (!commitRes.ok) return handleError(commitRes, `Failed to commit ${field} upload`);
  return (await commitRes.json()) as BrandAssetCommitResponse;
}

/**
 * Build the `apps update` request body from parsed flags (pure — no I/O,
 * so the wire shape is unit-testable without a `fetch` mock).
 *
 * Returns a `string` instead of a body when the flag combination is
 * unusable, so the caller can print it and exit non-zero. Catching
 * these locally beats a server round-trip for something the CLI can see.
 */
export function buildUpdateAppBody(opts: {
  name?: string;
  description?: string;
  domains?: string;
  authMode?: string;
  issuerUrl?: string;
  audience?: string;
  clearAuthConfig?: boolean;
  widgetEmbedIdentity?: string;
  brandIconUrl?: string;
  brandOgImageUrl?: string;
  brandAccent?: string;
  welcomeCopy?: string;
  identityEndpointUrl?: string;
}): UpdateAppRequest | string {
  const body: UpdateAppRequest = {};
  if (opts.name) body.displayName = opts.name;
  if (opts.description) body.description = opts.description;
  if (opts.domains !== undefined) {
    // An explicit empty string clears the allowlist; the server validates
    // and normalizes every entry (`validateAllowedDomains`).
    body.allowedDomains =
      opts.domains.trim() === ''
        ? []
        : opts.domains
            .split(',')
            .map((d) => d.trim())
            .filter((d) => d !== '');
  }
  if (opts.authMode) body.userAuthMode = opts.authMode;

  const hasIssuerPair = Boolean(opts.issuerUrl) || Boolean(opts.audience);
  if (opts.clearAuthConfig && hasIssuerPair) {
    return '--clear-auth-config cannot be combined with --issuer-url / --audience.';
  }
  if (opts.clearAuthConfig) {
    body.userAuthConfig = null;
  } else if (hasIssuerPair) {
    // Both-or-neither: a half-configured issuer binding verifies nothing,
    // so the server rejects it too — this just fails faster.
    if (!opts.issuerUrl || !opts.audience) {
      return '--issuer-url and --audience must be provided together.';
    }
    body.userAuthConfig = { issuerUrl: opts.issuerUrl, audience: opts.audience };
  }

  if (opts.widgetEmbedIdentity !== undefined) {
    if (opts.widgetEmbedIdentity === 'clear') {
      body.widgetEmbedIdentity = null;
    } else if (
      opts.widgetEmbedIdentity === 'identified' ||
      opts.widgetEmbedIdentity === 'anonymous'
    ) {
      body.widgetEmbedIdentity = opts.widgetEmbedIdentity;
    } else {
      return (
        `--widget-embed-identity must be one of: identified, anonymous, clear ` +
        `(got "${opts.widgetEmbedIdentity}").`
      );
    }
  }

  // Standalone-page branding. Sent verbatim (or as an explicit `null` clear);
  // the server owns every rule and returns a field-named 400.
  if (opts.brandIconUrl !== undefined) {
    body.brandIconUrl = brandFlagValue(opts.brandIconUrl);
  }
  if (opts.brandOgImageUrl !== undefined) {
    body.brandOgImageUrl = brandFlagValue(opts.brandOgImageUrl);
  }
  if (opts.brandAccent !== undefined) {
    body.brandAccent = brandFlagValue(opts.brandAccent);
  }
  if (opts.welcomeCopy !== undefined) {
    body.welcomeCopy = brandFlagValue(opts.welcomeCopy);
  }

  // Standalone-page "C" identity endpoint. Same clear convention (empty string
  // or 'clear' unsets); the server owns the https/length/control-char rule.
  if (opts.identityEndpointUrl !== undefined) {
    body.identityEndpointUrl = brandFlagValue(opts.identityEndpointUrl);
  }

  if (Object.keys(body).length === 0) {
    return NO_UPDATE_FIELDS_MESSAGE;
  }
  return body;
}

/**
 * The one `buildUpdateAppBody` refusal `appsUpdate` may tolerate: an empty
 * PUT body is fine when a `--brand-*-file` upload is doing the saving (the
 * commit writes the row itself — no PUT needed). Compared by identity there,
 * so every OTHER refusal (half issuer pair, bad enum value, …) still exits.
 */
const NO_UPDATE_FIELDS_MESSAGE =
  'No fields to update. Use --name, --description, --domains, --auth-mode, ' +
  '--issuer-url + --audience, --clear-auth-config, --widget-embed-identity, ' +
  '--brand-icon-url, --brand-og-image-url, --brand-icon-file, ' +
  '--brand-og-image-file, --brand-accent, --welcome-copy, ' +
  'or --identity-endpoint-url.';

/**
 * Handle `guuey apps update [appId]`.
 *
 * The two `--brand-*-file` flags (guuey#138) run the upload pipeline instead
 * of joining the `PUT /apps/:id` body: each one is an immediate single-field
 * save through `POST …/brand-assets/commit`, which writes the row itself. The
 * remaining flags still travel as one PUT, issued after the uploads so a
 * refused file never leaves a half-applied update behind it.
 */
export async function appsUpdate(
  appId: string | undefined,
  opts: {
    name?: string;
    description?: string;
    domains?: string;
    authMode?: string;
    issuerUrl?: string;
    audience?: string;
    clearAuthConfig?: boolean;
    widgetEmbedIdentity?: string;
    brandIconUrl?: string;
    brandOgImageUrl?: string;
    brandIconFile?: string;
    brandOgImageFile?: string;
    brandAccent?: string;
    welcomeCopy?: string;
    identityEndpointUrl?: string;
    json?: boolean;
  },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided.');
    process.exit(1);
  }

  // A file upload and a URL write name the same column — refuse the
  // ambiguity instead of silently picking a winner.
  if (opts.brandIconFile !== undefined && opts.brandIconUrl !== undefined) {
    out.error('--brand-icon-file cannot be combined with --brand-icon-url.');
    process.exit(1);
  }
  if (opts.brandOgImageFile !== undefined && opts.brandOgImageUrl !== undefined) {
    out.error('--brand-og-image-file cannot be combined with --brand-og-image-url.');
    process.exit(1);
  }
  if (opts.brandIconFile !== undefined && opts.brandIconFile.trim() === '') {
    out.error('--brand-icon-file requires a file path.');
    process.exit(1);
  }
  if (opts.brandOgImageFile !== undefined && opts.brandOgImageFile.trim() === '') {
    out.error('--brand-og-image-file requires a file path.');
    process.exit(1);
  }

  const uploads: Array<{ field: BrandAssetField; filePath: string }> = [];
  if (opts.brandIconFile !== undefined) {
    uploads.push({ field: 'brandIconUrl', filePath: opts.brandIconFile });
  }
  if (opts.brandOgImageFile !== undefined) {
    uploads.push({ field: 'brandOgImageUrl', filePath: opts.brandOgImageFile });
  }

  const body = buildUpdateAppBody(opts);
  if (typeof body === 'string' && (body !== NO_UPDATE_FIELDS_MESSAGE || uploads.length === 0)) {
    out.error(body);
    process.exit(1);
  }

  const uploaded: BrandAssetCommitResponse[] = [];
  for (const upload of uploads) {
    uploaded.push(await uploadBrandAssetFile(resolved, upload.field, upload.filePath));
  }

  if (typeof body !== 'string') {
    const res = await apiRequest('PUT', `/apps/${resolved}`, body);
    if (!res.ok) return handleError(res);
  }

  if (opts.json) {
    out.json({
      success: true,
      ...Object.fromEntries(uploaded.map((commit) => [commit.field, commit.url])),
    });
    return;
  }
  for (const commit of uploaded) {
    out.success(`${commit.field} set to ${commit.url}`);
  }
  if (typeof body !== 'string') {
    out.success(`Updated app ${resolved}`);
  }
}

/**
 * Handle `guuey apps delete [appId]`.
 */
export async function appsDelete(
  appId: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  if (!opts.json) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Delete app ${resolved}? This cannot be undone. (y/N) `, resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  const res = await apiRequest('DELETE', `/apps/${resolved}`);
  if (!res.ok) return handleError(res);

  const data = (await res.json()) as {
    archived: boolean;
    appId: string;
    scheduledDeleteAt: string;
    teardown?: { buildNumber: number; status: string };
  };

  // Clear local config if this was the active app
  const config = loadConfig();
  if (config.appId === resolved) {
    delete config.appId;
    delete config.apiKey;
    saveConfig(config);
  }

  if (opts.json) {
    out.json(data);
  } else {
    out.success(`Archived app ${resolved}`);
    console.log(`  Hard delete scheduled: ${data.scheduledDeleteAt.slice(0, 10)}`);
    if (data.teardown) {
      console.log(
        `  Tearing down live deployment (build #${data.teardown.buildNumber})`,
      );
    }
  }
}

/**
 * Handle `guuey apps recover [appId]` — the undo for `guuey apps archive`.
 *
 * Live since guuey#41. It was a `notYetAvailable` stub before that, because
 * the platform's restore only cancelled the deletion request: the app came
 * back with its widget signing key still revoked, so every embed stayed dark
 * behind a 404 JWKS. Restore now un-revokes that key — the app's original
 * `kid` and app secret, so nothing the customer deployed has to change — which
 * is why `signingKey` is reported below rather than assumed.
 *
 * The one thing recover does NOT bring back is the per-app subscription
 * archive cancelled. Resubscribing means charging, and that is a decision the
 * builder makes at checkout, not a side effect of an undo — so the app returns
 * on free-tier limits until they resubscribe in the console, and this says so
 * out loud rather than letting the next deploy fail with a tier error.
 */
export async function appsRecover(
  appId: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  if (!appId) {
    out.error('App ID is required. Use: guuey apps recover <appId>');
    process.exit(1);
  }

  const res = await apiRequest('POST', `/apps/${appId}/recover`);
  if (!res.ok) return handleError(res);

  const data = (await res.json()) as {
    recovered: boolean;
    appId: string;
    requestedAt: string;
    signingKey:
      | 'restored'
      | 'already-live'
      | 'left-revoked'
      | 'no-enrolment'
      | 'unprovisioned';
  };

  if (opts.json) {
    out.json(data);
    return;
  }

  out.success(`Recovered app ${appId}`);
  if (data.signingKey === 'restored' || data.signingKey === 'already-live') {
    console.log('  Widget signing key is live again — embeds need no changes.');
  } else if (data.signingKey === 'left-revoked') {
    console.log(
      '  Widget signing key stays revoked — you revoked it yourself, so recover',
    );
    console.log(
      '  left it alone. Run `guuey widget keys create` to re-enrol (new app secret).',
    );
  }
  console.log(
    '  Billing was not resumed: the app is on free-tier limits until you',
  );
  console.log('  resubscribe in the console.');
}

/**
 * Handle `guuey apps access [appId]`.
 *
 * Personal-apps-only: `PUT /apps/:id` 404s for workspace-owned apps (see
 * `guuey apps access --help`).
 */
export async function appsAccess(
  appId: string | undefined,
  opts: {
    guests?: string | true;
    guestLimit?: string | true;
    json?: boolean;
  },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  if (opts.guests === undefined && opts.guestLimit === undefined) {
    out.error(
      'No flags provided. Use --guests on|off and/or --guest-limit N|off. See: guuey apps access --help',
    );
    process.exit(1);
  }

  const body: Record<string, unknown> = {};

  if (opts.guests !== undefined) {
    if (opts.guests !== 'on' && opts.guests !== 'off') {
      out.error('Invalid --guests value. Use: on | off');
      process.exit(1);
    }
    body.guestAccess = opts.guests === 'on';
  }

  if (opts.guestLimit !== undefined) {
    if (opts.guestLimit === 'off') {
      body.guestDailyMessageLimit = null;
    } else {
      const raw = typeof opts.guestLimit === 'string' ? opts.guestLimit.trim() : '';
      // Digits-only pre-check: Number() alone would admit '1e2', '0x10', etc.
      const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1) {
        out.error("Invalid --guest-limit value. Use a positive integer, or 'off' to clear.");
        process.exit(1);
      }
      body.guestDailyMessageLimit = n;
    }
  }

  const res = await apiRequest('PUT', `/apps/${resolved}`, body);
  if (!res.ok) return handleError(res);

  const data = (await res.json()) as { app: AppAccessState };

  if (opts.json) {
    out.json(data.app);
    return;
  }

  out.success(`Updated access for app ${resolved}`);
  console.log('');
  console.log(`  Guests:            ${data.app.guestAccess === false ? 'off' : 'on'}`);
  console.log(
    `  Guest daily limit: ${
      data.app.guestDailyMessageLimit == null ? 'unlimited' : data.app.guestDailyMessageLimit
    }`,
  );
}

/**
 * Handle `guuey apps publish [appId]`.
 *
 * Personal-apps-only: `POST /apps/:id/listing` 404s for workspace-owned
 * apps (see `guuey apps publish --help`). Always forces `status:
 * 'published'` and `visibility: 'public'` over whatever metadata flags
 * are passed — those flags only control the listing's display fields.
 *
 * **`--icon-url` is GONE (guuey#137 slice 3.)** The icon is app branding, not
 * listing metadata — an unlisted, share-linked agent is the flagship surface
 * and it has no listing to carry one. Set it with
 * `guuey apps update --brand-icon-url <url>`, which brands the agent whether
 * or not it is ever published.
 */
export async function appsPublish(
  appId: string | undefined,
  opts: {
    name?: string;
    description?: string;
    category?: string;
    json?: boolean;
  },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  const body: Record<string, unknown> = {};
  if (opts.name) body.name = opts.name;
  if (opts.description) body.description = opts.description;
  if (opts.category) body.category = opts.category;
  // Publishing always forces these — metadata flags never override them.
  body.status = 'published';
  body.visibility = 'public';

  const res = await apiRequest('POST', `/apps/${resolved}/listing`, body);
  if (!res.ok) return handleError(res, 'Failed to publish app');

  const data = (await res.json()) as { listing: AppListing };
  const shareLink = `${PORTAL_ORIGIN}/agent/${resolved}`;

  if (opts.json) {
    out.json({ shareLink, listing: data.listing });
    return;
  }

  out.success(`Published "${data.listing.name}" — listed in the store`);
  console.log('');
  console.log(`  Share link: ${shareLink}`);
}

/**
 * Handle `guuey apps unpublish [appId]`.
 *
 * Personal-apps-only: `DELETE /apps/:id/listing` 404s for workspace-owned
 * apps (see `guuey apps unpublish --help`). Idempotent — unpublishing an
 * app with no listing (or an already-archived one) still succeeds.
 * Deactivating the listing does not tear down the app itself, so the
 * direct share link keeps working; only store-browse discovery goes away.
 */
export async function appsUnpublish(
  appId: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  const res = await apiRequest('DELETE', `/apps/${resolved}/listing`);
  if (!res.ok) return handleError(res, 'Failed to unpublish app');

  const data = (await res.json()) as { listing: AppListing | null };

  if (opts.json) {
    out.json({ unpublished: true, listing: data.listing });
    return;
  }

  out.success(`App ${resolved} unpublished — the share link still works`);
}

/** `POST /v1/apps/:id/byo-users/erase` response (202). */
interface ByoUserEraseResponse {
  wipeId: string;
  status: 'queued';
}

/** `GET /v1/apps/:id/byo-users/erase-status` response. */
interface ByoUserEraseStatusResponse {
  wipeId: string;
  status: 'queued' | 'done' | 'none';
  requestedAt?: string;
  attempts?: number;
  stuck?: boolean;
}

/**
 * Handle `guuey apps byo-user erase [appId] --sub <sub>` and its `--status`
 * variant (same command; `--status` switches the request to a GET against
 * `erase-status` instead of POSTing `erase`). A thin wrapper over cliApi's
 * builder byo-user erase routes (erasecomp Task 3,
 * `backend/amplify/functions/cliApi/handlers/byo-users.ts`):
 *
 *   POST /v1/apps/{appId}/byo-users/erase                (default)
 *   GET  /v1/apps/{appId}/byo-users/erase-status?sub=…   (--status)
 *
 * Lets a builder honor a BYO-auth end-user's GDPR erasure request without
 * deleting the builder's whole Guuey app — see the handler's module doc for
 * the full authz ladder + cross-tenant boundary. Folded into this plural
 * `apps` group (erasecomp polish, founder decision) from a short-lived
 * singular `app` group that was a near-homograph beside it — appId is now
 * a positional argument, mirroring `appsGet`/`appsAccess`/… above.
 */
export async function appsByoUserErase(
  appId: string | undefined,
  opts: { sub?: string; status?: string | true; json?: boolean },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  const sub = opts.sub;
  if (!sub) {
    out.error('Usage: guuey apps byo-user erase [appId] --sub <sub> [--status]');
    process.exit(1);
  }

  if (opts.status !== undefined) {
    return appsByoUserEraseStatus(resolved, sub, opts);
  }

  const res = await apiRequest('POST', `/apps/${resolved}/byo-users/erase`, { sub });
  if (!res.ok) return handleError(res, 'Failed to erase byo-user');

  const data = (await res.json()) as ByoUserEraseResponse;

  if (opts.json) {
    out.json(data);
    return;
  }

  out.success(`Erase queued (wipeId: ${data.wipeId}, status: ${data.status})`);
  console.log('');
  console.log(
    '  queued; the memory wipe completes within ~15 minutes — check with --status;',
  );
  console.log('  thread/session deletion already completed with this command');
}

/**
 * `--status` leg: point-poll `erase-status` and render `queued|done|none`,
 * surfacing `stuck: true` as a visible operator-facing warning (the janitor
 * has retried without draining — the same condition the `fsWipeCanary`
 * Lambda's `FsWipeStuckCount`/`FsWipeOldestQueuedAgeMinutes` CloudWatch
 * alarms watch for independently; see
 * docs/operations/runbooks/followups-wave-gate.md. The alarms are a
 * backend-only addition — this doc comment change rides the CLI's next
 * published npm cut, same operator-owned ritual as every other
 * `@guuey/cli` release.
 */
async function appsByoUserEraseStatus(
  appId: string,
  sub: string,
  opts: { json?: boolean },
): Promise<void> {
  const res = await apiRequest(
    'GET',
    `/apps/${appId}/byo-users/erase-status?sub=${encodeURIComponent(sub)}`,
  );
  if (!res.ok) return handleError(res, 'Failed to fetch erase status');

  const data = (await res.json()) as ByoUserEraseStatusResponse;

  if (opts.json) {
    out.json(data);
    return;
  }

  console.log(`  status: ${data.status}`);
  if (data.requestedAt) console.log(`  requested at: ${data.requestedAt}`);
  if (typeof data.attempts === 'number') console.log(`  attempts: ${data.attempts}`);
  if (data.stuck) {
    out.error('wipe appears stuck — contact support');
  }
}
