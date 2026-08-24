/**
 * guuey#423 — persisted cards interleave at their TRUE transcript positions
 * when the flat surface carries read-plane seqs; the old tail-always
 * placement + bottom-pin buried a returning visitor's conversation above a
 * stale trailing card. Pins are POSITIONAL (the #306 discipline).
 */
import { describe, expect, it } from "vitest";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { TranscriptInputs } from "./types.js";

const CARD = (seq: number) => ({
  seq,
  at: `2026-08-14T0${seq}:00:00Z`,
  cardSnapshot: {
    artifactId: `a${seq}`,
    parts: [
      {
        type: "tool-result",
        toolCallId: `toolu_${seq}`,
        content: [],
        uiData: { resourceUri: `ui://x/${seq}`, uri: `ui://x/${seq}`, mimeType: "text/html", text: "<p>c</p>" },
      },
    ],
  },
});

function inputs(messages: TranscriptInputs["messages"], cards: Array<ReturnType<typeof CARD>>): TranscriptInputs {
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

describe("guuey#423 — card interleave by seq", () => {
  it("a card seq-between two history turns renders BETWEEN them, not at the tail", () => {
    const plan = planTranscript(
      inputs(
        [
          { role: "user", text: "menu one", seq: 1 },
          { role: "assistant", text: "here", seq: 3 },
          { role: "user", text: "menu two", seq: 5 },
          { role: "assistant", text: "done", seq: 6 },
        ],
        [CARD(4)], // rendered during turn 1's reply — before user turn 2
      ),
      calmPolicy(),
      {},
    );
    const keys = plan.items.map((i) => i.key);
    const cardIdx = keys.indexOf("card.4");
    const u1 = keys.indexOf("u1");
    const a0Last = keys.reduce((last, k, i) => (k.startsWith("a0.") ? i : last), -1);
    expect(cardIdx).toBeGreaterThan(a0Last);
    expect(cardIdx).toBeLessThan(u1);
  });

  it("a card newer than every turn keeps the tail (the honest newest case)", () => {
    const plan = planTranscript(
      inputs(
        [
          { role: "user", text: "one", seq: 1 },
          { role: "assistant", text: "r", seq: 2 },
        ],
        [CARD(9)],
      ),
      calmPolicy(),
      {},
    );
    const keys = plan.items.map((i) => i.key);
    expect(keys.indexOf("card.9")).toBeGreaterThan(keys.indexOf("u0"));
    expect(keys.indexOf("card.9")).toBe(keys.length - 1);
  });

  it("a seq-less (live-only) session keeps the old tail behavior byte-identically", () => {
    const plan = planTranscript(
      inputs(
        [
          { role: "user", text: "one" },
          { role: "assistant", text: "r" },
        ],
        [CARD(2)],
      ),
      calmPolicy(),
      {},
    );
    const keys = plan.items.map((i) => i.key);
    expect(keys.indexOf("card.2")).toBe(keys.length - 1);
  });

  it("two cards targeting the same slot keep ascending seq order", () => {
    const plan = planTranscript(
      inputs(
        [
          { role: "user", text: "one", seq: 1 },
          { role: "assistant", text: "r", seq: 2 },
          { role: "user", text: "two", seq: 10 },
        ],
        [CARD(4), CARD(6)],
      ),
      calmPolicy(),
      {},
    );
    const keys = plan.items.map((i) => i.key);
    expect(keys.indexOf("card.4")).toBeLessThan(keys.indexOf("card.6"));
    expect(keys.indexOf("card.6")).toBeLessThan(keys.indexOf("u1"));
  });
});
