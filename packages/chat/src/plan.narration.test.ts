/**
 * Interim narration: a text block the producer marked `phase: "interim"`
 * (AgJSON's open-string phase; the OpenAI facet maps a `commentary` message to
 * it) plans as a TextItem with `tone: "interim"`, so renderers draw it as a
 * status line beside the answer instead of inside the answer's bubble. It stays
 * in the transcript: restyled, not hidden. Answer text carries no tone, and a
 * phase value this kit does not know restyles nothing.
 */
import { describe, expect, it } from "vitest";
import type { AgBlock, AgReduceResult } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { DisplayItem, TextItem, TranscriptInputs } from "./types.js";

function foldOf(content: AgBlock[], open = false): AgReduceResult {
  return {
    messages: [{ id: "m1", role: "assistant", turnId: "turn-1", content }],
    artifacts: [],
    memory: [],
    turns: [open ? { turnId: "turn-1", threadId: "t1" } : { turnId: "turn-1", threadId: "t1", outcome: { type: "success" } }],
  };
}

function textItems(result: AgReduceResult, status: TranscriptInputs["status"] = "ready"): TextItem[] {
  const items: DisplayItem[] = planTranscript(
    {
      result,
      assistantText: "",
      status,
      statusElapsedMs: 0,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [{ role: "user", text: "am I free this afternoon?", precedingTurnCount: 0 }],
    },
    calmPolicy(),
  ).items;
  return items.filter((i): i is TextItem => i.kind === "text");
}

const NARRATION: AgBlock = { type: "text", text: "Let me check the calendar.", phase: "interim" };
const ANSWER: AgBlock = { type: "text", text: "You're free from 3 to 5." };

describe("interim narration plans as a status-toned text item", () => {
  it("narration then the answer in one message: the narration is tone interim, the answer carries no tone, and order is kept", () => {
    const texts = textItems(foldOf([NARRATION, ANSWER]));
    expect(texts.map((t) => [t.text, t.tone])).toEqual([
      ["Let me check the calendar.", "interim"],
      ["You're free from 3 to 5.", undefined],
    ]);
    // The answer item is exactly as it was before this field existed.
    expect(texts[1]).not.toHaveProperty("tone");
  });

  it("a phase value this kit does not know, or the final-answer phase, restyles nothing (AgJSON phase is an open string)", () => {
    for (const phase of ["final", "commentary", "INTERIM", ""]) {
      const [only] = textItems(foldOf([{ type: "text", text: "Done.", phase }]));
      expect(only).toBeDefined();
      expect(only).not.toHaveProperty("tone");
    }
  });

  it("mid-flight, the streaming marker stays on the slot's last text item: the answer once it has begun, the narration before it", () => {
    const answering = textItems(foldOf([NARRATION, ANSWER], true), "responding");
    expect(answering.map((t) => [t.tone, t.streaming])).toEqual([
      ["interim", false],
      [undefined, true],
    ]);
    const narrating = textItems(foldOf([NARRATION], true), "responding");
    expect(narrating.map((t) => [t.tone, t.streaming])).toEqual([["interim", true]]);
  });
});
