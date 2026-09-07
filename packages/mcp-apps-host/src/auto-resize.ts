/**
 * The `autoResize` sizing POLICY (guuey#992) — the host's side of the
 * `ui/notifications/size-changed` handshake, kept pure so the loop it
 * prevents is pinned by `auto-resize.test.ts` without a DOM.
 *
 * Why a policy and not "apply the report": the view runtime
 * (`@ggui-ai/iframe-runtime`) measures `documentElement` at `max-content`.
 * A view whose body is viewport-bound (`min-height: 100vh` — routine in
 * generated card CSS, and agent-generated HTML is not ours to control)
 * measures the frame's OWN height plus a constant δ (margins, padding) and
 * reports it back; a host that applies every report verbatim grows the
 * frame by δ per tick without bound. The founder's first prod card sat at
 * 86,816 px. The view cannot tell the two apart; the host can:
 *
 *   1. CEILING — a report is clamped to `ceiling` (the host viewport, or
 *      the embedder's `maxHeight`). A taller card scrolls inside its frame,
 *      as in every chat client.
 *   2. ECHO DETECTOR — a SECOND consecutive growth by the same δ (±2 px),
 *      arriving within {@link ECHO_WINDOW_MS} of our own apply, is the view
 *      echoing the frame, not content: the frame is HELD. The runtime
 *      dedupes identical reports, so a held frame goes quiet.
 *
 * Everything else applies: the first report, every shrink (which also
 * releases a hold), and a growth that is not an echo — real content growth
 * (a section opened) still sizes the frame.
 */

/** Two same-δ growths inside this window after our apply = the echo. */
export const ECHO_WINDOW_MS = 1_000;
/** δ tolerance between the two growths — sub-pixel rounding, not content. */
export const ECHO_DELTA_TOLERANCE_PX = 2;

export interface AutoResizeState {
  /** The height the host last applied to the frame, if any. */
  readonly applied?: number;
  /** When it was applied (ms clock the caller supplies). */
  readonly appliedAt?: number;
  /** The growth (report − applied) the last apply was, if it was a growth. */
  readonly lastDelta?: number;
  /** When the last report arrived — a held frame stays held while growth reports keep coming. */
  readonly lastReportAt?: number;
  /** True while the frame is held against an echo. */
  readonly held: boolean;
}

export interface AutoResizeDecision {
  /** The height to apply now, or `undefined` to leave the frame as it is. */
  readonly apply: number | undefined;
  readonly state: AutoResizeState;
}

export function initialAutoResizeState(): AutoResizeState {
  return { held: false };
}

export function decideAutoResize(
  state: AutoResizeState,
  reportedHeight: number,
  nowMs: number,
  ceiling?: number,
): AutoResizeDecision {
  const target = ceiling !== undefined ? Math.min(reportedHeight, ceiling) : reportedHeight;
  const { applied } = state;

  // First report, or nothing to change.
  if (applied === undefined) {
    return { apply: target, state: { applied: target, appliedAt: nowMs, lastReportAt: nowMs, held: false } };
  }
  if (target === applied) return { apply: undefined, state: { ...state, lastReportAt: nowMs } };

  // A shrink always applies and releases any hold.
  if (target < applied) {
    return { apply: target, state: { applied: target, appliedAt: nowMs, lastReportAt: nowMs, held: false } };
  }

  // A growth while HELD: growth reports still arriving in quick succession
  // are the same echo (or a view growing on its own clock regardless of the
  // frame — equally not a reason to move); a growth after a quiet window is
  // content and falls through to a fresh judgement.
  if (state.held && state.lastReportAt !== undefined && nowMs - state.lastReportAt <= ECHO_WINDOW_MS) {
    return { apply: undefined, state: { ...state, lastReportAt: nowMs } };
  }

  // A growth: the echo test — the same δ as the growth we just applied,
  // inside the window of that apply, is the view measuring the taller frame.
  const delta = target - applied;
  const withinWindow = state.appliedAt !== undefined && nowMs - state.appliedAt <= ECHO_WINDOW_MS;
  const sameDelta = state.lastDelta !== undefined && Math.abs(delta - state.lastDelta) <= ECHO_DELTA_TOLERANCE_PX;
  if (withinWindow && sameDelta) {
    return { apply: undefined, state: { ...state, lastReportAt: nowMs, held: true } };
  }
  return {
    apply: target,
    state: { applied: target, appliedAt: nowMs, lastDelta: delta, lastReportAt: nowMs, held: false },
  };
}
