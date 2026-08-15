import { describe, expect, it } from "vitest";
import { Reducer, type AgEvent, type AgPausedAsk } from "@silverprotocol/core";
import { buildHitlAnswer, grantModeDisplay, hitlPromptsFromFold } from "./hitl.js";

const PLAIN_ASK: AgPausedAsk = { askId: "ask-plain", kind: "approval", message: "Proceed?" };

function pausedFold(asks: AgPausedAsk[]) {
  const reducer = new Reducer();
  let seq = 0;
  const events: AgEvent[] = [
    { type: "turn.start", threadId: "t", turnId: "turn-1", seq: seq++ },
    { type: "turn.done", turnId: "turn-1", outcome: { type: "paused", asks }, seq: seq++ },
  ];
  for (const ev of events) reducer.push(ev);
  return reducer.result();
}

describe("hitlPromptsFromFold", () => {
  it("returns nothing for a null or unpaused fold", () => {
    expect(hitlPromptsFromFold(null)).toEqual([]);
    const reducer = new Reducer();
    reducer.push({ type: "turn.start", threadId: "t", turnId: "turn-1", seq: 0 });
    reducer.push({ type: "turn.done", turnId: "turn-1", outcome: { type: "success" }, seq: 1 });
    expect(hitlPromptsFromFold(reducer.result())).toEqual([]);
  });

  it("lifts every persisted ask, pending by default, merged with the answer ledger", () => {
    const result = pausedFold([PLAIN_ASK, { askId: "ask-2", kind: "approval" }]);
    const prompts = hitlPromptsFromFold(result, { "ask-2": { status: "declined" } });
    expect(prompts.map((p) => [p.id, p.state])).toEqual([
      ["ask-plain", "pending"],
      ["ask-2", "declined"],
    ]);
    expect(prompts[0]?.ask).toEqual(PLAIN_ASK);
  });
});

describe("buildHitlAnswer", () => {
  it("a plain ask (no declaration) accepts as resolved with no echo", () => {
    expect(buildHitlAnswer(PLAIN_ASK, "accept")).toEqual({ askId: "ask-plain", status: "resolved" });
  });

  it("dismissal is cancelled, decline is declined — never carrying an echo", () => {
    expect(buildHitlAnswer(PLAIN_ASK, "dismiss")).toEqual({ askId: "ask-plain", status: "cancelled" });
    expect(buildHitlAnswer(PLAIN_ASK, "decline")).toEqual({ askId: "ask-plain", status: "declined" });
  });

  it("a mode pick on an undeclared ask throws at construction (never dispatches)", () => {
    expect(() => buildHitlAnswer(PLAIN_ASK, { grantModeId: "anything" })).toThrow();
  });
});

describe("grantModeDisplay", () => {
  it("keys off the asker's label; falls back to the id as literal identity", () => {
    expect(grantModeDisplay({ id: "m.x", label: "Always" })).toBe("Always");
    expect(grantModeDisplay({ id: "m.x" })).toBe("m.x");
  });
});
