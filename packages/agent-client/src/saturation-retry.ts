/**
 * The single `POD_SATURATED` auto-retry, as a transport-agnostic wrapper.
 *
 * Its own module — rather than living inside `./web-adapters.ts`, where it was
 * born — because the behaviour is a property of the POD's refusal vocabulary,
 * not of `fetch`. Every host that speaks `/agent/invoke` wants it, including
 * the ones that cannot import the web adapter bundle: Portal's React-Native
 * transport wraps its own `fetch` call with {@link withSaturationRetry} the
 * same way `fetchStreamTransport` wraps its browser streaming reader, so the
 * two wear byte-identical retry semantics instead of two hand-written copies
 * that drift.
 *
 * This module imports only `./types.js`, `./errors.js` and `./error-codes.js`
 * — all pure — so pulling it in costs a React-Native build nothing.
 */
import { AGENT_ERROR_CODES } from "./error-codes.js";
import { AgentResponseError } from "./errors.js";
import type { InvokeRequest, InvokeTransport } from "./types.js";

/**
 * Fallback wait before the saturation retry when the pod sent no usable
 * `Retry-After` — the same 15s the pod's governor hints today
 * (`GOVERNOR_RETRY_AFTER_SECONDS`), so a stripped header behaves like the
 * normal case rather than hammering.
 */
const SATURATION_FALLBACK_DELAY_SECONDS = 15;

/**
 * Ceiling on the honoured hint. A pod that (mis)configures a multi-minute
 * `Retry-After` must not park a chat UI in `connecting` for that long — past
 * this the user is better served by the visible failure they can act on.
 */
const SATURATION_MAX_DELAY_SECONDS = 30;

/**
 * Read `Retry-After` as WHOLE SECONDS, or `undefined`.
 *
 * HTTP also allows an absolute HTTP-date, which is deliberately NOT parsed:
 * the pod only ever emits a delta-seconds integer, and silently mis-reading a
 * date as `NaN` seconds is worse than falling back to the fixed delay.
 *
 * Exported because every transport that builds an {@link AgentResponseError}
 * has to fill `retryAfterSeconds` the same way for {@link withSaturationRetry}
 * to honour the same hint — a second hand-rolled regex in a host adapter is
 * exactly the drift this module exists to prevent.
 */
export function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

/** How long to wait before the single saturation retry, in milliseconds. */
function saturationDelayMs(retryAfterSeconds: number | undefined): number {
  const hinted = retryAfterSeconds ?? SATURATION_FALLBACK_DELAY_SECONDS;
  return Math.min(hinted, SATURATION_MAX_DELAY_SECONDS) * 1000;
}

/**
 * Wait `ms`, or resolve early if the turn is aborted — a user who hits stop
 * must not sit through the remainder of a 15s backoff before the UI settles.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Options for {@link withSaturationRetry}. */
export interface SaturationRetryOptions {
  /**
   * The saturation-retry wait. Injectable so tests drive the retry without a
   * real 15s timer; production uses an abort-aware `setTimeout`.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Wrap an invoke transport with ONE automatic retry on a saturated pod.
 *
 * ## What retries, and what deliberately does not
 *
 * `POD_SATURATED` (503) means the pod is at its concurrent-turn cap right now
 * — a transient queue state that clears as in-flight turns finish, so a single
 * delayed re-send usually just works. The wait is the pod's own `Retry-After`
 * hint (via {@link AgentResponseError.retryAfterSeconds}), defaulting to 15s
 * when it sent none and capped at 30s.
 *
 * `DRAINING` (also 503 + `Retry-After`) is NOT retried in v1. The refusing pod
 * is shutting down: its readiness probe is already failing and the endpoint
 * pull is in flight, so the useful retry is the one that reaches a DIFFERENT
 * pod — and a wrapped transport re-sends to the same URL. Retrying here would
 * spend the user's 15s to arrive back at the same draining pod (or at a fresh
 * one by luck), which is not a guarantee worth building on. When the retry can
 * be made routing-aware, this is the code to revisit.
 *
 * Exactly ONE retry: a second saturation propagates as
 * {@link AgentResponseError}, so a genuinely overloaded agent surfaces instead
 * of looping. Nothing is retried once a chunk has been yielded — replaying
 * mid-stream would duplicate a partial assistant turn (the same `yielded`
 * guard the widget's `withIdentifiedToken` 401-retry uses). An abort during
 * the wait skips the retry and surfaces the original refusal.
 *
 * The retry is INVISIBLE to `useAgentInvoke`: no frames were yielded, so the
 * turn simply stays in `connecting` for the duration of the wait. There is no
 * `retrying` status by design — the hook's state machine describes the pod's
 * turn lifecycle, not the transport's plumbing.
 *
 * The wrapped transport is re-invoked from scratch for the retry, so a host
 * that resolves identity inside its own generator (Portal's RN transport reads
 * the bearer bridge per attempt) re-reads it on the second try rather than
 * replaying a token that may have expired during the wait.
 */
export function withSaturationRetry(
  transport: InvokeTransport,
  options: SaturationRetryOptions = {},
): InvokeTransport {
  return async function* retrying(req: InvokeRequest): AsyncGenerator<string> {
    let yielded = false;
    try {
      for await (const chunk of transport(req)) {
        yielded = true;
        yield chunk;
      }
      return;
    } catch (err) {
      const saturated =
        err instanceof AgentResponseError && err.code === AGENT_ERROR_CODES.POD_SATURATED;
      if (!saturated || yielded) throw err;
      await (options.sleep ?? delay)(saturationDelayMs(err.retryAfterSeconds), req.signal);
      // Aborted mid-wait: the user is done with this turn. Surface the refusal
      // that caused the wait rather than spending a request that `fetch` would
      // reject on the signal anyway.
      if (req.signal.aborted) throw err;
    }
    yield* transport(req);
  };
}
