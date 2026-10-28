/**
 * The view host never sends a tool call's input that persistence elided: it
 * recognizes the marker by `@guuey/mcp-apps-host`'s `ELIDED_VALUE_MARKER`.
 * That package cannot import this one (this one depends on it), so the key is
 * held equal here, where both are in reach.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { ELIDED_VALUE_MARKER, isElidedValue, toolCallViewInput } from "@guuey/mcp-apps-host";
import { ELIDED_VALUE_KEY, isElidedAnswerBlock } from "./fold-rows.js";

describe("the elided-value marker is one key", () => {
  it("equals the view host's marker", () => {
    expect(ELIDED_VALUE_MARKER).toBe(ELIDED_VALUE_KEY);
  });

  // The store's own recognizer is module-private; `isElidedAnswerBlock` reads
  // a text block's `text` through it and nothing else, so it answers for it.
  it.each<[string, JsonValue]>([
    ["the marker", { [ELIDED_VALUE_KEY]: { bytes: 42 } }],
    ["the marker beside another key", { [ELIDED_VALUE_KEY]: { bytes: 42 }, note: "x" }],
    ["the marker with no byte count", { [ELIDED_VALUE_KEY]: null }],
    ["an object without the key", { bytes: 42 }],
    ["an object holding the marker one level down", { value: { [ELIDED_VALUE_KEY]: { bytes: 42 } } }],
    ["an array holding the marker", [{ [ELIDED_VALUE_KEY]: { bytes: 42 } }]],
    ["the key as a string", ELIDED_VALUE_KEY],
    ["null", null],
    ["a number", 42],
  ])("the view host and the store agree on %s", (_label, value) => {
    expect(isElidedValue(value)).toBe(isElidedAnswerBlock({ type: "text", text: value }));
  });

  it("a stored elided input is never sent to a view", () => {
    expect(toolCallViewInput({ [ELIDED_VALUE_KEY]: { bytes: 42 } })).toBeUndefined();
  });
});
