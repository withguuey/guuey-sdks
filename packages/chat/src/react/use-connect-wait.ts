/**
 * `useConnectWait` (guuey#2453) — the ONE wait a connecting turn is in, for
 * the status line: the agent is busy, or the app is waking.
 *
 * A turn stays `connecting` through every wait the SDK makes before the first
 * byte, so the screen learns about a wait only from the transport's observers,
 * and this hook returns both, to hand to the adapters:
 *  - `onSaturationWait` (guuey#2604): every concurrent-turn slot is taken and
 *    the SDK waits to resend. The report carries the refused try, the budget,
 *    and `waitMs` (the pod's own `Retry-After` hint or the SDK's fallback);
 *    guuey#2608: the hook turns `waitMs` into the busy line's `secondsLeft`,
 *    ticked here the same way the renderer ticks `statusElapsedMs`, so the
 *    plan stays pure and a visitor reads "Retrying in 12s (1/4)…".
 *  - `coldStartRetry.onWakeWait`: the app is asleep and waking, and the SDK
 *    waits inside the turn's one wake budget. No ticker: the plan swaps the
 *    waking line once, on the elapsed time it already has.
 *
 * The latest report wins. `wait` is the plan's `connectWait`; the host calls
 * `clear` when the turn leaves `connecting` (the wait belongs to that phase).
 * `<GuueyChat>` uses it for its default adapters; a host that builds its own
 * adapters wires the two observers into them the same way.
 *
 * N−1: an older pod sends the same 503 + `Retry-After`, or no header at all;
 * either way the SDK reports a `waitMs`, so the countdown never depends on
 * anything the pod did not already send. A server that sends no waking marker
 * never reports a wake, and the connecting ladder runs as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SaturationRetryOptions, WakeWaitInfo } from "@guuey/agent-client";
import type { ConnectWait } from "../types.js";

/** One wait exactly as `@guuey/agent-client`'s `onSaturationWait` reports it. */
export type SaturationWaitReport = Parameters<NonNullable<SaturationRetryOptions["onSaturationWait"]>>[0];

/** How often the countdown re-reads the clock; a whole-second change re-renders. */
export const COUNTDOWN_TICK_MS = 250;

/** Whole seconds from `now` until `retryAt`, never below 0. */
export function secondsUntil(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

export interface ConnectWaitState {
  /** The wait the plan reads as `connectWait`, the busy one with its live `secondsLeft`; null when none is under way. */
  wait: ConnectWait | null;
  /** The transport's `onSaturationWait` (the busy report). Stable for the hook's life. */
  onSaturationWait: (info: SaturationWaitReport) => void;
  /** The transport's `coldStartRetry` observer (the waking report). Stable for the hook's life. */
  coldStartRetry: { onWakeWait: (info: WakeWaitInfo) => void };
  /** Ends the wait (the turn moved on). Stable for the hook's life. */
  clear: () => void;
}

export function useConnectWait(now: () => number = Date.now): ConnectWaitState {
  const [wait, setWait] = useState<ConnectWait | null>(null);
  const retryAtRef = useRef(0);
  const nowRef = useRef(now);
  nowRef.current = now;

  const onSaturationWait = useCallback((info: SaturationWaitReport): void => {
    const at = nowRef.current();
    retryAtRef.current = at + info.waitMs;
    setWait({
      kind: "busy",
      attempt: info.attempt,
      totalAttempts: info.totalAttempts,
      secondsLeft: secondsUntil(retryAtRef.current, at),
    });
  }, []);
  const onWakeWait = useCallback((): void => setWait({ kind: "waking" }), []);
  const coldStartRetry = useMemo(() => ({ onWakeWait }), [onWakeWait]);
  const clear = useCallback((): void => setWait(null), []);

  const counting = wait?.kind === "busy";
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      setWait((prev) => {
        if (prev?.kind !== "busy") return prev;
        const secondsLeft = secondsUntil(retryAtRef.current, nowRef.current());
        return prev.secondsLeft === secondsLeft ? prev : { ...prev, secondsLeft };
      });
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [counting]);

  return { wait, onSaturationWait, coldStartRetry, clear };
}
