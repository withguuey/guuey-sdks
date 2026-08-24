/**
 * The web SSE invoke transport, and the guest-identity wire pieces it shares
 * with the read-plane adapters.
 *
 * Its own module (rather than living in `./web-adapters.ts`) for the same
 * reason `AgentResponseError` lives in `./errors.ts`, one level down: the
 * web-adapter bundle takes VALUE imports of `@guuey/mcp-apps-host` (the
 * ui-resource reader / action-relay assemblies), so a consumer that only
 * wants the transport — a custom chat surface with its own card layer, or
 * none — would drag the whole host-role graph into its build, and any
 * version skew between the two packages becomes that consumer's build
 * failure (guuey#186 G2). This module's import closure is
 * `types`/`errors`/`saturation-retry` only; `./web-adapters.ts` imports
 * from HERE, never the reverse, and `@guuey/agent-client/transport`
 * publishes exactly this graph.
 */
import type { InvokeRequest, InvokeTransport } from "./types.js";
import { AgentResponseError } from "./errors.js";
import {
  parseRetryAfterSeconds,
  withColdStartRetry,
  withSaturationRetry,
  type ColdStartRetryOptions,
  type SaturationRetryOptions,
} from "./saturation-retry.js";

/**
 * Header carrying a caller-owned anonymous guest secret. A LOCAL MIRROR of the
 * two server-side constants — the pod's `GUEST_HEADER_NAME`
 * (`backend/services/nocode-runtime/src/identity.ts`) and the read plane's
 * `GUEST_HEADER` (`backend/amplify/functions/publicApi/identity.ts`) — because
 * this is a published npm package and cannot take a `@guuey-private` dep (same
 * arrangement as `@guuey/host`'s mirrored fs-contract constants). The string is
 * a wire contract: both planes already advertise it in
 * `Access-Control-Allow-Headers`, so changing it is a breaking protocol change,
 * not a rename.
 */
export const GUEST_HEADER = "x-guuey-guest";

/**
 * A well-formed guest secret: exactly 32 bytes as 64 LOWERCASE hex chars —
 * the shape `crypto.getRandomValues` + hex-encoding mints.
 *
 * Deliberately stricter than the server's `/^[a-f0-9]{64}$/i` (pod
 * `identity.ts`, publicApi `identity.ts`): both sides lowercase before
 * hashing, so an uppercase secret would in fact be accepted, but the only
 * supported mint path emits lowercase and a non-canonical value means the
 * caller's storage is not what this adapter expects. Anything that fails is
 * IGNORED — the request falls through to cookie mode rather than sending a
 * secret the two identity planes might key differently.
 */
const GUEST_SECRET_RE = /^[0-9a-f]{64}$/;

/**
 * Narrow a caller-supplied guest secret to a value that is safe to put on the
 * wire, or `null`. The single gate for the header: every write of
 * {@link GUEST_HEADER} in this package goes through it, so a malformed secret
 * can never reach a request. The value is never logged (here or anywhere on
 * this path) — it IS the anonymous identity, so a leak is an impersonation.
 */
export function sendableGuestSecret(secret: string | null | undefined): string | null {
  return typeof secret === "string" && GUEST_SECRET_RE.test(secret) ? secret : null;
}

/**
 * Is this request a cross-origin call from a browser document? Only then can
 * a fetch `TypeError` be a CORS refusal worth hinting about. `location` is
 * read via `typeof` so Node and React Native (where CORS does not exist)
 * answer false; an unparseable URL answers false rather than throwing from
 * inside error handling.
 */
function isCrossOriginBrowserCall(url: string): boolean {
  if (typeof location === "undefined") return false;
  try {
    return new URL(url).origin !== location.origin;
  } catch {
    return false;
  }
}

/**
 * One invoke attempt: opens the request and yields decoded SSE chunks.
 * {@link fetchStreamTransport} wraps this with the shared saturation retry —
 * every behaviour below is per-attempt.
 *
 * Exactly ONE identity carrier per request, in order:
 *
 *  1. `accessToken` → `Authorization: Bearer` — the pod identifies the caller
 *     by their verified access token (the same identity the history read
 *     plane uses, so persisted threads round-trip on reload).
 *  2. a well-formed `guestSecret` → `x-guuey-guest` — the caller owns and
 *     persists its own anonymous secret. The path for hosts with no usable
 *     cookie jar: React-Native, and the embedded widget, whose third-party
 *     iframe cannot rely on the pod's cookie surviving browser partitioning.
 *     The pod never mints a cookie for a header client.
 *  3. neither → `credentials: "include"`, which round-trips the HttpOnly
 *     `guuey_guest` cookie the pod mints for anonymous browser callers.
 *
 * Never two at once: a bearer wins over a guest secret, and a request that
 * carries either header does NOT also send cookie credentials.
 *
 * Reads the body via `ReadableStream.getReader()` (browser).
 */
