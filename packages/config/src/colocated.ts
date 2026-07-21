/**
 * Synthetic resource-URL helper for `kind: 'colocated'` MCP servers.
 *
 * A colocated MCP has no real network URL (it's a guuey-managed HTTP child
 * inside the agent pod, reached over a loopback/localhost hop the Router
 * wires up) — but RFC 8707 federation still needs a stable `aud`/resource
 * value to mint against, and `@guuey/state`'s KV needs a stable scope key.
 * `colocatedResourceUrl` composes both from `(appId, serverName)`.
 *
 * The returned URL is consumed by `backend/amplify/functions/oidcMint/
 * handler.ts`'s `parseMcpResourceUrl`, which requires: `https://` prefix,
 * a trailing `/`, and a total length ≤ 512 chars. Both segments are
 * validated against `/^[A-Za-z0-9_-]+$/` BEFORE composing the URL — they
 * are used verbatim as URL path segments AND as a KV scope key, so an
 * unvalidated segment (e.g. containing `/` or whitespace) could smuggle an
 * extra path segment or break the scope contract.
 */

const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT_RE.test(value)) {
    throw new Error(
      `colocatedResourceUrl: ${label} "${value}" must match ${SAFE_SEGMENT_RE.source} (it composes a URL path segment and a KV scope key)`,
    );
  }
}

/**
 * Build the synthetic `https://colocated.guuey.com/<appId>/<serverName>/`
 * resource URL for a colocated MCP server. Throws if either segment fails
 * the safe-segment check.
 */
export function colocatedResourceUrl(appId: string, serverName: string): string {
  assertSafeSegment(appId, 'appId');
  assertSafeSegment(serverName, 'serverName');
  return `https://colocated.guuey.com/${appId}/${serverName}/`;
}
