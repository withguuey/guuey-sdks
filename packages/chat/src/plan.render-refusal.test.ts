/**
 * guuey#836 — a ggui_render PRE-GENERATION refusal in the transcript plan.
 *
 * `@ggui-ai/protocol` 0.14.0 made `outcome` a required discriminant on
 * every render result and added the third arm: `'refused'`, a deployment
 * declining the render BEFORE any work (no session, no card, handshake
 * intact). On the wire it is an `isError` tool result whose
 * `structuredContent` is the refusal envelope. Before this the plan faced
 * it as an opaque failed tool with a raw data dump — the "unexplained render
 * failure" a builder cannot act on. Now the row is NAMED: `refusal` carries
 * the envelope typed, there is no view row and no data result, and the
 * state stays `failed` (from the agent's side the call did fail).
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult, JsonValue } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { DisplayItem, ToolItem } from "./types.js";

const REFUSAL_ENVELOPE: JsonValue = {
  outcome: "refused",
  refusal: {
    code: "app_policy_missing",
    message: "This app has no render policy on this deployment.",
    fix: "PUT /v1/provisioning/apps/{appId}/policy from the platform that owns it.",
    retry: "after-fix",
    handshake: "intact",
  },
};

function fold(structuredContent: JsonValue, isError: boolean): AgReduceResult {
  return {
    messages: [
      {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "toolu_1", name: "ggui_render", input: {} }],
      },
      {
        id: "msg_1_result",
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_1",
            content: [{ type: "text", text: "app_policy_missing: This app has no render policy on this deployment." }],
            isError,
            structuredContent,
          },
        ],
      },
    ],
    artifacts: [],
    memory: [],
    turns: [],
  };
}

function plan(result: AgReduceResult): DisplayItem[] {
  return planTranscript(
    {
      result,
      assistantText: "",
      status: "ready",
      statusElapsedMs: 0,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [{ role: "user", text: "render something" }],
    },
    calmPolicy(),
  ).items;
}

describe("a refused ggui_render is a NAMED state on the tool row (guuey#836)", () => {
  it("carries the refusal typed, no view row, no data result, state failed", () => {
    const items = plan(fold(REFUSAL_ENVELOPE, true));
    const tool = items.find((i): i is ToolItem => i.kind === "tool");
    expect(tool).toBeDefined();
    expect(tool!.state).toBe("failed");
    expect(tool!.refusal).not.toBeNull();
    expect(tool!.refusal!.code).toBe("app_policy_missing");
    expect(tool!.refusal!.retry).toBe("after-fix");
    expect(tool!.refusal!.fix).toContain("/policy");
    // The envelope IS the message — no second copy of it as a data dump.
    expect(tool!.result).toBeNull();
    expect(items.some((i) => i.kind === "view")).toBe(false);
  });

  it("a refusal that arrived WITHOUT isError still reads as failed — the discriminant decides, not the flag", () => {
    const tool = plan(fold(REFUSAL_ENVELOPE, false)).find((i): i is ToolItem => i.kind === "tool");
    expect(tool!.state).toBe("failed");
    expect(tool!.refusal?.code).toBe("app_policy_missing");
  });

  it("a §7.1 render FAILURE (identity committed, `outcome: 'failed'`) keeps the old face: failed, data result, refusal null", () => {
    const failed: JsonValue = {
      outcome: "failed",
      sessionId: "render_2",
      action: "create",
      contractHash: "c10a20553df2349b",
      blueprintId: "bp_1",
      variantKey: "v1",
      cache: { hit: false },
      error: { code: "generation_failed", message: "the model produced no interface" },
    };
    const tool = plan(fold(failed, true)).find((i): i is ToolItem => i.kind === "tool");
    expect(tool!.state).toBe("failed");
    expect(tool!.refusal).toBeNull();
    expect(tool!.result).not.toBeNull();
  });

  it("a rendered result from the PREVIOUS wire (no `outcome`) is untouched: done, mounted, refusal null", () => {
    const rendered: JsonValue = {
      sessionId: "render_1",
      action: "create",
      contractHash: "c10a20553df2349b",
      blueprintId: "bp_1",
      variantKey: "v1",
      cache: { hit: false },
      resourceUri: "ui://ggui/render/render_1/hash",
    };
    const items = plan(fold(rendered, false));
    const tool = items.find((i): i is ToolItem => i.kind === "tool");
    expect(tool!.state).toBe("done");
    expect(tool!.refusal).toBeNull();
    expect(items.some((i) => i.kind === "view")).toBe(true);
  });
});
