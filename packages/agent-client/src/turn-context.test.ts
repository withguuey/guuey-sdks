import { describe, expect, it } from "vitest";
import {
  describeTurnContextRefusal,
  TURN_CONTEXT_MAX_BLOCKS,
  TURN_CONTEXT_MAX_BYTES,
  validateTurnContext,
} from "./turn-context.js";

const text = (t: string) => ({ type: "text", text: t });

describe("validateTurnContext: the server's counts and shape", () => {
  it("the caps are the server's numbers", () => {
    expect(TURN_CONTEXT_MAX_BLOCKS).toBe(32);
    expect(TURN_CONTEXT_MAX_BYTES).toBe(16_384);
  });

  it("accepts text blocks, keeps only type and text, and an empty text", () => {
    expect(validateTurnContext([{ type: "text", text: "plan: pro", extra: 1 }, text("")])).toEqual({
      ok: true,
      blocks: [text("plan: pro"), text("")],
    });
  });

  it("exactly 32 blocks pass; 33 are too many", () => {
    expect(validateTurnContext(Array.from({ length: 32 }, () => text("a")))).toMatchObject({ ok: true });
    expect(validateTurnContext(Array.from({ length: 33 }, () => text("a")))).toEqual({
      ok: false,
      refusal: { reason: "too_many_blocks", max: 32 },
    });
  });

  it("counts JSON.stringify of the { type, text } list in UTF-8 bytes: at the cap passes, one byte over is refused", () => {
    // One block's frame is `[{"type":"text","text":""}]` (27 bytes); fill the rest to land exactly on the cap.
    const frame = new TextEncoder().encode(JSON.stringify([text("")])).byteLength;
    const atCap = [text("x".repeat(TURN_CONTEXT_MAX_BYTES - frame))];
    expect(validateTurnContext(atCap)).toMatchObject({ ok: true });
    const over = [text("x".repeat(TURN_CONTEXT_MAX_BYTES - frame + 1))];
    expect(validateTurnContext(over)).toEqual({ ok: false, refusal: { reason: "too_large", max: 16_384 } });
  });

  it("counts bytes, not characters: multi-byte text reaches the cap sooner", () => {
    const frame = new TextEncoder().encode(JSON.stringify([text("")])).byteLength;
    const euros = Math.floor((TURN_CONTEXT_MAX_BYTES - frame) / 3) + 1; // "€" is 3 bytes
    expect(validateTurnContext([text("€".repeat(euros))])).toMatchObject({ ok: false, refusal: { reason: "too_large" } });
  });

  it("extra keys never count toward the bytes (the server drops them)", () => {
    const frame = new TextEncoder().encode(JSON.stringify([text("")])).byteLength;
    const block = { type: "text", text: "x".repeat(TURN_CONTEXT_MAX_BYTES - frame), note: "y".repeat(1000) };
    expect(validateTurnContext([block])).toMatchObject({ ok: true });
  });

  it.each([
    ["a non-text kind", [{ type: "image", text: "x" }], { reason: "turn_context_kind_unsupported", index: 0 }],
    ["a block without text", [text("ok"), { type: "text" }], { reason: "turn_context_kind_unsupported", index: 1 }],
    ["not an object", [text("ok"), "plain"], { reason: "turn_context_kind_unsupported", index: 1 }],
    ["a text that is not a string", [{ type: "text", text: 7 }], { reason: "not_text", index: 0 }],
  ])("%s is refused with its index", (_label, list, refusal) => {
    expect(validateTurnContext(list)).toEqual({ ok: false, refusal });
  });

  it("a list that is not an array is not_text", () => {
    expect(validateTurnContext("plan: pro")).toEqual({ ok: false, refusal: { reason: "not_text" } });
  });

  it("each refusal reads as one sentence naming the rule", () => {
    expect(describeTurnContextRefusal({ reason: "too_many_blocks", max: 32 })).toContain("32 blocks");
    expect(describeTurnContextRefusal({ reason: "too_large", max: 16_384 })).toContain("16384 bytes");
    expect(describeTurnContextRefusal({ reason: "turn_context_kind_unsupported", index: 1 })).toContain("Block 2");
    expect(describeTurnContextRefusal({ reason: "not_text" })).toContain("list of text blocks");
  });
});
