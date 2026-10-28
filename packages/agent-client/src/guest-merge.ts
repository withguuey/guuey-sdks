/**
 * `mergeGuestThreads` — after a visitor who chatted as a guest signs in with
 * the app's OWN sign-in (a BYO issuer), move that guest's conversations in
 * this app to the signed-in user, so the same thread carries on under the
 * bearer instead of forking.
 *
 * `POST {apiBaseUrl}/agents/{appId}/merge-guest`. The server reads BOTH
 * identities from the request itself, never from the body:
 *
 *   - the signed-in user from `Authorization: Bearer <token>` (verified
 *     against the app's own issuer and audience);
 *   - the guest from the `x-guuey-guest` header when the device holds the
 *     secret ({@link MergeGuestThreadsOptions.getGuestSecret}), else from the
 *     `guuey_guest` cookie, which `credentials: "include"` carries when the
 *     API shares the page's site. The secret is never put in the body.
 *
 * Pass the open thread's id in `threadIds` — it may be too new for the
 * server's index — and keep using that SAME thread id afterwards. Then rotate
 * or clear the guest secret, so threads created later under it stay
 * unlinkable. The server moves at most 100 threads per call and pages with a
 * cursor; this function follows it a bounded number of times.
 *
 * A run the guest left paused does not resume after the merge: the user sends
 * again. A plane without the route answers 404, reported as
 * `{ supported: false }` — keep the pre-merge behaviour (a new thread under
 * the bearer). Never throws.
 */
import { parseRetryAfterSeconds } from "./errors.js";
import { GUEST_HEADER, sendableGuestSecret } from "./transport.js";
import { isWireObject } from "./wire-object.js";

export interface MergeGuestThreadsOptions {
  /** The guuey public API base (`…/v1`) — the same base the transcript reads use. */
  apiBaseUrl: string;
  /** The app whose guest threads move. The bearer must come from this app's sign-in. */
  appId: string;
  /** The signed-in (BYO) bearer. */
  getAccessToken: (opts?: { forceRefresh?: boolean }) => Promise<string | null>;
  /**
   * The guest secret the device holds, read BEFORE it is rotated. Absent, or
   * returning null, means a cookie-mode guest: the cookie is the carrier.
   */
  getGuestSecret?: () => string | null;
  /** The guest's open thread(s), at most 20 — moved first. */
  threadIds?: readonly string[];
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export type MergeGuestThreadsResult =
  | { supported: true; ok: true; moved: number; skipped: number }
  /** The plane has no merge route (404): keep the pre-merge behaviour. */
  | { supported: false }
  | {
      supported: true;
      ok: false;
      /** The HTTP status; 0 when no response came back. */
      status: number;
      /** The server's error code, or `NO_ACCESS_TOKEN` / `NETWORK` / `BAD_RESPONSE`. */
      code: string | null;
      retryAfterSeconds?: number;
    };

/** Calls one merge may make while following the server's cursor. */
const MAX_MERGE_CALLS = 5;

export async function mergeGuestThreads(options: MergeGuestThreadsOptions): Promise<MergeGuestThreadsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await options.getAccessToken().catch(() => null);
  if (!token) return { supported: true, ok: false, status: 0, code: "NO_ACCESS_TOKEN" };
  const guest = sendableGuestSecret(options.getGuestSecret?.() ?? null);
  const url = `${options.apiBaseUrl}/agents/${encodeURIComponent(options.appId)}/merge-guest`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...(guest !== null ? { [GUEST_HEADER]: guest } : {}),
  };

  let moved = 0;
  let skipped = 0;
  let cursor: string | undefined;
  for (let call = 0; call < MAX_MERGE_CALLS; call++) {
    const body =
      cursor !== undefined
        ? { cursor }
        : options.threadIds !== undefined && options.threadIds.length > 0
          ? { threadIds: [...options.threadIds] }
          : {};
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "POST", headers, credentials: "include", body: JSON.stringify(body) });
    } catch {
      return { supported: true, ok: false, status: 0, code: "NETWORK" };
    }
    if (res.status === 404 && call === 0) return { supported: false };
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = null; // not JSON: no code on a refusal, BAD_RESPONSE on a 2xx
    }
    const wire = isWireObject(parsed) ? parsed : null;
    if (!res.ok) {
      const error = wire !== null && isWireObject(wire.error) ? wire.error : null;
      const code = typeof error?.code === "string" ? error.code : null;
      const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get("Retry-After"));
      return {
        supported: true,
        ok: false,
        status: res.status,
        code,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      };
    }
    if (wire === null || typeof wire.moved !== "number" || typeof wire.skipped !== "number") {
      return { supported: true, ok: false, status: res.status, code: "BAD_RESPONSE" };
    }
    moved += wire.moved;
    skipped += wire.skipped;
    if (typeof wire.nextCursor !== "string" || wire.nextCursor === "") break;
    cursor = wire.nextCursor;
  }
  return { supported: true, ok: true, moved, skipped };
}
