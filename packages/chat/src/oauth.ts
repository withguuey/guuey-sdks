/**
 * The "authorize this server" arm of R10 (guuey#178 Slice 4) — the pure
 * helpers every surface (web kit, widget, studio, portal native) uses for a
 * `hitl.ask kind:"auth"` whose `authConfig.scheme` is `oauth2`.
 *
 * The producer is the guuey runtime's MCP OAuth broker: the pod appends a
 * paused turn (`turn.done outcome:"paused"`) whose ask declares
 * `authConfig:{ scheme:"oauth2", authorizationUrl }` + `grantModes:
 * [always, once?]`. Unlike the profile-consent ask there is **no answer
 * door**: the answer IS the redirect. Picking a mode opens
 * `authorizationUrl` with two query params appended by THIS client —
 *
 *   - `mode=<grantModeId>` — the pre-chosen grant (recorded by the broker's
 *     callback; the mode is fixed BEFORE the identity-provider hop), and
 *   - `returnTo=<the surface's own location>` — where the broker 302s back
 *     to when the dance ends (`?connected=<serverName>` on success,
 *     `?error=<reason>` on failure). The broker allowlists it; the client
 *     just says where it lives.
 *
 * On return the surface strips the two params, shows a one-line notice, and
 * does nothing else: the NEXT turn's pre-turn preflight on the pod resolves
 * `connected` (or asks again). No client-side state survives the redirect
 * on purpose. "Not now" is a plain dismissal (`cancelled` — still pending,
 * re-askable); nothing is written anywhere and the ask re-emits next turn.
 *
 * Everything here is string-level (no `URL`/`URLSearchParams`) so it runs
 * identically on React Native, whose URL polyfill is partial.
 */
import type { AgPausedAsk } from "@silverprotocol/core";

/** The `authConfig.scheme` this arm recognises (the spec's OAuth 2 vocabulary). */
export const OAUTH_SCHEME = "oauth2";

/** The query params THIS client appends to the authorize link. */
export const OAUTH_LINK_PARAMS = { mode: "mode", returnTo: "returnTo" } as const;

/** The query params the broker's callback appends to `returnTo`. */
export const OAUTH_RETURN_PARAMS = { connected: "connected", error: "error" } as const;

/** What an auth ask declares once narrowed to the OAuth arm. */
export interface OAuthAuthorizeAsk {
  authorizationUrl: string;
  scopes: readonly string[];
}

/**
 * Narrow an ask to the OAuth arm: `kind:"auth"` + `authConfig.scheme ===
 * "oauth2"` + an `authorizationUrl` to open. Anything else (a plain
 * approval, an auth ask with another scheme, a URL-less declaration) is
 * `null` and renders as an ordinary hitl card.
 */
export function oauthAuthorizeAsk(ask: AgPausedAsk): OAuthAuthorizeAsk | null {
  if (ask.kind !== "auth" || ask.authConfig === undefined) return null;
  const { scheme, authorizationUrl, scopes } = ask.authConfig;
  if (scheme !== OAUTH_SCHEME || authorizationUrl === undefined || authorizationUrl === "") return null;
  return { authorizationUrl, scopes: scopes ?? [] };
}

/**
 * The link to open for a mode pick: `authorizationUrl` + `&mode=<grantModeId>`
 * + `&returnTo=<returnTo>` (each value URI-encoded; `?` vs `&` chosen from
 * the URL as declared). `grantModeId` is required iff the ask declares
 * modes (`null` = a plain accept on a mode-less auth ask — no `mode` param).
 * Throws on a mode the ask did not declare — the inputs came from the
 * declaration itself, so a mismatch is a construction bug, never a user
 * state.
 */
export function oauthAuthorizeHref(ask: AgPausedAsk, grantModeId: string | null, returnTo: string): string {
  const oauth = oauthAuthorizeAsk(ask);
  if (oauth === null) throw new Error("oauthAuthorizeHref: the ask is not an oauth2 auth ask");
  const declared = ask.grantModes ?? [];
  if (grantModeId === null && declared.length > 0) {
    throw new Error(`oauthAuthorizeHref: ${ask.askId} declares grant modes — a mode is required`);
  }
  if (grantModeId !== null && !declared.some((m) => m.id === grantModeId)) {
    throw new Error(`oauthAuthorizeHref: grant mode "${grantModeId}" is not declared on ${ask.askId}`);
  }
  if (returnTo === "") throw new Error("oauthAuthorizeHref: returnTo is required");
  const sep = oauth.authorizationUrl.includes("?") ? "&" : "?";
  const mode = grantModeId === null ? "" : `${OAUTH_LINK_PARAMS.mode}=${encodeURIComponent(grantModeId)}&`;
  return `${oauth.authorizationUrl}${sep}${mode}${OAUTH_LINK_PARAMS.returnTo}=${encodeURIComponent(returnTo)}`;
}

/** The broker's answer, lifted off the return location. */
export type OAuthReturn =
  | { kind: "connected"; serverName: string }
  | { kind: "error"; reason: string };

/** `decodeURIComponent` that yields the raw text for a malformed escape (a foreign param is not ours to fail on). */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** Split a URL (or bare query) into its query pairs — RN-safe, no `URLSearchParams`. */
function queryPairs(urlOrQuery: string): Array<[string, string]> {
  const q = urlOrQuery.indexOf("?");
  let query = q === -1 ? (urlOrQuery.startsWith("&") || !urlOrQuery.includes("=") ? "" : urlOrQuery) : urlOrQuery.slice(q + 1);
  const hash = query.indexOf("#");
  if (hash !== -1) query = query.slice(0, hash);
  const pairs: Array<[string, string]> = [];
  for (const part of query.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? "" : part.slice(eq + 1);
    pairs.push([safeDecode(k), safeDecode(v)]);
  }
  return pairs;
}

/**
 * Read the broker's return params off a location (a full URL, a deep link
 * like `guuey://oauth/done?connected=linear`, or a bare `?connected=…`
 * query). `null` when neither param is present. `connected` wins when both
 * appear (the broker never sends both).
 */
export function parseOAuthReturn(urlOrQuery: string): OAuthReturn | null {
  let connected: string | undefined;
  let error: string | undefined;
  for (const [k, v] of queryPairs(urlOrQuery)) {
    if (k === OAUTH_RETURN_PARAMS.connected && v !== "") connected ??= v;
    else if (k === OAUTH_RETURN_PARAMS.error && v !== "") error ??= v;
  }
  if (connected !== undefined) return { kind: "connected", serverName: connected };
  if (error !== undefined) return { kind: "error", reason: error };
  return null;
}

/**
 * The same location with the broker's return params removed (every other
 * param, and the hash, preserved). Idempotent; a URL without them is
 * returned unchanged. This is what a surface writes back into its address
 * bar (`history.replaceState`) so a reload never re-shows the notice — and
 * what it passes as `returnTo` for the next dance.
 */
export function stripOAuthReturn(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const hashAt = url.indexOf("#", q);
  const base = url.slice(0, q);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const query = hashAt === -1 ? url.slice(q + 1) : url.slice(q + 1, hashAt);
  const kept = query
    .split("&")
    .filter((part) => {
      if (part === "") return false;
      const eq = part.indexOf("=");
      const key = safeDecode(eq === -1 ? part : part.slice(0, eq));
      return key !== OAUTH_RETURN_PARAMS.connected && key !== OAUTH_RETURN_PARAMS.error;
    })
    .join("&");
  return kept === "" ? `${base}${hash}` : `${base}?${kept}${hash}`;
}
