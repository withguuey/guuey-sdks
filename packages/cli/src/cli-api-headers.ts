/**
 * The headers every cliApi request carries: the caller's bearer, and
 * `X-Guuey-Client: cli`, which tells the platform an app it creates came from
 * the CLI (the server records which client created each app; the header is
 * attribution only, never authorization).
 *
 * ONE builder, so no request can forget the header: a source guard
 * (`cli-api-headers.test.ts`) refuses any other bearer header built by hand
 * in the CLI's sources.
 *
 * The header name and value mirror the platform's wire contract (this
 * published package cannot import the private one); the platform's own test
 * pins the two equal.
 */

/** Lower-case, the way the platform reads it; HTTP header names are case-insensitive. */
export const GUUEY_CLIENT_HEADER = 'x-guuey-client';
export const GUUEY_CLIENT_CLI = 'cli';

/** The authorization and client headers for one cliApi request. */
export function cliApiAuthHeaders(bearer: string): { Authorization: string; [GUUEY_CLIENT_HEADER]: string } {
  return { Authorization: `Bearer ${bearer}`, [GUUEY_CLIENT_HEADER]: GUUEY_CLIENT_CLI };
}

/**
 * A bearer header built by hand in source text, for the source guard, in
 * every form: a template (`Authorization: \`Bearer ${…}\``), a concatenation
 * (`'Bearer ' + …`), a `Headers#set('Authorization', …)`, and an assignment
 * (`headers['Authorization'] = …`, `headers.Authorization = …`).
 */
const HAND_BUILT_BEARER_RE =
  /['"]?[Aa]uthorization['"]?\s*:\s*`Bearer \$\{[^}]*\}`|['"]Bearer ['"]\s*\+|\.set\(\s*['"][Aa]uthorization['"]|\[\s*['"][Aa]uthorization['"]\s*\]\s*=(?!=)|\.[Aa]uthorization\s*=(?!=)/g;

/** Every hand-built bearer header in `source` — what the guard refuses outside this file. */
export function findHandBuiltBearers(source: string): string[] {
  return source.match(HAND_BUILT_BEARER_RE) ?? [];
}
