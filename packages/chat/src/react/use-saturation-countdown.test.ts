// @vitest-environment jsdom
/**
 * guuey#2608 — the busy line's countdown: the reported wait becomes whole
 * seconds left, ticked down to 0 (the resend is under way), and cleared when
 * the turn moves on.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COUNTDOWN_TICK_MS, secondsUntil, useSaturationCountdown } from "./use-saturation-countdown.js";

describe("secondsUntil", () => {
  it("rounds a partial second up and never goes below 0", () => {
    expect(secondsUntil(12_000, 0)).toBe(12);
    expect(secondsUntil(12_000, 1)).toBe(12);
    expect(secondsUntil(12_000, 11_001)).toBe(1);
    expect(secondsUntil(12_000, 12_000)).toBe(0);
    expect(secondsUntil(12_000, 20_000)).toBe(0);
  });
});

describe("useSaturationCountdown", () => {
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

  it("starts at the reported wait and counts down to 0", () => {
    const { result } = renderHook(() => useSaturationCountdown(() => clock));
    expect(result.current.wait).toBeNull();
    act(() => result.current.report({ attempt: 1, totalAttempts: 4, waitMs: 3_000 }));
    expect(result.current.wait).toEqual({ attempt: 1, totalAttempts: 4, secondsLeft: 3 });
    advance(1_000);
    expect(result.current.wait?.secondsLeft).toBe(2);
    advance(2_000);
    expect(result.current.wait?.secondsLeft).toBe(0);
    advance(5_000);
    expect(result.current.wait?.secondsLeft).toBe(0);
  });

  it("a later wait restarts the count with its own attempt", () => {
    const { result } = renderHook(() => useSaturationCountdown(() => clock));
    act(() => result.current.report({ attempt: 1, totalAttempts: 4, waitMs: 2_000 }));
    advance(2_000);
    act(() => result.current.report({ attempt: 2, totalAttempts: 4, waitMs: 15_000 }));
    expect(result.current.wait).toEqual({ attempt: 2, totalAttempts: 4, secondsLeft: 15 });
  });

  it("clear ends the wait and the ticking", () => {
    const { result } = renderHook(() => useSaturationCountdown(() => clock));
    act(() => result.current.report({ attempt: 1, totalAttempts: 4, waitMs: 5_000 }));
    act(() => result.current.clear());
    expect(result.current.wait).toBeNull();
    advance(COUNTDOWN_TICK_MS * 4);
    expect(result.current.wait).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("report and clear keep their identity across renders (the adapters memo depends on them)", () => {
    const { result, rerender } = renderHook(() => useSaturationCountdown(() => clock));
    const { report, clear } = result.current;
    act(() => report({ attempt: 1, totalAttempts: 4, waitMs: 5_000 }));
    rerender();
    expect(result.current.report).toBe(report);
    expect(result.current.clear).toBe(clear);
  });
});
