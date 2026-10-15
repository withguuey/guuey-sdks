/**
 * The view host never sends a tool call's input that persistence elided: it
 * recognizes the marker by `@guuey/mcp-apps-host`'s `ELIDED_VALUE_MARKER`.
 * That package cannot import this one (this one depends on it), so the key is
 * held equal here, where both are in reach.
 */
import { describe, expect, it } from "vitest";
import { ELIDED_VALUE_MARKER, toolCallViewInput } from "@guuey/mcp-apps-host";
import { ELIDED_VALUE_KEY } from "./fold-rows.js";

describe("the elided-value marker is one key", () => {
  it("equals the view host's marker", () => {
    expect(ELIDED_VALUE_MARKER).toBe(ELIDED_VALUE_KEY);
  });

  it("a stored elided input is never sent to a view", () => {
    expect(toolCallViewInput({ [ELIDED_VALUE_KEY]: { bytes: 42 } })).toBeUndefined();
  });
});
