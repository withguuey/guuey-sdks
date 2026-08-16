/**
 * `@guuey/widget-auth` — mint end-user identity tokens for a guuey embeddable
 * widget, from your own backend.
 *
 * ```ts
 * import { signUserToken } from '@guuey/widget-auth';
 *
 * const { token, expiresAtEpoch } = await signUserToken(
 *   { userId: user.id, name: user.name, email: user.email },
 *   { appId: process.env.GUUEY_APP_ID!, appSecret: process.env.GUUEY_APP_SECRET! },
 * );
 * ```
 *
 * ## One token, every surface
 *
 * The token is a plain RS256 JWT bound to your app's own issuer and audience —
 * `iss`, `sub` (= `userId`), `aud`, `iat`/`nbf`/`exp`, optional `name`/`email` —
 * with nothing widget-specific in it. Every guuey consumer verifies it the same
 * way and derives the same end-user identity from `userId`, so the widget
 * embed, a standalone agent page and **your own page built on
 * `@guuey/agent-client` / `@guuey/chat`** (`createWebAdapters({ getAccessToken })`)
 * all see one user with one history, memory and profile. "widget" in this
 * package's name is the name of the app's per-app issuer, not a limit on where
 * the token may be presented (guuey#206).
 *
 * ## What this package does NOT do, and why that matters
 *
 * It holds no key material and assembles no claims. The app's RSA private key
 * lives sealed in the platform's KMS and never leaves it, so this package is a
 * typed, validated HTTP call to the mint route and nothing more.
 *
 * In particular, **the token's time claims are assembled server-side and this
 * package must never re-implement them.** The signer sets `iat` and `nbf`
 * backdated 60 seconds — absorbing ordinary clock drift between the signer and
 * the agent pod, which verifies with zero clock tolerance — and derives `exp`
 * from the real current time, so the backdating buys verification headroom
 * without shortening the token's usable life. It also sets `iss` from the app's
 * canonical issuer string and `aud` from the app's own configuration. Sending
 * any of those from here is rejected outright by the signer's strict claim
 * parser, which allowlists exactly `sub`, `name` and `email` — so the rule is
 * enforced by the other end rather than merely stated here.
 *
 * Were the backdate re-implemented here anyway, the damage would not be a
 * shorter token: `exp` does not move, so nothing expires sooner. It would WIDEN
 * the acceptance window — `nbf` slides another 60s into the past, so the
 * skew margin silently stops being the 60 seconds it is documented as — and
 * `iat` would misstate the token's age to every consumer that reads it.
 *
 * ## The app secret is a SERVER-side credential
 *
 * `appSecret` authorizes minting an identity for *any* user of your app. It must
 * live only on your backend. If it reaches a browser — bundled into frontend
 * code, or because this package was called from the client — anyone who reads it
 * can mint a token for any of your users, which is the entire threat model this
 * design exists to prevent. That is why the widget asks *your* server for a
 * token rather than minting one itself.
 */
import {
  isAbortError,
  redactSecret,
  WidgetAuthAppNotConfiguredError,
  WidgetAuthConfigError,
  WidgetAuthCredentialError,
  WidgetAuthError,
  WidgetAuthNetworkError,
  WidgetAuthRequestError,
  WidgetAuthServiceError,
} from './errors.js';

export {
  WidgetAuthAppNotConfiguredError,
  WidgetAuthConfigError,
  WidgetAuthCredentialError,
  WidgetAuthError,
  WidgetAuthNetworkError,
  WidgetAuthRequestError,
  WidgetAuthServiceError,
};

/** The credential family the mint route accepts. */
const SECRET_PREFIX = 'guuey_widget_';

/** The mint route's path, appended to the resolved API base URL. */
const MINT_PATH = '/v1/widget/token';

/**
 * Field caps, mirroring the token service's own.
 *
 * They exist server-side because KMS refuses to sign a message over 4096 bytes
 * and these fields are caller-controlled. Mirroring them here turns a round trip
 * that ends in a 400 into an immediate, local error naming the field — and the
 * service still enforces them, so a skew between this package and a newer
 * deployment fails safe rather than silently.
 */
const MAX_USER_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;

/** TTL bounds, mirroring the service. The default (900s) is the service's. */
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 3600;

/** How much of a service-supplied message to keep in an error. */
const MAX_SERVICE_MESSAGE_LENGTH = 400;

/** The end-user a token is being minted for. */
export interface WidgetUser {
  /**
   * Your stable identifier for this user — it becomes the token's `sub`, and the
   * platform derives the user's durable widget identity from it.
   *
   * It must be stable for the life of the account: it is what ties a returning
   * visitor to their existing conversations, memory and files. A value that
   * changes (a session id, an email that can be edited) silently orphans all of
   * it and the user reappears as a stranger.
   */
  userId: string;
  /** Display name, shown in the widget. Optional. */
  name?: string;
  /** Email, available to the agent. Optional. */
  email?: string;
}

