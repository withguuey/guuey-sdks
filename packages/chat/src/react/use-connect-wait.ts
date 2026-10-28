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
 * The latest report wins. `wait` is the plan's `connectWait`.
 *
 * ONE scoping rule, owned here: a wait belongs to the turn's `connecting`
 * phase, so it ends when the status moves OUT of `connecting`, and only then.
 * Entering `connecting` never clears, so a report made as the turn starts
 * (even synchronously, before the host's effects run) is kept, and a change
 * between other states does not touch it. The rule needs the status, and the
 * status exists only after `useAgentInvoke` returns, while the observers must
 * exist BEFORE it (they feed the transport `useAgentInvoke` is given). So the
 * hook is called first and hands back `useEnd`, a hook the host calls with
 * the status right after `useAgentInvoke`, unconditionally:
 *
 *     const { wait, onSaturationWait, coldStartRetry, useEnd } = useConnectWait();
 *     const adapters = useMemo(() => createWebAdapters({ onSaturationWait, coldStartRetry }), [...]);
 *     const invoke = useAgentInvoke({ ..., adapters });
 *     useEnd(invoke.status);
 *
 * Destructure `useEnd` before calling it: the hooks lint only treats a member
 * call as a hook when the object is PascalCase, so `cw.useEnd(status)` would
 * escape its rules-of-hooks check, while a bare `useEnd(status)` does not.
 * `<GuueyChat>` uses it for its default adapters; a host that builds its own
 * adapters wires the two observers into them the same way.
 *
 * N−1: an older pod sends the same 503 + `Retry-After`, or no header at all;
 * either way the SDK reports a `waitMs`, so the countdown never depends on
 * anything the pod did not already send. A server that sends no waking marker
 * never reports a wake, and the connecting ladder runs as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentInvokeStatus, SaturationRetryOptions, WakeWaitInfo } from "@guuey/agent-client";
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
  /**
   * A hook: call it with the turn's status right after `useAgentInvoke`, on
   * every render, unconditionally. It ends the wait when the status moves out
   * of `connecting`, and at no other time. Stable for the hook's life.
   */
  useEnd: (status: AgentInvokeStatus) => void;
}

/**
 * Build the `useEnd` hook over the wait's setter: the one rule that ends a
 * wait. It keeps the status it last saw in its own state and adjusts the wait
 * DURING render when that status leaves `connecting` (React's "adjust state
 * on a prop change" pattern), rather than in an effect or a ref:
 *  - an effect runs after commit, so a report landing between the commit and
 *    the effect would be wiped by a clear meant for the phase before it;
 *  - a ref written during render survives a render React throws away, so a
 *    discarded render could swallow the transition and the clear with it.
 * State set during render is applied before the commit, and only for the
 * render that is kept. Its hook calls are fixed: one `useState`.
 */
function makeUseEnd(setWait: (wait: ConnectWait | null) => void): (status: AgentInvokeStatus) => void {
  return function useEnd(status: AgentInvokeStatus): void {
    const [seen, setSeen] = useState(status);
    if (seen !== status) {
      setSeen(status);
      if (seen === "connecting") setWait(null);
    }
  };
}

export function useConnectWait(now: () => number = Date.now): ConnectWaitState {
  const [wait, setWait] = useState<ConnectWait | null>(null);
  // Made once: the setter is stable, so `useEnd` keeps one identity (and one
  // set of hook calls) for the hook's life.
  const [useEnd] = useState(() => makeUseEnd(setWait));
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

  return { wait, onSaturationWait, coldStartRetry, useEnd };
}
