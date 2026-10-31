/**
 * The ONE place the CLI builds an `Authorization` header that is not a cliApi
 * one: `guuey test --bearer-stdin` (guuey#2719) sends an end user's token to
 * the app's agent pod (`POST /agent/invoke`), which verifies it against the
 * guuey end-user pool or the app's BYO issuer (`nocode-runtime/src/identity.ts`).
 *
 * It is NOT `cliApiAuthHeaders`: the pod is not the platform API, the token is
 * not the builder's PAT, and `X-Guuey-Client` means nothing there. Kept in its
 * own module so the source guard in `cli-api-headers.test.ts` exempts exactly
 * this line and still guards every other line of `test.ts`.
 */
export function podBearerHeader(accessToken: string): { Authorization: string } {
  return { Authorization: `Bearer ${accessToken}` };
}
