// @vitest-environment jsdom
/**
 * guuey#2453 — the ONE connect-wait hook. The transport reports the wait the
 * connecting turn is in: the busy pod (`onSaturationWait`, guuey#2608: the
 * reported wait becomes whole seconds left, ticked down to 0) or the app
 * waking (`coldStartRetry.onWakeWait`, no ticker). The hook's own `useEnd`
 * ends it when the status moves out of `connecting`, and at no other time.
 * Also the elapsed ticker the transcript and a host header share
 * (`useStatusElapsedMs`).
 */
import { act, renderHook } from "@testing-library/react";
import type { AgentInvokeStatus } from "@guuey/agent-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COUNTDOWN_TICK_MS, secondsUntil, useConnectWait, type ConnectWaitState } from "./use-connect-wait.js";
import { useStatusElapsedMs } from "./use-transcript.js";

const WAKE = { elapsedMs: 0, budgetMs: 60_000, attempt: 1 };

describe("secondsUntil", () => {
  it("rounds a partial second up and never goes below 0", () => {
    expect(secondsUntil(12_000, 0)).toBe(12);
    expect(secondsUntil(12_000, 1)).toBe(12);
    expect(secondsUntil(12_000, 11_001)).toBe(1);
    expect(secondsUntil(12_000, 12_000)).toBe(0);
    expect(secondsUntil(12_000, 20_000)).toBe(0);
  });
});

