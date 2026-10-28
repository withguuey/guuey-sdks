/**
 * The invoke-refusal retry wrappers, transport-agnostic: the capacity
 * auto-retry for `POD_SATURATED` and a pre-stream
 * `WORKER_POD_RESOURCE_EXHAUSTED` ({@link withSaturationRetry}), the
 * bounded cold-start 503 retry and the wake budget for a sleeping app
 * ({@link withColdStartRetry}), and that same wake budget for the other wake
 * doors ({@link sendUnderWakeBudget}).
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
 * driven by the pod's structured refusal envelope (a capacity code),
 * while the cold-start retry matches only an envelope-LESS 503 — the raw
 * infra answer (ingress with no ready pod) during the post-redeploy window,
 * which by definition carries no wire code. They share the backoff machinery,
 * never the predicate.
 *
 * This module imports only `./types.js`, `./errors.js` and `./error-codes.js`
 * — all pure — so pulling it in costs a React-Native build nothing.
 */
import { AGENT_ERROR_CODES } from "./error-codes.js";
import {
  AgentResponseError,
  agentResponseErrorFrom,
  hasWakingMarker,
  isWakingRefusal,
} from "./errors.js";
import type { InvokeRequest, InvokeTransport } from "./types.js";

/**
 * Fallback wait before a capacity retry when the pod sent no usable
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
 * The refusal codes {@link withSaturationRetry} re-sends: the transient
 * "no room for this turn right now" answers. `POD_SATURATED` is the pod's
 * concurrent-turn cap; `WORKER_POD_RESOURCE_EXHAUSTED` before the stream is
 * the app's worker pods having no free slot for the turn (guuey#2605). Both
 * are refused before the turn is admitted, so nothing ran and a re-send is a
 * fresh admission, never a replay. One wait rule, one budget.
 */
const CAPACITY_RETRY_CODES: ReadonlySet<string> = new Set([
  AGENT_ERROR_CODES.POD_SATURATED,
  AGENT_ERROR_CODES.WORKER_POD_RESOURCE_EXHAUSTED,
]);

