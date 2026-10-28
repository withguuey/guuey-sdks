/**
 * The history assembler (root arm — plain Node, zero DOM): the three read
 * outcomes map to the three R13 postures, and a loaded transcript plans
 * identically to the same conversation assembled live.
 */
import { describe, it, expect } from "vitest";
import type { HistoryToolCall, HistoryToolResult } from "@guuey/agent-client";
import { historyToolsOf, transcriptInputsFromHistory } from "./history-inputs.js";
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

describe("historyToolsOf (guuey#2388: calls asked and honoured)", () => {
  const calls: HistoryToolCall[] = [
    { seq: 2, at: "2026-08-15T00:00:00Z", call: { toolCallId: "toolu_a", name: "look_up", input: { q: "x" } } },
  ];
  const results: HistoryToolResult[] = [
    {
      seq: 3,
      at: "2026-08-15T00:00:01Z",
      toolCallId: "toolu_a",
      toolName: "look_up",
      block: { type: "tool-result", toolCallId: "toolu_a", content: [{ type: "text", text: "found" }], outcome: "ok" },
    },
  ];

  it("calls present, results absent → the calls with no results", () => {
    expect(historyToolsOf(calls, undefined)).toEqual({ calls, results: [] });
  });

  it("calls and results present → both, as given", () => {
    const tools = historyToolsOf(calls, results);
    expect(tools?.calls).toBe(calls);
    expect(tools?.results).toBe(results);
  });

  it("calls absent (not asked, not honoured, or an older agent-client) → no historyTools", () => {
    expect(historyToolsOf(undefined, results)).toBeUndefined();
    expect(historyToolsOf(null, results)).toBeUndefined();
  });
});
