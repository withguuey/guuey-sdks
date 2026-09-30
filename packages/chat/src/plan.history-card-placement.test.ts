/**
 * guuey#2031 §4.7 — a trailing history card keeps its place when the visitor
 * acts after a reload.
 *
 * A history card with no newer seq-bearing user row used to go to the very
 * tail, after every conversation item. A LIVE row carries no seq, so after a
 * reload a tap on the trailing card (the greeting, most often) drew the new row
 * and its answer ABOVE the card, and the card dropped below the new turn; the
 * next reload, the stored row had a larger seq and the card sat above it. Live
 * and reload disagreed. Now the card sits before the first live user row
 * whenever the surface carries read-plane seqs: where it will sit after a reload.
 *
 * This moves every trailing history card once a live row exists (a standalone
 * behaviour change); a surface without read-plane seqs keeps the tail.
 */
import { describe, expect, it } from "vitest";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { TranscriptInputs, TranscriptMessage } from "./types.js";

const CARD = (seq: number) => ({
  seq,
  at: `2026-09-30T00:00:0${seq}Z`,
  cardSnapshot: {
    artifactId: `a${seq}`,
    parts: [{ type: "tool-result", toolCallId: `toolu_${seq}`, content: [], uiData: { resourceUri: `ui://ggui/render/render_${seq}/h` } }],
  },
});

function inputs(messages: TranscriptMessage[], cards: NonNullable<TranscriptInputs["historyCards"]>): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages,
    historyCards: cards,
    sendStates: {},
    aborted: false,
    adopted: false,
  };
}

const keysOf = (i: TranscriptInputs) => planTranscript(i, calmPolicy()).items.map((item) => item.key);

describe("§4.7 — the trailing history card and the first live row", () => {
  it("history user seq 1, history card seq 5, then one live user row: the card is BEFORE the live row", () => {
    const keys = keysOf(
      inputs(
        [
          { role: "user", text: "Hi!", seq: 1 },
          { role: "assistant", text: "Welcome!", seq: 3 },
          { role: "user", text: "the live tap", clientMessageId: "tap-1" },
        ],
        [CARD(5)],
      ),
    );
    expect(keys.indexOf("card.5")).toBeGreaterThan(keys.indexOf("u0"));
    expect(keys.indexOf("card.5")).toBeLessThan(keys.indexOf("u1"));
  });

  it("a greeting-only history (no user row before the card) still anchors on the first live row", () => {
    const keys = keysOf(
      inputs(
        [
          { role: "assistant", text: "Welcome to the shop.", seq: 2 },
          { role: "user", text: "the live tap", clientMessageId: "tap-1" },
        ],
        [CARD(1)],
      ),
    );
    expect(keys.indexOf("card.1")).toBeLessThan(keys.indexOf("u0"));
  });

  it("with no live row the trailing card keeps the tail, as before", () => {
    const keys = keysOf(
      inputs(
        [
          { role: "user", text: "Hi!", seq: 1 },
          { role: "assistant", text: "Welcome!", seq: 3 },
        ],
        [CARD(5)],
      ),
    );
    expect(keys.indexOf("card.5")).toBe(keys.length - 1);
  });

  it("a surface whose rows carry no read-plane seqs keeps the tail (its seq-less rows are history, not live)", () => {
    const keys = keysOf(
      inputs(
        [
          { role: "user", text: "Hi!" },
          { role: "assistant", text: "Welcome!" },
          { role: "user", text: "again" },
        ],
        [CARD(5)],
      ),
    );
    expect(keys.indexOf("card.5")).toBe(keys.length - 1);
  });

  it("a card older than a history user row still lands before that row, unchanged", () => {
    const keys = keysOf(
      inputs(
        [
          { role: "user", text: "one", seq: 1 },
          { role: "assistant", text: "r", seq: 2 },
          { role: "user", text: "two", seq: 6 },
          { role: "user", text: "live", clientMessageId: "live-1" },
        ],
        [CARD(4)],
      ),
    );
    expect(keys.indexOf("card.4")).toBeLessThan(keys.indexOf("u1"));
  });
});
