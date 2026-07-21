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

/**
 * Whether `value` is safe to use as a `colocatedResourceUrl` path segment /
 * KV scope key (letters, digits, hyphen, underscore only). Single source of
 * truth for that rule — reused by {@link assertSafeSegment} here AND by
 * `./agent.ts#validateColocatedServerNames` (the CLI deploy-time check
 * `@guuey/cli`'s `commands/deploy.ts` runs before upload), so a bad
 * colocated server name is rejected before deploy instead of surfacing only
 * as a `POD_FATAL_BOOT_ERROR` crash-loop when the pod's `lowerColocated`
 * calls `colocatedResourceUrl` at boot.
 */
export function isValidColocatedServerName(value: string): boolean {
  return SAFE_SEGMENT_RE.test(value);
}

function assertSafeSegment(value: string, label: string): void {
  if (!isValidColocatedServerName(value)) {
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
