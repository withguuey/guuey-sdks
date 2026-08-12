import { describe, expect, it } from "vitest";
import type { AgMessage } from "@silverprotocol/core";
import type { HistoryCard } from "./types.js";
import { sortHistoryCards, toolNameFor } from "./history.js";

describe("toolNameFor", () => {
  const message: AgMessage = {
    id: "m1",
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "call-1", name: "render_weather", input: {} },
      { type: "tool-result", toolCallId: "call-1", content: [] },
    ],
  };
  it("resolves the paired tool-call name", () => {
    expect(toolNameFor(message, "call-1")).toBe("render_weather");
  });
  it("falls back to 'tool' when the pair is absent", () => {
    expect(toolNameFor(message, "call-missing")).toBe("tool");
  });
});

describe("sortHistoryCards", () => {
  const card = (seq: number, at: string): HistoryCard => ({ seq, at, cardSnapshot: { seq } });
  it("sorts ascending by seq without mutating input", () => {
    const input = [card(5, "e"), card(1, "a"), card(3, "c")];
    const out = sortHistoryCards(input);
    expect(out.map((c) => c.seq)).toEqual([1, 3, 5]);
    expect(input.map((c) => c.seq)).toEqual([5, 1, 3]);
  });
  it("is stable for equal seq", () => {
    const a = card(2, "first");
    const b = card(2, "second");
    const out = sortHistoryCards([a, b]);
    expect(out[0].at).toBe("first");
    expect(out[1].at).toBe("second");
  });
});
