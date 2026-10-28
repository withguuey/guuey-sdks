/**
 * Error types the transports throw and the hook branches on, and the ONE
 * builder that turns a refused `Response` into that error.
 *
 * Its own module (rather than living in `./web-adapters.ts`) so `useAgentInvoke`
 * — which must stay platform-agnostic — can `instanceof`-narrow a caught error
 * without pulling the web adapter bundle (`fetch`, the history reader,
 * `@guuey/mcp-apps-host`) into a React-Native build. It imports only
 * `./error-codes.js`, which imports nothing.
 */
import { CLIENT_ERROR_CODES } from "./error-codes.js";

/**
 * The header a sleeping app's address sets on the `503` it answers while the
 * app wakes, with the value `1` (plus a `Retry-After`). A client opens a wake
 * budget only on this header, never on the status alone: the bare status is
 * also what an empty ingress (the cold-start window) and a per-IP limit
 * answer. The server exposes it across origins, so a browser can read it.
 */
export const WAKING_HEADER = "X-Guuey-Waking";

/**
 * Thrown when the pod returns a non-2xx status on `/agent/invoke` (before any
 * SSE stream opens). Carries the pod's structured `{ code, message }` when
 * present — e.g. a `QUOTA_EXCEEDED` 429 whose message ("…reached its plan
 * generation limit…") the chat UI should surface — falling back to the bare
 * status for non-JSON failures. See `AGENT_ERROR_CODES` for the vocabulary.
 * Build one from a `Response` with {@link agentResponseErrorFrom}.
 */
export class AgentResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /**
     * The response's `Retry-After` hint in whole seconds, when it sent a
     * parseable one. The pod attaches it to its two 503 refusals
     * (`POD_SATURATED`, `DRAINING`) and exposes the header across origins via
     * `Access-Control-Expose-Headers`, so a browser client can actually read
     * it. `undefined` when the header was absent, malformed, or in the
     * HTTP-date form the pod never emits.
     */
    readonly retryAfterSeconds?: number,
    /**
     * Whether the refusal was a 503 carrying {@link WAKING_HEADER}`: 1`: the
     * app was asleep and is waking. Optional, so every refusal built without
     * it (and any value typed as this class without it) reads as not waking:
     * only `true` counts. {@link agentResponseErrorFrom} always sets it. See
     * {@link isWakingRefusal}.
     */
    readonly waking?: boolean,
  ) {
    super(message);
    this.name = "AgentResponseError";
  }
}

/**
 * Is this the waking refusal? A 503 that carried the waking marker and no
 * wire `code`. A coded answer is the pod itself refusing, so it never counts
 * as a wake even if the marker rode along; a plain 503 without the marker is
 * the cold-start shape, never a wake.
 */
export function isWakingRefusal(err: unknown): err is AgentResponseError {
  return (
    err instanceof AgentResponseError &&
    err.waking === true &&
    err.status === 503 &&
    err.code === undefined
  );
}

/**
 * The sentence a wake that ran out of budget reads as (guuey#2453): the
 * message of every {@link WakeTimedOutError}, and the chat kit's default line
 * for `WAKE_TIMED_OUT`. Its one home, so the SDK and the kit never word the
 * same event two ways.
 */
export const WAKE_TIMED_OUT_MESSAGE = "This agent didn't wake up in time. Please try again.";

/**
 * Thrown when the wake budget ends (guuey#2453): the app answered waking for
 * the whole budget, and `withColdStartRetry` gave up. Its `code` is
 * `CLIENT_ERROR_CODES.WAKE_TIMED_OUT` and its message is
 * {@link WAKE_TIMED_OUT_MESSAGE}; `status`, `retryAfterSeconds` and `waking`
 * are the latest waking refusal's, which it keeps as `refusal`.
 *
 * Only the budget ending throws it. A single waking refusal that surfaces
 * without a budget (`coldStartRetry: false`) stays the plain code-less
 * {@link AgentResponseError}, since nothing waited for it. A client code, so
 * it never appears on the wire, and as a coded answer it is never read as
 * waking ({@link isWakingRefusal}).
 */
export class WakeTimedOutError extends AgentResponseError {
  constructor(
    /** The latest waking refusal the budget saw, as the transport built it. */
    readonly refusal: AgentResponseError,
  ) {
    super(
      WAKE_TIMED_OUT_MESSAGE,
      refusal.status,
      CLIENT_ERROR_CODES.WAKE_TIMED_OUT,
      refusal.retryAfterSeconds,
      refusal.waking,
    );
    this.name = "WakeTimedOutError";
  }
}

/**
 * Read `Retry-After` as WHOLE SECONDS, or `undefined`.
 *
 * HTTP also allows an absolute HTTP-date, which is deliberately NOT parsed:
 * the pod only ever emits a delta-seconds integer, and silently mis-reading a
 * date as `NaN` seconds is worse than falling back to the fixed delay.
 *
 * Exported because a reader of a door's own refusal (the guest merge) fills
 * its hint the same way {@link agentResponseErrorFrom} does — a second
 * hand-rolled regex in a host adapter is exactly the drift this prevents.
 */
export function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

/**
 * Does this answer carry the waking marker? A 503 whose {@link WAKING_HEADER}
 * is `1` (trimmed). Reads the headers only, never the body, so a caller can
 * decide whether a refusal needs reading at all.
 */
export function hasWakingMarker(resp: Response): boolean {
  return resp.status === 503 && resp.headers.get(WAKING_HEADER)?.trim() === "1";
}

/**
 * Turn a refused `Response` into an {@link AgentResponseError}: the status,
 * the pod's `{ code, message }` when the body is that JSON envelope (else the
 * bare `agent responded <status>`), the `Retry-After` hint, and `waking` —
 * true only for a 503 whose {@link WAKING_HEADER} is `1`.
 *
 * The one place an invoke refusal becomes this error, so every transport
 * (the web stream, a host's own `fetch`) reads the same fields the same way
 * and the retry wrappers see the same shape. It consumes the body; a caller
 * that still needs it passes a `clone()`.
 */
export async function agentResponseErrorFrom(resp: Response): Promise<AgentResponseError> {
  // A body that is not JSON (an ingress page, an empty wake answer) is the
  // bare-status case, not a failure of this read.
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
  return new AgentResponseError(
    message,
    resp.status,
    code,
    parseRetryAfterSeconds(resp.headers.get("Retry-After")),
    hasWakingMarker(resp),
  );
}
