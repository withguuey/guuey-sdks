/**
 * The one place a one-shot call's caller `signal` and `timeoutMs` are applied
 * (guuey#2492).
 *
 * A one-shot call is every request this SDK makes outside the streaming turn:
 * `deleteThread`, the card reader and action relay, the HITL answer relay,
 * `dismissLinkPrompt`, `mergeGuestThreads` and `fetchThreadHistory`. Each runs
 * its request inside {@link runOneShot}, which hands it a `fetch` bound to one
 * abort scope. That scope aborts on the caller's signal or when `timeoutMs`
 * runs out, and the call settles AT THAT MOMENT, whatever it was waiting on: the
 * credential resolver (which takes no signal), the request, its single 401
 * retry, or the body read. A request still in flight is aborted, and nothing
 * further is sent.
 *
 * Built only from `AbortController` and `setTimeout`, never `AbortSignal.any`
 * or `AbortSignal.timeout`, so it runs on React Native as well as the web.
 *
 * Each call maps the outcome onto its own existing contract: the HITL answer
 * relay and `mergeGuestThreads` report `CLIENT_ERROR_CODES.REQUEST_ABORTED` /
 * `REQUEST_TIMEOUT` in their result; `dismissLinkPrompt` and
 * `fetchThreadHistory` throw {@link RequestCancelledError}; `deleteThread`
 * settles as `"failed"` and the card reader and action relay as a miss, the
 * outcomes those contracts already give a request that did not complete.
 */
import { RequestCancelledError, type RequestCancelReason } from "./errors.js";

/** The cancel options every one-shot call accepts. */
export interface OneShotRequestOptions {
  /**
   * The caller's cancel authority. When it aborts, the call stops waiting at
   * once, wherever it is (resolving the credential, the request, the single
   * 401 retry, reading the answer), aborts the request in flight and sends
   * nothing more. An already-aborted signal sends nothing at all.
   */
  signal?: AbortSignal;
  /**
   * The longest, in milliseconds, the call waits on one door: from resolving
   * the credential through the single 401 retry to reading the answer. No
   * default: without it the call waits as long as the platform's own `fetch`
   * does. A non-finite value sets no limit; zero or less times out at once
   * and, like an already-aborted signal, sends nothing at all.
   */
  timeoutMs?: number;
}

/** What {@link runOneShot} settled with: the work's own value, or the cancel. */
export type OneShotOutcome<T> =
  | { kind: "settled"; value: T }
  | { kind: "cancelled"; reason: RequestCancelReason };

/** `fetch` bound to one call's abort scope. */
export type ScopedFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The largest delay `setTimeout` honours (a larger one fires at once). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Run one call's requests under the caller's `signal` and `timeoutMs`.
 *
 * `work` makes its requests through the `send` it is handed; a rejection of
 * `work` is passed through unless the scope was cancelled, in which case the
 * cancel is the outcome. `work` is also handed the scope's signal (undefined
 * when the caller set neither option), for a wait of its own between requests
 * (a wake wait) to end the moment the call is cancelled.
 *
 * With no `signal` and no finite `timeoutMs`, `work` runs on `fetchImpl` itself:
 * the request init is exactly what the call built, as before these options.
 * `alsoAbortOn` does not change that: it is a signal the call already carried
 * in its own init before these options existed (the history read's
 * `requestInit.signal`), and on this path `fetch` honours it natively, with
 * fetch's own rejection. Only once the caller opts in with `signal` or a
 * finite `timeoutMs` is `alsoAbortOn` linked into the call's scope, where it
 * cancels exactly as `signal` does.
 */
export function runOneShot<T>(
  options: OneShotRequestOptions,
  fetchImpl: typeof fetch,
  work: (send: ScopedFetch, scope: AbortSignal | undefined) => Promise<T>,
  alsoAbortOn?: AbortSignal | null,
): Promise<OneShotOutcome<T>> {
  const timeoutMs = options.timeoutMs;
  const limited = timeoutMs !== undefined && Number.isFinite(timeoutMs);

  if (!options.signal && !limited) {
    return work(fetchImpl, undefined).then((value) => ({ kind: "settled", value }));
  }
  const callerSignals: AbortSignal[] = [];
  if (options.signal) callerSignals.push(options.signal);
  if (alsoAbortOn) callerSignals.push(alsoAbortOn);
  if (callerSignals.some((s) => s.aborted)) {
    return Promise.resolve({ kind: "cancelled", reason: "aborted" });
  }
  // A budget already spent sends nothing, like an already-aborted signal: a
  // 0 ms timer would fire only after `work` had reached `fetch`.
  if (limited && timeoutMs <= 0) {
    return Promise.resolve({ kind: "cancelled", reason: "timeout" });
  }

  const scope = new AbortController();
  let reason: RequestCancelReason = "aborted";
  const onCallerAbort = (): void => scope.abort();
  for (const s of callerSignals) s.addEventListener("abort", onCallerAbort, { once: true });
  const timer = limited
    ? setTimeout(
        () => {
          reason = "timeout";
          scope.abort();
        },
        Math.min(timeoutMs, MAX_TIMER_MS),
      )
    : undefined;

  const send: ScopedFetch = (input, init) => {
    // Checked here as well as by `fetch`: a work step that resumes after the
    // cancel (a credential resolver answering late) must not send, and not
    // every `fetch` polyfill refuses an already-aborted signal.
    if (scope.signal.aborted) return Promise.reject(new RequestCancelledError(reason));
    return fetchImpl(input, { ...init, signal: scope.signal });
  };

  return new Promise<OneShotOutcome<T>>((resolve, reject) => {
    const release = (): void => {
      clearTimeout(timer);
      for (const s of callerSignals) s.removeEventListener("abort", onCallerAbort);
      scope.signal.removeEventListener("abort", onCancel);
    };
    // Registered before `work` starts, so it runs before any listener `fetch`
    // adds: the cancel settles the call before the aborted request's own
    // rejection reaches `work`'s failure handling.
    const onCancel = (): void => {
      release();
      resolve({ kind: "cancelled", reason });
    };
    scope.signal.addEventListener("abort", onCancel, { once: true });
    work(send, scope.signal).then(
      (value) => {
        release();
        resolve({ kind: "settled", value });
      },
      (err: unknown) => {
        release();
        if (scope.signal.aborted) resolve({ kind: "cancelled", reason });
        else reject(err);
      },
    );
  });
}
