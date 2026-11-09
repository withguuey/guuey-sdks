/** guuey#2549 — what a failed turn was; guuey#2608 — the retry rule re-sends it in its row's place. */
import { describe, expect, it } from "vitest";
import { parseA2uiActionText, writeA2uiActionText } from "@guuey/mcp-apps-host/narrowing";
import { retryInPlaceArgs, retrySendArgs } from "./retry.js";
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

describe("retryInPlaceArgs", () => {
  it("a failed row's re-send names the row it replaces, beside the same arguments", () => {
    expect(retryInPlaceArgs(item({ clientMessageId: "cmid-1" }))).toEqual(["hello", { replaces: "cmid-1" }]);
    expect(retryInPlaceArgs(item({ text: "", inputKind: "context-only", clientMessageId: "cmid-2" }))).toEqual([
      "",
      { inputKind: "context-only", replaces: "cmid-2" },
    ]);
    expect(
      retryInPlaceArgs(item({ text: "<ggui_directive", directive: true, tapLabels: ["Open"], clientMessageId: "cmid-3" })),
    ).toEqual(["<ggui_directive", { tapLabels: ["Open"], replaces: "cmid-3" }]);
  });
  it("a row that is not failed, or has no id, replaces nothing", () => {
    expect(retryInPlaceArgs(item({ state: "sent", clientMessageId: "cmid-1" }))).toEqual(["hello", undefined]);
    expect(retryInPlaceArgs(item({}))).toEqual(["hello", undefined]);
  });
});

describe("an A2UI action turn's retry keeps its id equal to the turn's clientMessageId (guuey#2384, spec §9.3)", () => {
  const record = { surfaceId: "order", name: "submit", sourceComponentId: "go", context: { name: "Ada", size: 4 } };
  const summary = { label: "Place order", pairs: [{ label: "Name", value: "Ada" }] };
  const failed = item({ text: writeA2uiActionText({ ...record, actionId: "cm_A" }, summary) ?? "", directive: true, actionSummary: "Place order: Name = Ada", clientMessageId: "cm_A" });

  it("the block is written again under the new turn's id, by the one writer, and the send carries that id", () => {
    const [text, options] = retryInPlaceArgs(failed, () => "cm_B");
    expect(text).toBe(writeA2uiActionText({ ...record, actionId: "cm_B" }, summary));
    expect(parseA2uiActionText(text)?.actionId).toBe("cm_B");
    expect(options).toEqual({ clientMessageId: "cm_B", replaces: "cm_A" });
  });

  it("re-sent beside its row, it is written again too", () => {
    const [text, options] = retrySendArgs(failed, () => "cm_C");
    expect(parseA2uiActionText(text)?.actionId).toBe("cm_C");
    expect(options).toEqual({ clientMessageId: "cm_C" });
  });

  it("a typed turn's retry mints nothing (the hook mints its id, as before)", () => {
    expect(retryInPlaceArgs(item({ clientMessageId: "cm_1" }), () => "cm_X")).toEqual(["hello", { replaces: "cm_1" }]);
  });
});
