/**
 * `useSaturationCountdown` (guuey#2608) — the countdown under the busy status
 * line at the agent's concurrent-turn ceiling.
 *
 * The transport's saturation retry reports each wait as it starts
 * (`onSaturationWait`: the refused try, the budget, and `waitMs`, the pod's
 * own `Retry-After` hint or the SDK's fallback). The plan draws the busy line
 * from a {@link SaturationWait}; this hook turns the reported `waitMs` into
 * the line's `secondsLeft`, ticked here the same way the renderer ticks
 * `statusElapsedMs`, so the plan stays pure and a visitor reads "Retrying in
 * 12s (1/4)…" instead of a line that never moves. `<GuueyChat>` uses it for
 * its default adapters; a host that builds its own adapters wires `report` as
 * their `onSaturationWait` and `wait` as the plan's `saturationWait`.
 *
 * N−1: an older pod sends the same 503 + `Retry-After`, or no header at all;
 * either way the SDK reports a `waitMs`, so the countdown never depends on
 * anything the pod did not already send.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SaturationRetryOptions } from "@guuey/agent-client";
import type { SaturationWait } from "../types.js";

/** One wait exactly as `@guuey/agent-client`'s `onSaturationWait` reports it. */
export type SaturationWaitReport = Parameters<NonNullable<SaturationRetryOptions["onSaturationWait"]>>[0];

/** How often the countdown re-reads the clock; a whole-second change re-renders. */
export const COUNTDOWN_TICK_MS = 250;

/** Whole seconds from `now` until `retryAt`, never below 0. */
export function secondsUntil(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

export interface SaturationCountdown {
  /** The wait the plan reads, with its live `secondsLeft`; null when none is under way. */
  wait: SaturationWait | null;
  /** The transport's `onSaturationWait`. Stable for the hook's life. */
  report: (info: SaturationWaitReport) => void;
  /** Ends the wait (the turn moved on). Stable for the hook's life. */
  clear: () => void;
}

export function useSaturationCountdown(now: () => number = Date.now): SaturationCountdown {
  const [wait, setWait] = useState<SaturationWait | null>(null);
  const retryAtRef = useRef(0);
  const nowRef = useRef(now);
  nowRef.current = now;

  const report = useCallback((info: SaturationWaitReport): void => {
    const at = nowRef.current();
    retryAtRef.current = at + info.waitMs;
    setWait({
      attempt: info.attempt,
      totalAttempts: info.totalAttempts,
      secondsLeft: secondsUntil(retryAtRef.current, at),
    });
  }, []);
  const clear = useCallback((): void => setWait(null), []);

  const waiting = wait !== null;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      setWait((prev) => {
        if (prev === null) return prev;
        const secondsLeft = secondsUntil(retryAtRef.current, nowRef.current());
        return prev.secondsLeft === secondsLeft ? prev : { ...prev, secondsLeft };
      });
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  return { wait, report, clear };
}
