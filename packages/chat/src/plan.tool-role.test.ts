/**
 * Real pod folds carry `tool-result` blocks in separate `role: "tool"`
 * messages between assistant turns — the widget's production ggui-render
 * capture is the receipt (guuey#135 3b convergence finding). The corpus's
 * hand-driven event sequences fold results into the assistant message, so
 * this shape needs its own pin: an assistant-only walk orphans every call
 * and silently drops every mount, which is exactly the blank-transcript
 * class the R15 trust invariant exists to prevent.
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { ToolItem, ViewMountItem } from "./types.js";

/** A fold shaped the way the production capture folds: results ride `role: "tool"`. */
const FOLD: AgReduceResult = {
  messages: [
    {
      id: "msg_1",
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "toolu_1", name: "ggui_render", input: {} },
      ],
    },
    {
      id: "msg_1_result",
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_1",
          content: [],
          uiData: {
            resourceUri: "ui://ggui/render/r1/abc",
            uri: "ui://ggui/render/r1/abc",
            mimeType: "text/html",
            text: "<p>card</p>",
          },
        },
      ],
    },
    { id: "msg_2", role: "assistant", content: [{ type: "text", text: "Here you go." }] },
  ],
  artifacts: [],
  memory: [],
  turns: [],
};

function plan() {
  return planTranscript(
    {
      result: FOLD,
      assistantText: "",
      status: "ready",
      statusElapsedMs: 0,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [{ role: "user", text: "render something" }],
    },
    calmPolicy(),
  );
}

describe("tool-role result messages (the production fold shape)", () => {
  it("pairs the call with its tool-message result — settled, not orphaned", () => {
    const tool = plan().items.find((i): i is ToolItem => i.kind === "tool");
    expect(tool).toBeDefined();
    expect(tool!.state).toBe("done");
  });

  it("mounts the view the tool-message result carries, with its persisted scope", () => {
    const view = plan().items.find((i): i is ViewMountItem => i.kind === "view");
    expect(view).toBeDefined();
    expect(view!.mount).not.toBeNull();
    expect(view!.actionScope).toBe("ui://ggui/render/r1/abc");
  });

  it("keeps the follow-up assistant text as its own slot", () => {
    const texts = plan()
      .items.filter((i) => i.kind === "text")
      .map((i) => (i.kind === "text" ? i.text : ""));
    expect(texts).toContain("Here you go.");
  });
});