/** How long to wait before each capacity retry, in milliseconds. */
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
   * Retries on a capacity refusal (guuey#406): the turn is sent at most
   * `attempts + 1` times. Default 1 retry (2 sends), the historical
   * behavior; floored at 1 and capped at 5 retries. A capacity-1 pod
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
 * Wrap an invoke transport with a bounded automatic retry on a capacity
 * refusal: up to `attempts` retries (default 1, capped at 5).
 *
 * ## What retries, and what deliberately does not
 *
 * `POD_SATURATED` (503) means the pod is at its concurrent-turn cap right now
 * — a transient queue state that clears as in-flight turns finish, so a delayed
 * re-send usually just works. The wait is the pod's own `Retry-After`
 * hint (via {@link AgentResponseError.retryAfterSeconds}), defaulting to 15s
 * when it sent none and capped at 30s.
 *
 * `WORKER_POD_RESOURCE_EXHAUSTED` refused BEFORE the stream (503 +
 * `Retry-After`, the same shape) means the app's worker pods have no free
 * slot for the turn right now: the reservation was refused, nothing ran, and
 * a slot frees as in-flight turns finish (the refusal itself never scales
 * the worker set out). It is the same
 * transient capacity answer, so it takes the same wait rule and SHARES the
 * same attempts budget (a mix of the two codes never retries more than
 * `attempts` times). The same code arriving mid-turn (the in-band
 * `event: error` after frames were yielded) is never re-sent: the
 * nothing-yielded guard below holds for every code (guuey#2605).
 *
 * `DRAINING` (also 503 + `Retry-After`) is NOT retried in v1. The refusing pod
 * is shutting down: its readiness probe is already failing and the endpoint
 * pull is in flight, so the useful retry is the one that reaches a DIFFERENT
 * pod — and a wrapped transport re-sends to the same URL. Retrying here would
 * spend the user's 15s to arrive back at the same draining pod (or at a fresh
 * one by luck), which is not a guarantee worth building on. When the retry can
 * be made routing-aware, this is the code to revisit.
 *
 * At most `attempts` retries, one budget across both capacity codes: the
 * refusal after the last retry propagates as {@link AgentResponseError}, so a
 * genuinely overloaded agent surfaces instead of looping. Nothing is
 * retried once a chunk has been yielded — replaying mid-stream would
 * duplicate a partial assistant turn (the same `yielded` guard the widget's
 * `withIdentifiedToken` 401-retry uses). An abort during the wait skips the
 * retry and surfaces the original refusal.
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
          err instanceof AgentResponseError && err.code !== undefined && CAPACITY_RETRY_CODES.has(err.code);
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

/** What a wake budget reports before each wait. */
export interface WakeWaitInfo {
  /**
   * Time spent of the budget, in ms: since the turn (or the door call)
   * started, so a cold-start wait before the waking answer counts too.
   */
  elapsedMs: number;
  /** The whole budget, in ms: {@link WAKE_BUDGET_MS}, or a door's own. */
  budgetMs: number;
  /** This wait's number within the budget, from 1. */
  attempt: number;
}

/** The wake budget's options, shared by the invoke wrapper and the other wake doors. */
export interface WakeBudgetOptions {
  /**
   * Fired before each wait inside an open wake budget — the surface's hook
   * for an honest "waking your agent" state, beside `onSaturationWait`.
   * Never fired for any other refusal; the turn stays `connecting`
   * throughout, as it does for the other waits.
   */
  onWakeWait?: (info: WakeWaitInfo) => void;
  /** The wait itself — injectable so tests drive the retry without timers. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Options for {@link withColdStartRetry}. */
export interface ColdStartRetryOptions extends WakeBudgetOptions {
  /**
   * Cold-start retries after the initial attempt (`0` turns the cold-start
   * retry off; the wake budget is its own policy and stays on). Default 3 —
   * a small, bounded budget: the point is parity with guuey's first-party
   * embeds during the ordinary post-redeploy window, not riding out an
   * outage. Raise it for an unattended harness that would rather wait than
   * fail.
   */
  attempts?: number;
  /**
   * First wait in ms; each subsequent wait doubles, capped at
   * {@link maxDelayMs}. Default 2000 → 2s / 4s / 8s for the default budget.
   */
  baseDelayMs?: number;
  /** Ceiling on any single cold-start wait (hinted or computed), in ms. Default 10000. */
  maxDelayMs?: number;
}

const COLD_START_DEFAULT_ATTEMPTS = 3;
const COLD_START_BASE_DELAY_MS = 2_000;
const COLD_START_MAX_DELAY_MS = 10_000;

/**
 * How long a turn may spend waiting for a sleeping app to wake: 90 s,
 * measured from the turn's start, so the cold-start waits that came before
 * the waking answer are spent from it too. An ESTIMATE, sized to a wake that
 * has to launch a node first; it is replaced by the measured p95 wake time ×
 * 1.5 once that is on record.
 *
 * It must leave room under the stall watchdog's default
 * `preFirstByteWindowMs` (120 s) for the requests themselves and for one
 * capacity wait at the pod's usual hint (15 s) after the last re-ask, or a
 * wake would read as a stalled turn — a test composes that worst case
 * through the stream transport. A capacity wait longer than that (a pod
 * hinting more, or a surface that raised its saturation attempts) is the
 * saturation budget's own and can run past the window, as it could before
 * the wake budget existed; the watchdog's first expiry is then a history
 * probe, not a failure.
 */
export const WAKE_BUDGET_MS = 90_000;

/** Floor on the honoured wake `Retry-After`: never re-ask faster than this. */
const WAKE_MIN_DELAY_SECONDS = 2;
/** Ceiling on it: a long hint must not hide the moment the app is awake. */
const WAKE_MAX_DELAY_SECONDS = 15;
/** The wait when an answer inside the budget sent no usable hint. */
const WAKE_FALLBACK_DELAY_SECONDS = 5;

/** How long to wait before re-asking a waking app, in milliseconds. */
function wakeDelayMs(retryAfterSeconds: number | undefined): number {
  const hinted = retryAfterSeconds ?? WAKE_FALLBACK_DELAY_SECONDS;
  return Math.min(Math.max(hinted, WAKE_MIN_DELAY_SECONDS), WAKE_MAX_DELAY_SECONDS) * 1000;
}

/**
 * Is this failure the cold-start refusal shape? An envelope-less 503: the
 * status came from infra (no ready pod behind the route — the ~30–60s window
 * after a redeploy), so there is no wire `code`. A 503 that DOES carry a code
 * is the pod itself refusing (`POD_SATURATED`, `WORKER_POD_RESOURCE_EXHAUSTED`,
 * `DRAINING`) and belongs to
 * {@link withSaturationRetry}'s policy — including its deliberate decision NOT
 * to retry `DRAINING` — never to this wrapper. Inside an open wake budget the
 * same shape means "keep waiting" (see {@link wakeBudget}).
 */
function isColdStartRefusal(err: unknown): err is AgentResponseError {
  return err instanceof AgentResponseError && err.status === 503 && err.code === undefined;
}

/** What the wake budget makes of one refusal. */
type WakeStep =
  /** No budget is open and this is not a waking answer: not this policy's. */
  | { kind: "not-waking" }
  /** A budget is open and this answer ends the wait: it surfaces as is. */
  | { kind: "ended" }
  /** The budget is spent: surface `refusal`, the latest waking answer. */
  | { kind: "exhausted"; refusal: AgentResponseError }
  /** Wait `waitMs`, then ask again. */
  | { kind: "wait"; waitMs: number; info: WakeWaitInfo };

/** One turn's (or one door call's) wake budget. */
interface WakeBudget {
  /** Whether a waking answer has opened the budget. */
  isOpen(): boolean;
  /** What to do with this refusal. */
  step(err: unknown): WakeStep;
}

/**
 * One wake budget: the policy, kept in one place for the invoke and the other
 * wake doors. Its clock starts when it is made — the turn's (or the door
 * call's) start.
 *
 * - It opens ONLY on a waking answer ({@link isWakingRefusal}: a 503 that
 *   carried `X-Guuey-Waking: 1`), never on the status alone.
 * - Inside it, an envelope-less 503 without the marker means keep waiting:
 *   the marker can briefly drop out while the app comes up. A coded answer,
 *   any other status or failure ends the wait; so does success, by never
 *   reaching here.
 * - Each wait is the answer's `Retry-After`, clamped to [2 s, 15 s] (5 s when
 *   it sent none), and never past what is left of `budgetMs`. When less than
 *   the 2 s floor is left, the budget is spent: the latest waking answer
 *   surfaces, so the caller reads it as a wake that ran out — and no re-ask
 *   ever follows the previous answer by less than the floor.
 */
function wakeBudget(budgetMs: number): WakeBudget {
  const startedAt = Date.now();
  let lastWaking: AgentResponseError | undefined;
  let waits = 0;
  return {
    isOpen: () => lastWaking !== undefined,
    step: (err) => {
      if (!isColdStartRefusal(err)) {
        return lastWaking === undefined ? { kind: "not-waking" } : { kind: "ended" };
      }
      if (isWakingRefusal(err)) lastWaking = err;
      if (lastWaking === undefined) return { kind: "not-waking" };
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = budgetMs - elapsedMs;
      if (remainingMs < WAKE_MIN_DELAY_SECONDS * 1000) {
        return { kind: "exhausted", refusal: lastWaking };
      }
      waits += 1;
      return {
        kind: "wait",
        waitMs: Math.min(wakeDelayMs(err.retryAfterSeconds), remainingMs),
        info: { elapsedMs, budgetMs, attempt: waits },
      };
    },
  };
}

/**
 * Wrap an invoke transport with a bounded retry on cold-start 503s
 * (guuey#186 Gap 3 — parity with first-party embeds, which already carry
 * this behaviour; SDK consumers were eating the raw 503 window instead), and
 * the wake budget for a sleeping app.
 *
 * Two budgets, one wrapper, one clock:
 *
 * - **Cold start.** An envelope-less 503 ({@link isColdStartRefusal}) without
 *   the waking marker is retried up to `attempts` times with doubling,
 *   capped backoff (honouring a `Retry-After` hint when the response carried
 *   one): about 14–30 s by default. Exhaustion propagates the final refusal
 *   untouched.
 * - **Wake.** A waking 503 ({@link isWakingRefusal}) opens the wake budget,
 *   whatever the cold-start attempts say: the wrapper re-asks on each
 *   `Retry-After` (2–15 s), keeps waiting through an envelope-less 503
 *   without the marker, and stops on a coded answer, any other status or
 *   failure, success, or the end of the budget (which surfaces the latest
 *   waking refusal). `onWakeWait` fires before each wait.
 *
 * The budgets do not add up: {@link WAKE_BUDGET_MS} is counted from the
 * turn's start, so cold-start waits spent before the marker appeared come
 * out of it. With the default cold-start budget, every wait this wrapper
 * makes before the first byte fits inside {@link WAKE_BUDGET_MS}; a raised
 * `attempts` can spend past it on cold starts alone, and a wake that opens
 * after that surfaces at once.
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
    const wake = wakeBudget(WAKE_BUDGET_MS);
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const chunk of transport(req)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (yielded) throw err;
        const step = wake.step(err);
        if (step.kind === "ended") throw err;
        if (step.kind === "exhausted") throw step.refusal;
        if (step.kind === "wait") {
          options.onWakeWait?.(step.info);
          await sleep(step.waitMs, req.signal);
          // Aborted mid-wait: surface the refusal that caused the wait.
          if (req.signal.aborted) throw err;
          continue;
        }
        // No wake budget open: the cold-start path.
        if (!isColdStartRefusal(err) || attempt >= attempts) throw err;
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

/** Options for {@link sendUnderWakeBudget}. */
export interface SendUnderWakeBudgetOptions extends WakeBudgetOptions {
  /** Ends a wait early: the answer that caused it comes back. */
  signal?: AbortSignal;
  /**
   * The budget in ms, counted from the call's start. Default
   * {@link WAKE_BUDGET_MS}; a door whose own caller gives up sooner passes
   * less (a card action answers its view before the view's request times
   * out).
   */
  budgetMs?: number;
}

/**
 * Read a refusal's body once and hand out fresh, unread copies of it. Never
 * `clone()`: some hosts' `fetch` cannot clone a response (Expo's throws), and
 * a clone left beside an unread original holds its connection until GC.
 */
async function readOnce(res: Response): Promise<() => Response> {
  const text = await res.text();
  return () =>
    new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * Send one request to a wake door under the wake budget — the same policy
 * {@link withColdStartRetry} applies to the invoke, for the doors that answer
 * a plain `Response` (`POST /agent/ui-action`, `POST /agent/hitl-answer`).
 *
 * `send` is called again after each wait, so it must build a fresh request;
 * the door's credential is whatever `send` closes over (resolved once per
 * door call). While no budget is open, an answer without the waking marker
 * comes back untouched on the first send — its body unread and never
 * cloned — so a door's handling of every other answer is byte-identical to
 * before. Once the marker is seen, each 503 is read to tell keep-waiting
 * from a coded answer; the one that ends the wait comes back as an unread
 * copy, for the door to read exactly as it would have. At the end of the
 * budget the latest WAKING answer comes back (as the invoke surfaces the
 * latest waking refusal); on an abort during a wait, the answer that caused
 * it. A `send` that throws ends the wait by throwing.
 */
export async function sendUnderWakeBudget(
  send: () => Promise<Response>,
  options: SendUnderWakeBudgetOptions = {},
): Promise<Response> {
  const wake = wakeBudget(options.budgetMs ?? WAKE_BUDGET_MS);
  const signal = options.signal ?? new AbortController().signal;
  const sleep = options.sleep ?? delay;
  let lastWaking: (() => Response) | undefined;
  for (;;) {
    const res = await send();
    // Only a 503 can open or extend a wait, and while no budget is open only
    // the marker opens one: anything else is the door's as is, unread.
    if (res.status !== 503) return res;
    if (!wake.isOpen() && !hasWakingMarker(res)) return res;
    const answer = await readOnce(res);
    const refusal = await agentResponseErrorFrom(answer());
    if (isWakingRefusal(refusal)) lastWaking = answer;
    const step = wake.step(refusal);
    if (step.kind === "exhausted") return (lastWaking ?? answer)();
    if (step.kind !== "wait") return answer();
    options.onWakeWait?.(step.info);
    await sleep(step.waitMs, signal);
    if (signal.aborted) return answer();
  }
}
