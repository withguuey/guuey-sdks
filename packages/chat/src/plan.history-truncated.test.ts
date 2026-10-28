/**
 * guuey#2858: a history read that stopped at its page cap leaves the
 * conversation's OLDEST messages out. The plan says so with one quiet R13
 * line before the earliest message drawn, from either assembler (the history
 * read's `truncated`, or the live hook's `historyTruncated`), and draws
 * nothing new for a whole history.
 */
import { describe, expect, it } from "vitest";
import { transcriptInputsFromHistory } from "./history-inputs.js";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import { defaultChatStrings } from "./strings.js";

const MESSAGES = [
  { role: "user" as const, text: "the newest question", seq: 41 },
  { role: "assistant" as const, text: "its answer", seq: 42 },
];

describe("the truncated-history line (guuey#2858)", () => {
  it("a truncated history read plans the line first, then the conversation", () => {
    const plan = planTranscript(transcriptInputsFromHistory({ messages: MESSAGES, truncated: true, order: "desc" }), calmPolicy());
    expect(plan.items.map((i) => i.kind)).toEqual(["history-boundary", "user", "text"]);
    expect(plan.items[0]).toEqual({
      kind: "history-boundary",
      key: "history",
      expanded: true,
      state: "truncated",
      label: "Earlier messages aren't shown.",
    });
    expect(defaultChatStrings.historyTruncated).toBe("Earlier messages aren't shown.");
  });

  it("a whole history plans no line, and its inputs carry no historyTruncated key", () => {
    const inputs = transcriptInputsFromHistory({ messages: MESSAGES });
    expect(inputs).not.toHaveProperty("historyTruncated");
    expect(planTranscript(inputs, calmPolicy()).items.map((i) => i.kind)).toEqual(["user", "text"]);
  });

  it("a truncated ASCENDING read (an older read plane) plans no line: it left out the newest messages, not the earliest", () => {
    for (const load of [
      { messages: MESSAGES, truncated: true as const, order: "asc" as const },
      { messages: MESSAGES, truncated: true as const },
    ]) {
      const inputs = transcriptInputsFromHistory(load);
      expect(inputs).not.toHaveProperty("historyTruncated");
      expect(planTranscript(inputs, calmPolicy()).items.map((i) => i.kind)).toEqual(["user", "text"]);
    }
  });

  it("loading and gone keep their own line; truncated never doubles it", () => {
    const loading = { ...transcriptInputsFromHistory(null), historyTruncated: true };
    expect(planTranscript(loading, calmPolicy()).items).toEqual([
      expect.objectContaining({ kind: "history-boundary", state: "loading" }),
    ]);
  });
});
