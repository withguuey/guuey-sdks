/**
 * The `autoResize` sizing POLICY (guuey#992) — pure, so the loop the
 * founder hit on prod (a card's frame at 86,816 px) is pinned without a DOM.
 *
 * The view runtime (`@ggui-ai/iframe-runtime`) measures `documentElement`
 * at `max-content` and posts `ui/notifications/size-changed`. A view whose
 * body is viewport-bound (`min-height: 100vh` — routine in generated card
 * CSS, and agent-generated HTML is not ours to control) therefore reports
 * the frame's OWN height plus a constant δ back to the host; a host that
 * applies every report verbatim grows the frame by δ per tick forever. The
 * host owns the loop's stability:
 *
 *   - a CEILING — never apply more than the host viewport (or `maxHeight`);
 *   - an ECHO DETECTOR — a second consecutive growth by the same δ within a
 *     second of our own apply is the view echoing the frame, not content:
 *     hold the frame where it is (the runtime dedupes identical reports, so
 *     a held frame goes quiet).
 *
 * Shrinks always apply; a growth that is not an echo always applies (up to
 * the ceiling) — real content growth (a user opened a section) still sizes
 * the frame.
 */
import { describe, expect, it } from "vitest";
import { decideAutoResize, initialAutoResizeState, type AutoResizeState } from "./auto-resize.js";

function run(reports: { height: number; at: number }[], ceiling?: number): { applied: (number | undefined)[]; state: AutoResizeState } {
  let state = initialAutoResizeState();
  const applied: (number | undefined)[] = [];
  for (const r of reports) {
    const d = decideAutoResize(state, r.height, r.at, ceiling);
    state = d.state;
    applied.push(d.apply);
  }
  return { applied, state };
}

describe("decideAutoResize — the host owns the loop's stability (guuey#992)", () => {
  it("applies the first positive report and any shrink to a positive height verbatim", () => {
    expect(run([{ height: 420, at: 0 }]).applied).toEqual([420]);
    expect(run([{ height: 420, at: 0 }, { height: 300, at: 50 }]).applied).toEqual([420, 300]);
  });

  it("holds the frame on the SECOND consecutive same-δ growth within a second of our apply — the 100vh echo", () => {
    // 420 → view re-measures the taller frame → 436 (+16, body margins) →
    // 452 (+16 again): that third report is the echo; the frame stays at 436.
    const { applied, state } = run([
      { height: 420, at: 0 },
      { height: 436, at: 20 },
      { height: 452, at: 40 },
      { height: 468, at: 60 },
    ]);
    expect(applied).toEqual([420, 436, undefined, undefined]);
    expect(state.applied).toBe(436);
    expect(state.held).toBe(true);
  });

  it("a growth by a DIFFERENT δ is content, not an echo — it applies (and re-arms the detector)", () => {
    const { applied } = run([
      { height: 420, at: 0 },
      { height: 436, at: 20 },
      { height: 900, at: 40 }, // +464: a section opened
    ]);
    expect(applied).toEqual([420, 436, 900]);
  });

  it("a same-δ growth that arrives MORE than a second after our apply is content — it applies", () => {
    const { applied } = run([
      { height: 420, at: 0 },
      { height: 436, at: 20 },
      { height: 452, at: 2_000 },
    ]);
    expect(applied).toEqual([420, 436, 452]);
  });

  it("never applies above the ceiling — a viewport-tall card scrolls inside its frame", () => {
    expect(run([{ height: 86_816, at: 0 }], 600).applied).toEqual([600]);
    // At the ceiling the echo (600+16) clamps back to 600 = applied → no move.
    const { applied, state } = run([{ height: 700, at: 0 }, { height: 616, at: 20 }], 600);
    expect(applied).toEqual([600, undefined]);
    expect(state.applied).toBe(600);
  });

  it("with no ceiling and no echo, a tall report applies as-is (the ceiling is the host's to supply)", () => {
    expect(run([{ height: 5_000, at: 0 }]).applied).toEqual([5_000]);
  });

  // The view runtime can measure its document before the card mounts (an
  // empty mount root, a fixed-position loading glyph, a zero-margin body)
  // and report a height of 0. A frame sized to 0 has no area, and a browser
  // may throttle a zero-area cross-origin frame, so the real height might
  // never arrive. A height that is not a positive, finite number is never
  // applied: the frame keeps the height it has (or the embedder's floor).
  describe("a height that is not positive is never applied", () => {
    it("a first report of 0 applies nothing", () => {
      expect(run([{ height: 0, at: 0 }]).applied).toEqual([undefined]);
    });

    it("0 then 152 applies only 152", () => {
      const { applied, state } = run([
        { height: 0, at: 0 },
        { height: 152, at: 20 },
      ]);
      expect(applied).toEqual([undefined, 152]);
      expect(state.applied).toBe(152);
    });

    it("300 then 0 applies 300, then nothing — the 300 frame stands", () => {
      const { applied, state } = run([
        { height: 300, at: 0 },
        { height: 0, at: 20 },
      ]);
      expect(applied).toEqual([300, undefined]);
      expect(state.applied).toBe(300);
    });

    it("a negative height behaves like 0", () => {
      expect(run([{ height: -40, at: 0 }]).applied).toEqual([undefined]);
      expect(
        run([
          { height: -40, at: 0 },
          { height: 152, at: 20 },
        ]).applied,
      ).toEqual([undefined, 152]);
      const { applied, state } = run([
        { height: 300, at: 0 },
        { height: -40, at: 20 },
      ]);
      expect(applied).toEqual([300, undefined]);
      expect(state.applied).toBe(300);
    });

    it("a non-finite height behaves like 0", () => {
      for (const height of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(run([{ height, at: 0 }], 600).applied).toEqual([undefined]);
        const { applied, state } = run([
          { height: 300, at: 0 },
          { height, at: 20 },
        ]);
        expect(applied).toEqual([300, undefined]);
        expect(state.applied).toBe(300);
      }
    });

    it("a ceiling of 0 or less never collapses the frame either", () => {
      expect(run([{ height: 152, at: 0 }], 0).applied).toEqual([undefined]);
      expect(run([{ height: 152, at: 0 }], -1).applied).toEqual([undefined]);
    });

    it("a report it does not apply is still recorded as the last report", () => {
      const { state } = run([
        { height: 300, at: 0 },
        { height: 0, at: 20 },
      ]);
      expect(state).toEqual({ applied: 300, appliedAt: 0, lastReportAt: 20, held: false });
    });
  });

  it("a shrink after a hold releases it — the next growth is judged fresh", () => {
    const { applied, state } = run([
      { height: 420, at: 0 },
      { height: 436, at: 20 },
      { height: 452, at: 40 }, // held
      { height: 200, at: 60 }, // shrink applies, hold released
      { height: 260, at: 80 }, // fresh growth applies
    ]);
    expect(applied).toEqual([420, 436, undefined, 200, 260]);
    expect(state.held).toBe(false);
  });
});
