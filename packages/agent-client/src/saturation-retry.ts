/**
 * The invoke-refusal retry wrappers, transport-agnostic: the single
 * `POD_SATURATED` auto-retry ({@link withSaturationRetry}) and the bounded
 * cold-start 503 retry ({@link withColdStartRetry}).
 *
 * Their own module — rather than living inside `./web-adapters.ts`, where the
 * first was born — because the behaviour is a property of the platform's
 * refusal vocabulary, not of `fetch`. Every host that speaks `/agent/invoke`
 * wants them, including the ones that cannot import the web adapter bundle:
 * Portal's React-Native transport wraps its own `fetch` call with these the
 * same way `fetchStreamTransport` wraps its browser streaming reader, so the
 * two wear byte-identical retry semantics instead of two hand-written copies
 * that drift.
 *
 * The two wrappers are DELIBERATELY distinct code paths: saturation retry is
 * driven by the pod's structured refusal envelope (`code: POD_SATURATED`),
 * while the cold-start retry matches only an envelope-LESS 503 — the raw
 * infra answer (ingress with no ready pod) during the post-redeploy window,
 * which by definition carries no wire code. They share the backoff machinery,
 * never the predicate.
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
  /**
   * Total send attempts on a saturated pod (guuey#406). Default 1 retry
   * (2 attempts) — the historical behavior; capped at 5. A capacity-1 pod
   * (demo fixtures, xs plans) refuses the SECOND simultaneous visitor, so
   * end-user surfaces budget higher and pair it with `onSaturationWait` so
   * the wait is a visible busy state, never a silent hang or a generic
   * error boundary (the 2026-08-24 standalone incident).
   */
  attempts?: number;
  /**
   * Fired before each saturation wait — the surface's hook for an honest
   * "the agent is helping someone else" state. Never fired for other error
   * classes; the turn stays `connecting` throughout (the hook's state
   * machine deliberately has no `retrying` status).
   */
  onSaturationWait?: (info: { attempt: number; totalAttempts: number; waitMs: number }) => void;
}

/** Hard ceiling on {@link SaturationRetryOptions.attempts} retries. */
const MAX_SATURATION_RETRIES = 5;

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
  const retries = Math.min(Math.max(options.attempts ?? 1, 1), MAX_SATURATION_RETRIES);
  return async function* retrying(req: InvokeRequest): AsyncGenerator<string> {
    for (let attempt = 1; ; attempt += 1) {
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
        if (!saturated || yielded || attempt > retries) throw err;
        const waitMs = saturationDelayMs(err.retryAfterSeconds);
        options.onSaturationWait?.({ attempt, totalAttempts: retries + 1, waitMs });
        await (options.sleep ?? delay)(waitMs, req.signal);
        // Aborted mid-wait: the user is done with this turn. Surface the
        // refusal that caused the wait rather than spending a request that
        // `fetch` would reject on the signal anyway.
        if (req.signal.aborted) throw err;
      }
    }
  };
}

/** Options for {@link withColdStartRetry}. */
export interface ColdStartRetryOptions {
  /**
   * Retries after the initial attempt (`0` disables the wrapper's behaviour
   * entirely). Default 3 — a small, bounded budget: the point is parity with
   * guuey's first-party embeds during the ordinary post-redeploy window, not
   * riding out an outage. Raise it for an unattended harness that would
   * rather wait than fail.
   */
  attempts?: number;
  /**
   * First wait in ms; each subsequent wait doubles, capped at
   * {@link maxDelayMs}. Default 2000 → 2s / 4s / 8s for the default budget.
   */
  baseDelayMs?: number;
  /** Ceiling on any single wait (hinted or computed), in ms. Default 10000. */
  maxDelayMs?: number;
  /** The wait itself — injectable so tests drive the retry without timers. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const COLD_START_DEFAULT_ATTEMPTS = 3;
const COLD_START_BASE_DELAY_MS = 2_000;
const COLD_START_MAX_DELAY_MS = 10_000;

/**
 * Is this failure the cold-start refusal shape? An envelope-less 503: the
 * status came from infra (no ready pod behind the route — the ~30–60s window
 * after a redeploy), so there is no wire `code`. A 503 that DOES carry a code
 * is the pod itself refusing (`POD_SATURATED`, `DRAINING`) and belongs to
 * {@link withSaturationRetry}'s policy — including its deliberate decision NOT
 * to retry `DRAINING` — never to this wrapper.
 */
function isColdStartRefusal(err: unknown): err is AgentResponseError {
  return err instanceof AgentResponseError && err.status === 503 && err.code === undefined;
}

/**
 * Wrap an invoke transport with a bounded retry on cold-start 503s
 * (guuey#186 Gap 3 — parity with first-party embeds, which already carry
 * this behaviour; SDK consumers were eating the raw 503 window instead).
 *
 * Matches ONLY {@link isColdStartRefusal} — an envelope-less 503 — and
 * retries up to `attempts` times with doubling, capped backoff (honouring a
 * `Retry-After` hint when the response carried one). Exhaustion propagates
 * the final refusal untouched.
 *
 * Nothing is retried once a chunk has been yielded: a stream that dies
 * MID-turn is never silently re-POSTed — the turn may have had side effects
 * and the consumer already saw partial output. Same `yielded` guard as
 * {@link withSaturationRetry}, same reasoning. An abort during a wait
 * surfaces the refusal that caused the wait.
 *
 * Like the saturation wrapper, the retry is invisible to `useAgentInvoke`
 * (the turn stays in `connecting`), and the wrapped transport is re-invoked
 * from scratch so per-attempt identity resolution re-runs.
 */
export function withColdStartRetry(
  transport: InvokeTransport,
  options: ColdStartRetryOptions = {},
): InvokeTransport {
  const attempts = options.attempts ?? COLD_START_DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? COLD_START_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? COLD_START_MAX_DELAY_MS;
  const sleep = options.sleep ?? delay;
  return async function* retrying(req: InvokeRequest): AsyncGenerator<string> {
    let yielded = false;
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const chunk of transport(req)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (!isColdStartRefusal(err) || yielded || attempt >= attempts) throw err;
        const hintedMs =
          err.retryAfterSeconds !== undefined ? err.retryAfterSeconds * 1000 : undefined;
        const waitMs = Math.min(hintedMs ?? baseDelayMs * 2 ** attempt, maxDelayMs);
        await sleep(waitMs, req.signal);
        // Aborted mid-wait: surface the refusal that caused the wait rather
        // than spending a request that `fetch` would reject on the signal.
        if (req.signal.aborted) throw err;
      }
    }
  };
}
