/**
 * The history assembler (root arm — plain Node, zero DOM): the three read
 * outcomes map to the three R13 postures, and a loaded transcript plans
 * identically to the same conversation assembled live.
 */
import { describe, it, expect } from "vitest";
import { transcriptInputsFromHistory } from "./history-inputs.js";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";

describe("transcriptInputsFromHistory", () => {
  it("null (read in flight) → the R13 loading skeleton", () => {
    const plan = planTranscript(transcriptInputsFromHistory(null), calmPolicy());
    expect(plan.items).toEqual([
      expect.objectContaining({ kind: "history-boundary", state: "loading" }),
    ]);
  });

  it("gone → the labeled empty state", () => {
    const plan = planTranscript(transcriptInputsFromHistory({ gone: true }), calmPolicy());
    expect(plan.items).toEqual([
      expect.objectContaining({ kind: "history-boundary", state: "gone" }),
    ]);
  });

  it("a transcript loads settled, cards riding the R6 remount path", () => {
    const inputs = transcriptInputsFromHistory({
      messages: [
        { role: "user", text: "book it" },
        { role: "assistant", text: "Booked!" },
      ],
      cards: [{ seq: 2, at: "2026-08-15T00:00:00Z", cardSnapshot: { parts: [] } }],
    });
    expect(inputs.historyState).toBe("loaded");
    const plan = planTranscript(inputs, calmPolicy());
    expect(plan.items.map((i) => i.kind)).toEqual(["user", "text", "view"]);
    expect(plan.status).toBeNull();
  });
});
