/** guuey#2549 — the one way a failed user turn is sent again. */
import { describe, expect, it } from "vitest";
import { retrySendArgs } from "./retry.js";
import type { UserMessageItem } from "./types.js";

const item = (over: Partial<UserMessageItem>): UserMessageItem => ({
  kind: "user",
  key: "u0",
  expanded: true,
  text: "hello",
  state: "failed",
  retry: true,
  directive: false,
  ...over,
});

describe("retrySendArgs", () => {
  it("a turn without words goes again without words, with its kind", () => {
    expect(retrySendArgs(item({ text: "", inputKind: "context-only" }))).toEqual(["", { inputKind: "context-only" }]);
  });
  it("an action turn goes again with its tapped words beside the directive", () => {
    expect(retrySendArgs(item({ text: "<ggui_directive", directive: true, tapLabels: ["Open", null] }))).toEqual([
      "<ggui_directive",
      { tapLabels: ["Open", null] },
    ]);
  });
  it("anything else is its text", () => {
    expect(retrySendArgs(item({}))).toEqual(["hello", undefined]);
  });
});