async function* streamInvokeOnce(
  req: InvokeRequest,
  accessToken?: string | null,
  guestSecret?: string | null,
): AsyncGenerator<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const init: RequestInit = {
    method: "POST",
    signal: req.signal,
    headers,
    body: JSON.stringify(req.body),
  };
  const guest = sendableGuestSecret(guestSecret);
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else if (guest) {
    headers[GUEST_HEADER] = guest;
  } else {
    init.credentials = "include";
  }
  let resp: Response;
  try {
    resp = await fetch(req.url, init);
  } catch (err) {
    // A network-level TypeError on a CROSS-ORIGIN invoke from a browser is,
    // in practice, very often a missing allowedDomains entry — the CORS
    // preflight failed and the web platform deliberately reports nothing
    // more specific (guuey#186 Gap 2: the console.ggui.ai embed lost real
    // time to an unexplained "Failed to fetch"). The error stays a
    // TypeError with the original as `cause`; the added sentence is a HINT,
    // not a diagnosis — offline, DNS and CSP failures throw the same shape.
    // Same-origin calls and non-browser runtimes (no `location`) cannot be
    // CORS refusals, so they pass through untouched.
    if (err instanceof TypeError && isCrossOriginBrowserCall(req.url)) {
      throw new TypeError(
        `${err.message} — if this is a browser embed, check the app's allowedDomains (the CORS allowlist must include this page's origin)`,
        { cause: err },
      );
    }
    throw err;
  }
  if (!resp.ok || !resp.body) {
    // Surface a structured pod error ({ code, message }) when present — e.g. a
    // QUOTA_EXCEEDED 429 carries an upgrade message the UI should show. Fall
    // back to the bare status for non-JSON failures.
    const body: unknown = await resp.json().catch(() => null);
    let message = `agent responded ${resp.status}`;
    let code: string | undefined;
    if (body !== null && typeof body === "object") {
      if ("message" in body && typeof body.message === "string" && body.message) {
        message = body.message;
      }
      if ("code" in body && typeof body.code === "string") {
        code = body.code;
      }
    }
    throw new AgentResponseError(
      message,
      resp.status,
      code,
      parseRetryAfterSeconds(resp.headers.get("Retry-After")),
    );
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}

/** Options for {@link fetchStreamTransport}. */
export interface FetchStreamTransportOptions extends SaturationRetryOptions {
  /**
   * Bounded retry on cold-start 503s — the envelope-less refusal an embed
   * eats for ~30–60s after the agent redeploys (guuey#186 Gap 3). ON by
   * default (small budget: 3 attempts, 2s/4s/8s) for parity with guuey's
   * first-party embeds; pass `false` to disable, or options to re-budget.
   * See {@link withColdStartRetry} for exactly what matches (and what
   * deliberately stays with the saturation policy instead).
   */
  coldStartRetry?: ColdStartRetryOptions | false;
  /**
   * Injectable bearer provider (guuey#186 Gap 4) — identity is a transport
   * concern (see {@link InvokeTransport}: "owns headers + identity
   * entirely"), and a harness or non-React host holds credentials in its own
   * lifecycle, not in a closure minted once at page load. Resolved PER
   * ATTEMPT, before each request — a retry after a backoff wait re-reads it,
   * so a token that expired during the wait is refreshed rather than
   * replayed. When present it takes precedence over the positional
   * `accessToken`; resolving `null` falls through to the guest secret /
   * cookie chain exactly as a null `accessToken` does (and carries the same
   * silent-anonymous-downgrade hazard the `createWebAdapters` docs warn
   * about). A throw propagates and fails the invoke — deliberately not
   * caught, for the same reason as `getGuestSecret` there.
   */
  getBearer?: () => string | null | Promise<string | null>;
}

/**
 * The web SSE transport: {@link streamInvokeOnce} under the shared
 * {@link withSaturationRetry} wrapper, itself under {@link withColdStartRetry}.
 * Every consumer of this transport (Studio, the widget, anything built on
 * `createWebAdapters`) therefore inherits the single `POD_SATURATED` retry AND
 * the bounded cold-start 503 retry, the same pair Portal's React-Native
 * transport wears — see the wrappers' docblocks for which refusals retry,
 * which deliberately do not, and why both retries are invisible to the hook.
 * Both wrappers guard on "nothing yielded yet": once a chunk has streamed,
 * NOTHING re-POSTs.
 */
export function fetchStreamTransport(
  req: InvokeRequest,
  accessToken?: string | null,
  guestSecret?: string | null,
  options: FetchStreamTransportOptions = {},
): AsyncIterable<string> {
  const { getBearer } = options;
  const once = async function* (attempt: InvokeRequest): AsyncGenerator<string> {
    // Per-attempt resolution: each retry re-asks the provider (fresh token
    // after a backoff wait) instead of replaying a captured one.
    const bearer = getBearer ? await getBearer() : accessToken;
    yield* streamInvokeOnce(attempt, bearer, guestSecret);
  };
  const saturated = withSaturationRetry(once, {
    sleep: options.sleep,
    ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
    ...(options.onSaturationWait !== undefined
      ? { onSaturationWait: options.onSaturationWait }
      : {}),
  });
  if (options.coldStartRetry === false) return saturated(req);
  return withColdStartRetry(saturated, {
    sleep: options.sleep,
    ...options.coldStartRetry,
  })(req);
}

/**
 * Wrap a transport so every yielded chunk ALSO pings `onChunk` — the
 * byte-level liveness signal `useAgentInvoke`'s stall watchdog runs on
 * (guuey#192). Purely observational: chunks pass through unchanged, errors
 * and completion propagate untouched, and the wrapper adds no timers of its
 * own — the OBSERVER owns the clock, this module only reports activity. The
 * first ping doubles as the "first byte seen" arming signal, which is why
 * the watchdog never fires during a silent cold start: no bytes, no ping,
 * no armed timer (that phase belongs to {@link withColdStartRetry} and the
 * user's own abort).
 */
export function withActivityObserver(
  transport: InvokeTransport,
  onChunk: () => void,
): InvokeTransport {
  return async function* observed(req: InvokeRequest): AsyncGenerator<string> {
    for await (const chunk of transport(req)) {
      onChunk();
      yield chunk;
    }
  };
}