describe("useConnectWait", () => {
  let clock = 0;
  beforeEach(() => {
    clock = 1_000_000;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const advance = (ms: number): void => {
    act(() => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    });
  };

  it("busy: starts at the reported wait and counts down to 0", () => {
    const { result } = renderHook(() => useConnectWait(() => clock));
    expect(result.current.wait).toBeNull();
    act(() => result.current.onSaturationWait({ attempt: 1, totalAttempts: 4, waitMs: 3_000 }));
    expect(result.current.wait).toEqual({ kind: "busy", attempt: 1, totalAttempts: 4, secondsLeft: 3 });
    advance(1_000);
    expect(result.current.wait).toMatchObject({ kind: "busy", secondsLeft: 2 });
    advance(2_000);
    expect(result.current.wait).toMatchObject({ kind: "busy", secondsLeft: 0 });
    advance(5_000);
    expect(result.current.wait).toMatchObject({ kind: "busy", secondsLeft: 0 });
  });

  it("busy: a later wait restarts the count with its own attempt", () => {
    const { result } = renderHook(() => useConnectWait(() => clock));
    act(() => result.current.onSaturationWait({ attempt: 1, totalAttempts: 4, waitMs: 2_000 }));
    advance(2_000);
    act(() => result.current.onSaturationWait({ attempt: 2, totalAttempts: 4, waitMs: 15_000 }));
    expect(result.current.wait).toEqual({ kind: "busy", attempt: 2, totalAttempts: 4, secondsLeft: 15 });
  });

  it("waking: the wake report sets the waking wait, with no ticker", () => {
    const { result } = renderHook(() => useConnectWait(() => clock));
    act(() => result.current.coldStartRetry.onWakeWait(WAKE));
    expect(result.current.wait).toEqual({ kind: "waking" });
    expect(vi.getTimerCount()).toBe(0);
    advance(COUNTDOWN_TICK_MS * 4);
    expect(result.current.wait).toEqual({ kind: "waking" });
  });

  it("the latest report wins: a busy wait after a wake, and a wake after a busy wait", () => {
    const { result } = renderHook(() => useConnectWait(() => clock));
    act(() => result.current.coldStartRetry.onWakeWait(WAKE));
    act(() => result.current.onSaturationWait({ attempt: 1, totalAttempts: 4, waitMs: 5_000 }));
    expect(result.current.wait).toMatchObject({ kind: "busy", secondsLeft: 5 });
    act(() => result.current.coldStartRetry.onWakeWait({ ...WAKE, attempt: 2 }));
    expect(result.current.wait).toEqual({ kind: "waking" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the observers and useEnd keep their identity across renders (the adapters memo depends on them)", () => {
    const { result, rerender } = renderHook(() => useConnectWait(() => clock));
    const { onSaturationWait, coldStartRetry, useEnd } = result.current;
    act(() => onSaturationWait({ attempt: 1, totalAttempts: 4, waitMs: 5_000 }));
    act(() => coldStartRetry.onWakeWait(WAKE));
    rerender();
    expect(result.current.onSaturationWait).toBe(onSaturationWait);
    expect(result.current.coldStartRetry).toBe(coldStartRetry);
    expect(result.current.useEnd).toBe(useEnd);
  });
});

describe("useConnectWait: useEnd, the one rule that ends a wait", () => {
  let clock = 0;
  beforeEach(() => {
    clock = 1_000_000;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  /** A host as GuueyChat and the widget are: the hook first, then `useEnd(status)` after the turn's status exists. */
  function mountHost(initial: AgentInvokeStatus) {
    return renderHook(
      ({ status }: { status: AgentInvokeStatus }): ConnectWaitState => {
        const cw = useConnectWait(() => clock);
        const { useEnd } = cw;
        useEnd(status);
        return cw;
      },
      { initialProps: { status: initial } },
    );
  }

  it("a report made while connecting survives every render within connecting", () => {
    const { result, rerender } = mountHost("ready");
    rerender({ status: "connecting" });
    act(() => result.current.onSaturationWait({ attempt: 1, totalAttempts: 4, waitMs: 5_000 }));
    rerender({ status: "connecting" });
    rerender({ status: "connecting" });
    expect(result.current.wait).toMatchObject({ kind: "busy", secondsLeft: 5 });
    act(() => result.current.coldStartRetry.onWakeWait(WAKE));
    rerender({ status: "connecting" });
    expect(result.current.wait).toEqual({ kind: "waking" });
  });

  it("leaving connecting ends the wait and its ticking, for every next state", () => {
    for (const next of ["thinking", "using-tool", "responding", "ready"] as const) {
      const { result, rerender, unmount } = mountHost("connecting");
      act(() => result.current.onSaturationWait({ attempt: 1, totalAttempts: 4, waitMs: 5_000 }));
      rerender({ status: next });
      expect(result.current.wait, next).toBeNull();
      expect(vi.getTimerCount(), next).toBe(0);
      unmount();
    }
    const { result, rerender } = mountHost("connecting");
    act(() => result.current.coldStartRetry.onWakeWait(WAKE));
    rerender({ status: "ready" });
    expect(result.current.wait).toBeNull();
  });

  it("a synchronous first report, made before the status says connecting, is kept when it does", () => {
    // The transport can report in the same tick the send starts: the host has
    // not re-rendered yet, so the hook still sees `ready`. Entering connecting
    // must not wipe it (the old every-status-change clear did).
    const { result, rerender } = mountHost("ready");
    act(() => result.current.coldStartRetry.onWakeWait(WAKE));
    rerender({ status: "connecting" });
    expect(result.current.wait).toEqual({ kind: "waking" });
    act(() => result.current.onSaturationWait({ attempt: 1, totalAttempts: 4, waitMs: 3_000 }));
    rerender({ status: "connecting" });
    expect(result.current.wait).toMatchObject({ kind: "busy", secondsLeft: 3 });
  });

  it("a change between other states never touches the wait: only leaving connecting ends it", () => {
    const { result, rerender } = mountHost("ready");
    act(() => result.current.coldStartRetry.onWakeWait(WAKE));
    rerender({ status: "thinking" });
    rerender({ status: "responding" });
    expect(result.current.wait).toEqual({ kind: "waking" });
  });

  it("the next turn starts clean: a wait from the turn before does not come back", () => {
    const { result, rerender } = mountHost("connecting");
    act(() => result.current.onSaturationWait({ attempt: 2, totalAttempts: 4, waitMs: 9_000 }));
    rerender({ status: "ready" });
    rerender({ status: "connecting" });
    expect(result.current.wait).toBeNull();
  });
});

describe("useStatusElapsedMs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks while a status line shows, and resets on every status change", () => {
    const { result, rerender } = renderHook(({ status }) => useStatusElapsedMs(status), {
      initialProps: { status: "connecting" as "connecting" | "thinking" | "ready" },
    });
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(1_500));
    expect(result.current).toBeGreaterThanOrEqual(1_000);
    rerender({ status: "thinking" });
    expect(result.current).toBe(0);
    rerender({ status: "ready" });
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