/** Where to mint, and as whom. */
export interface WidgetAuthConfig {
  /** The guuey app this token is for. */
  appId: string;
  /**
   * The app secret from `guuey widget keys create`. **Server-side only** — see
   * the module docblock.
   */
  appSecret: string;
  /**
   * The guuey API base URL, e.g. `https://api.guuey.com`. Falls back to the
   * `GUUEY_API_URL` environment variable.
   *
   * There is deliberately no compiled-in default: the API base differs per
   * environment, and a wrong built-in default would fail in a way that looks
   * like a credential problem rather than a configuration one.
   */
  apiBaseUrl?: string;
  /**
   * Token lifetime in seconds, `1..3600`. Defaults to the service's 15 minutes.
   *
   * Shorter is safer — the token is a bearer credential held in a browser, and
   * the widget re-requests one from you when it expires. Prefer the default over
   * a long TTL; it is not a session length.
   */
  ttlSeconds?: number;
  /** Aborts the request. */
  signal?: AbortSignal;
  /** Override the HTTP client. Intended for tests. */
  fetch?: FetchLike;
}

/**
 * A minted token, exactly as the mint route returns it — a hand mirror of
 * `@guuey-private/cli-wire`'s `AppUserTokenMintResponse`, pinned by
 * `wire-sync.test.ts`.
 */
export interface WidgetToken {
  /** The signed JWT — hand it to the widget, or to your own surface's `getAccessToken`. */
  token: string;
  /** Unix epoch seconds at which `token` stops verifying. */
  expiresAtEpoch: number;
  /** The issuer that signed it. */
  issuer: string;
  /** The signing key's id. */
  kid: string;
}

/** The request shape this package sends. */
export interface WidgetAuthRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/** The part of a `fetch` response this package reads. */
export interface WidgetAuthFetchResponse {
  status: number;
  json(): Promise<unknown>;
}

/**
 * The HTTP seam. Structurally satisfied by the global `fetch`, so overriding it
 * is only needed in tests.
 */
export type FetchLike = (
  url: string,
  init: WidgetAuthRequestInit,
) => Promise<WidgetAuthFetchResponse>;

/**
 * The JSON body the mint route accepts — a hand mirror of
 * `@guuey-private/cli-wire`'s `AppUserTokenMintBody` (this package is
 * published and cannot import the private lib); `wire-sync.test.ts` pins the
 * two together whenever the monorepo is present.
 */
interface MintRequestBody {
  appId: string;
  userId: string;
  name?: string;
  email?: string;
  ttlSeconds?: number;
}

/**
 * Mint an end-user token for your widget.
 *
 * Resolves with a {@link WidgetToken}, or **throws** — always a
 * {@link WidgetAuthError} subclass, never a partially-formed result. See
 * `errors.ts` for the taxonomy and which failures a retry can fix.
 *
 * @param user   the end-user this token identifies
 * @param config the app, its secret, and where to mint
 */
