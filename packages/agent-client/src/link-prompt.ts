/**
 * Client for the pod's `POST /v1/link-prompt/dismiss` route (nocode-runtime
 * linkcoh T4) — the "don't ask again" action on the
 * {@link ProfileLinkRequest} prompt (see `./sse`'s `parseLinkRequest` and
 * `useAgentInvoke`'s `profileLinkRequest` state). Host-agnostic like
 * {@link fetchThreadHistory} in `./history`: takes a bearer directly (the
 * route authenticates ONLY off the verified bearer — the request body is
 * never read server-side, so there is nothing else to send) and an
 * injectable `fetchImpl` for tests, defaulting to the global `fetch`.
 */

/**
 * Dismiss the pending cross-app profile link prompt for the calling byo
 * end-user. `baseUrl` is the AGENT's endpoint (the `Live at` URL, or
 * `guuey apps get`) plus `/v1`, for example `https://<agent endpoint>/v1`:
 * the route is the agent pod's own. It is NOT {@link fetchThreadHistory}'s
 * base: the public API host (`https://api.<region>.guuey.com/v1`) has no
 * link-prompt route, so a dismiss sent there fails. (On a custom domain the
 * edge sends `/v1/link-prompt/*` to the pod and every other `/v1/*` path to
 * the public API, so there one base serves both.) `bearer` is the caller's
 * byo access token, sent as `Authorization: Bearer <bearer>`: the ONLY thing
 * the pod's route reads to determine the dismissal subject.
 *
 * Resolves on a 204 (the route's only success response); throws on any
 * non-2xx status (401 unauthenticated, 403 non-byo caller, 500 write failure).
 */
export async function dismissLinkPrompt(
  baseUrl: string,
  bearer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${baseUrl}/link-prompt/dismiss`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    throw new Error(`link prompt dismiss failed: ${res.status}`);
  }
}
