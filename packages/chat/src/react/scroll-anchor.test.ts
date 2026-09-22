/**
 * guuey#1328 — the turn's card anchor, as pure rules: which card anchors the
 * current turn (read off the plan), and where following rests. The physics
 * (a real card growing in a real panel) is the e2e sdk project's
 * `chat-kit.spec.ts` leg; the wiring's jsdom checks sit in
 * `transcript.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import type { DisplayItem, TextItem, UserMessageItem, ViewMountItem } from "../types.js";
import { ANCHOR_GAP_PX, followTarget, planTurnAnchor } from "./scroll-anchor.js";

function user(key: string): UserMessageItem {
  return { key, expanded: true, kind: "user", text: key, state: "sent", retry: false, directive: false };
}
function text(key: string): TextItem {
  return { key, expanded: true, kind: "text", text: key, markdown: false, streaming: false, stopped: false };
}
function view(key: string): ViewMountItem {
  return {
    key,
    expanded: true,
    kind: "view",
    mount: null,
    channel: null,
    phase: "negotiating",
    label: null,
    diagnosis: null,
    attribution: null,
    toolTitle: null,
    actionScope: null,
  };
}

describe("planTurnAnchor — the current turn's first card, off the plan", () => {
  it("anchors the FIRST card after the last user message, counting every earlier card", () => {
    const items: DisplayItem[] = [user("u1"), view("v1"), text("t1"), user("u2"), text("lead"), view("v2"), view("v3"), text("t2")];
    expect(planTurnAnchor(items)).toEqual({ turnKey: "u2", viewCount: 3, anchorOrdinal: 1 });
  });

  it("a turn with no card has no anchor, even when an earlier turn had one", () => {
    const items: DisplayItem[] = [user("u1"), view("v1"), user("u2"), text("t2")];
    expect(planTurnAnchor(items)).toEqual({ turnKey: "u2", viewCount: 1, anchorOrdinal: null });
  });

  it("before any user message (an agent-first hello card) the turn is the whole transcript", () => {
    expect(planTurnAnchor([view("hello"), text("t")])).toEqual({ turnKey: "", viewCount: 1, anchorOrdinal: 0 });
  });

  it("an empty transcript has nothing to anchor", () => {
    expect(planTurnAnchor([])).toEqual({ turnKey: "", viewCount: 0, anchorOrdinal: null });
  });
});

describe("followTarget — the bottom, unless it would carry the card out of view", () => {
  const panel = { clientHeight: 560 };

  it("no anchor: the bottom, as stick-to-bottom always did", () => {
    expect(followTarget({ ...panel, scrollTop: 0, scrollHeight: 2000 }, null)).toEqual({ top: 1440, held: false });
  });

  it("the turn still fits under the card: the bottom (the card stays on screen anyway)", () => {
    // Card top at 900; bottom = 1300 − 560 = 740 < 900 − gap → following the bottom keeps the card visible.
    expect(followTarget({ ...panel, scrollTop: 700, scrollHeight: 1300 }, 900)).toEqual({ top: 740, held: false });
  });

  it("the prod case: a card that grows past the panel settles at its top, with room above it", () => {
    // QA's read: a 560 px card, prose below it, held at the tail = 140 px of the card visible.
    const cardTop = 1000;
    const geom = { ...panel, scrollTop: 1000 - 560, scrollHeight: 1000 + 560 + 400 };
    const t = followTarget(geom, cardTop);
    expect(t).toEqual({ top: cardTop - ANCHOR_GAP_PX, held: true });
    // The whole card is inside the viewport [top, top + 560) except the gap's worth at the foot.
    expect(cardTop - t.top).toBe(ANCHOR_GAP_PX);
  });

  it("never scrolls UP to reach an anchor already above the viewer", () => {
    expect(followTarget({ ...panel, scrollTop: 1500, scrollHeight: 4000 }, 1000)).toEqual({ top: 1500, held: true });
  });

  it("a card at the very top of the content clamps to 0, never negative", () => {
    expect(followTarget({ ...panel, scrollTop: 0, scrollHeight: 3000 }, 4)).toEqual({ top: 0, held: true });
  });

  it("content shorter than the panel: the bottom is 0", () => {
    expect(followTarget({ ...panel, scrollTop: 0, scrollHeight: 300 }, 100)).toEqual({ top: 0, held: false });
  });
});