export async function signUserToken(
  user: WidgetUser,
  config: WidgetAuthConfig,
): Promise<WidgetToken> {
  // FIRST, before any other check. Running in a browser is not one
  // misconfiguration among several — it means the secret is already in a
  // shipped bundle, and saying "appId is required" to someone in that position
  // would be answering the wrong question.
  assertNotBrowser();

  const { appId, appSecret } = config;

  // Validate everything before touching the network: a configuration mistake
  // should cost nothing, name its own field, and never be confusable with an
  // outage or a rejected credential.
  requireNonEmpty(appId, 'appId');
  requireNonEmpty(appSecret, 'appSecret');
  if (!appSecret.startsWith(SECRET_PREFIX)) {
    // Checked locally so a credential from another family is never transmitted
    // at all — and because the service's answer would be the deliberately
    // uninformative 401, which would send the reader hunting for the wrong bug.
    throw new WidgetAuthConfigError(
      `appSecret does not look like a widget app secret (expected it to start with "${SECRET_PREFIX}"). ` +
        'Widget secrets come from `guuey widget keys create <appId>`; a personal access token or ' +
        'workspace API key will not work on this route.',
    );
  }

  const baseUrl = resolveBaseUrl(config.apiBaseUrl);
  const body = buildBody(appId, user, config.ttlSeconds);
  const doFetch = resolveFetch(config.fetch);

  const init: WidgetAuthRequestInit = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${appSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
  if (config.signal !== undefined) init.signal = config.signal;

  let response: WidgetAuthFetchResponse;
  try {
    response = await doFetch(`${baseUrl}${MINT_PATH}`, init);
  } catch (err) {
    // A caller-initiated abort is NOT retryable — see `isAbortError`.
    const aborted = isAbortError(err);
    throw new WidgetAuthNetworkError(
      aborted
        ? `The mint request to ${baseUrl} was aborted by the caller.`
        : `Could not reach the guuey token service at ${baseUrl}: ${describe(err, appSecret)}`,
      { cause: err, retryable: !aborted },
    );
  }

  // A body that is not JSON is a fact about the response, not an exception:
  // a proxy's HTML error page is a perfectly ordinary way for this to fail, and
  // it must map onto the taxonomy rather than escaping as a SyntaxError.
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (response.status !== 200) {
    throw mapFailure(response.status, payload, appSecret);
  }
  return readToken(payload);
}

// ─── Validation ────────────────────────────────────────────────────────

/**
 * Refuse to run in a browser.
 *
 * This package's entire threat model is that `appSecret` never leaves the
 * server. Everything else here — the redaction, the non-enumerable `cause`, the
 * never-a-garbage-token property — defends a secret that is already in the right
 * place. None of it helps if the secret was bundled into a page, where every
 * visitor can read it and mint an identity for any of your users. That is the
 * one failure this package can detect itself, so it does, loudly, instead of
 * documenting it and hoping.
 *
 * **Why BOTH `window` and `document`, and not either alone.** Edge runtimes
 * (Cloudflare Workers, Vercel Edge, Deno Deploy) are legitimate places to mint
 * from, and some of them define a `window`-ish global while defining no `document`
 * — testing `window` alone would refuse a correct deployment. A DOM is the thing
 * that actually distinguishes a page from a server-side JS runtime, so the pair
 * is the discriminator and the conjunction is deliberate, not defensive noise.
 *
 * Called from every exported entry path. There is one today; anything added
 * later calls this first, for the same reason.
 *
 * Probed through `globalThis` by name rather than written as
 * `typeof window !== 'undefined'` because `lib` is pinned to `["ES2022"]` with
 * no `dom`, so those identifiers do not exist for the compiler. Adding `dom`
 * to satisfy the check would declare browser globals throughout a package whose
 * whole point is that it does not run in one — the wrong fix. Comparing the
 * value against `undefined` (rather than testing key presence) keeps the
 * `typeof` semantics: a runtime that defines `globalThis.window = undefined` is
 * not a browser and must not be refused.
 */
function globalIsDefined(name: string): boolean {
  return Reflect.get(globalThis, name) !== undefined;
}

function assertNotBrowser(): void {
  if (globalIsDefined('window') && globalIsDefined('document')) {
    throw new WidgetAuthConfigError(
      '@guuey/widget-auth ran in a browser, and refused. Your app secret authorizes minting ' +
        'an identity for ANY user of your app, so if this code reached a browser the secret is ' +
        'in your shipped bundle and every visitor can read it — rotate it now with ' +
        '`guuey widget keys rotate <appId> --new-secret`. Mint on your server instead and hand ' +
        'the returned token to the widget: that is what the widget asks your backend for a ' +
        'token rather than minting one itself.',
    );
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WidgetAuthConfigError(`${field} is required.`);
  }
}

function requireWithin(value: string, max: number, field: string): void {
  if (value.length > max) {
    throw new WidgetAuthConfigError(
      `${field} must be ${max} characters or less (got ${value.length}).`,
    );
  }
}

/**
 * Resolve the API base, trimming trailing slashes so callers can pass either
 * form without producing a `//v1/...` path.
 */
function resolveBaseUrl(configured: string | undefined): string {
  const raw = configured ?? readEnv('GUUEY_API_URL');
  if (raw === undefined || raw.length === 0) {
    throw new WidgetAuthConfigError(
      'No guuey API base URL. Pass `apiBaseUrl` or set the GUUEY_API_URL environment variable ' +
        '(for example https://api.guuey.com).',
    );
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Read an environment variable without assuming a Node-shaped global.
 *
 * The tolerance is for EDGE RUNTIMES — Cloudflare Workers, Vercel Edge, Deno
 * Deploy — which are legitimate places to mint from and may not expose
 * `process`. It is emphatically not tolerance for browsers, which
 * {@link assertNotBrowser} refuses outright; an earlier version of this comment
 * said "edge or browser bundle", which read as sanctioning exactly the
 * deployment this package exists to prevent.
 */
function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env?.[name];
}

function buildBody(
  appId: string,
  user: WidgetUser,
  ttlSeconds: number | undefined,
): MintRequestBody {
  requireNonEmpty(user.userId, 'userId');
  requireWithin(user.userId, MAX_USER_ID_LENGTH, 'userId');

  const body: MintRequestBody = { appId, userId: user.userId };

  if (user.name !== undefined) {
    requireWithin(user.name, MAX_NAME_LENGTH, 'name');
    body.name = user.name;
  }
  if (user.email !== undefined) {
    requireWithin(user.email, MAX_EMAIL_LENGTH, 'email');
    body.email = user.email;
  }
  if (ttlSeconds !== undefined) {
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < MIN_TTL_SECONDS ||
      ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new WidgetAuthConfigError(
        `ttlSeconds must be a whole number of seconds between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS} (got ${ttlSeconds}).`,
      );
    }
    body.ttlSeconds = ttlSeconds;
  }
  return body;
}

function resolveFetch(configured: FetchLike | undefined): FetchLike {
  if (configured !== undefined) return configured;
  if (typeof globalThis.fetch !== 'function') {
    throw new WidgetAuthConfigError(
      'No global fetch available. @guuey/widget-auth needs Node 18 or newer, or a `fetch` ' +
        'implementation passed as `config.fetch`.',
    );
  }
  const globalFetch = globalThis.fetch;
  return (url, init) => globalFetch(url, init);
}

// ─── Response handling ─────────────────────────────────────────────────

/** Pull `error.message` out of the service's error envelope, if it has one. */
function serviceMessage(payload: unknown, secret: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string' || message.length === 0) return undefined;
  return truncate(redactSecret(message, secret), MAX_SERVICE_MESSAGE_LENGTH);
}

/** Describe a thrown value for a message, redacted and bounded. */
function describe(err: unknown, secret: string): string {
  const text = err instanceof Error ? err.message : String(err);
  return truncate(redactSecret(text, secret), MAX_SERVICE_MESSAGE_LENGTH);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Map a non-200 onto the taxonomy. */
function mapFailure(status: number, payload: unknown, secret: string): WidgetAuthError {
  const detail = serviceMessage(payload, secret);
  const suffix = detail === undefined ? '' : ` ${detail}`;

  if (status === 401) {
    return new WidgetAuthCredentialError(
      'The widget app secret was not accepted. It may be wrong, revoked, or for a different app — ' +
        'these are deliberately indistinguishable, so that this route cannot be used to discover ' +
        `which apps exist. Check the secret, then \`guuey widget keys\`.${suffix}`,
      status,
    );
  }
  if (status === 409) {
    return new WidgetAuthAppNotConfiguredError(
      `The app is not configured to accept tokens from its own widget issuer.${suffix}`,
      status,
    );
  }
  if (status === 400) {
    return new WidgetAuthRequestError(
      'The token service rejected the request. @guuey/widget-auth validates these fields itself, ' +
        `so this usually means it is out of date with the deployed API.${suffix}`,
      status,
    );
  }
  if (status >= 500) {
    return new WidgetAuthServiceError(
      `The guuey token service failed (HTTP ${status}). This is usually transient — retry with backoff.${suffix}`,
      status,
      true,
    );
  }
  return new WidgetAuthServiceError(
    `Unexpected response from the guuey token service (HTTP ${status}).${suffix}`,
    status,
    false,
  );
}

/**
 * Validate a 200 body into a {@link WidgetToken}.
 *
 * Every field is checked before anything is returned. A 200 carrying a body this
 * package cannot recognize is an ERROR, never a best-effort object: the caller
 * hands the result to a browser, so a `token` that is `undefined`, empty, or a
 * number would become an authentication failure surfacing far from its cause —
 * or, worse, a value from a response nobody authenticated.
 */
function readToken(payload: unknown): WidgetToken {
  const unusable = (why: string): WidgetAuthServiceError =>
    new WidgetAuthServiceError(
      `The guuey token service returned a response this package cannot use: ${why}. ` +
        'No token was issued.',
      200,
      false,
    );

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw unusable('the body was not a JSON object');
  }
  const body = payload as {
    token?: unknown;
    expiresAtEpoch?: unknown;
    issuer?: unknown;
    kid?: unknown;
  };

  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw unusable('`token` was missing or not a non-empty string');
  }
  if (typeof body.expiresAtEpoch !== 'number' || !Number.isFinite(body.expiresAtEpoch)) {
    throw unusable('`expiresAtEpoch` was missing or not a number');
  }
  if (typeof body.issuer !== 'string' || typeof body.kid !== 'string') {
    throw unusable('`issuer` or `kid` was missing');
  }

  return {
    token: body.token,
    expiresAtEpoch: body.expiresAtEpoch,
    issuer: body.issuer,
    kid: body.kid,
  };
}
