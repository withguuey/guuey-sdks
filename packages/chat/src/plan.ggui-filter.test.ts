import { describe, expect, it } from "vitest";
import type { AgReduceResult, JsonValue } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import { isGguiProtocolTool } from "./listen.js";
import type { DisplayItem, ToolItem } from "./types.js";

/** A one-tool fold with a configurable tool name + result envelope. */
function fold(name: string, structuredContent: JsonValue, isError: boolean): AgReduceResult {
  return {
    messages: [
      { id: "m1", role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", name, input: {} }] },
      {
        id: "m1r",
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "t1", content: [{ type: "text", text: "ok" }], isError, structuredContent },
        ],
      },
    ],
    artifacts: [],
    memory: [],
    turns: [],
  };
}

const RENDERED: JsonValue = {
  blueprintId: "bp_1",
  variantKey: "v1",
  cache: { hit: false },
  resourceUri: "ui://ggui/render/render_1/hash",
};
const REFUSAL: JsonValue = {
  outcome: "refused",
  refusal: { code: "app_policy_missing", message: "no policy", fix: "PUT /policy", retry: "after-fix", handshake: "intact" },
};

function plan(result: AgReduceResult, showToolRows?: "all" | "non-ggui" | "none"): DisplayItem[] {
  return planTranscript(
    {
      result,
      assistantText: "",
      status: "ready",
      statusElapsedMs: 0,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [{ role: "user", text: "go" }],
    },
    showToolRows ? calmPolicy({ tool: { showToolRows } }) : calmPolicy(),
  ).items;
}

const toolRow = (items: DisplayItem[]): ToolItem | undefined => items.find((i): i is ToolItem => i.kind === "tool");
const hasView = (items: DisplayItem[]): boolean => items.some((i) => i.kind === "view");

describe("isGguiProtocolTool (guuey#1279)", () => {
  it("matches the ggui protocol/lifecycle tools, bare and MCP-prefixed", () => {
    for (const n of ["ggui_handshake", "ggui_render", "ggui_consume", "mcp__ggui__ggui_render"]) {
      expect(isGguiProtocolTool(n)).toBe(true);
    }
  });
  it("does NOT match a non-ggui tool or null", () => {
    for (const n of ["weather_lookup", "search", "mcp__weather__forecast", null]) {
      expect(isGguiProtocolTool(n)).toBe(false);
    }
  });
});

describe("the transcript filters ggui protocol rows by construction (guuey#1279)", () => {
  it("default (non-ggui): a done ggui_render has NO tool row, but the card MOUNT survives", () => {
    const items = plan(fold("ggui_render", RENDERED, false));
    expect(toolRow(items)).toBeUndefined(); // the row is filtered
    expect(hasView(items)).toBe(true); // the card mount survives
  });

  it('showToolRows:"all" shows the ggui_render tool row (the debug door)', () => {
    const items = plan(fold("ggui_render", RENDERED, false), "all");
    expect(toolRow(items)?.name).toBe("ggui_render");
    expect(hasView(items)).toBe(true);
  });

  it('showToolRows:"none" shows NO tool rows at all', () => {
    expect(toolRow(plan(fold("weather_lookup", {}, false), "none"))).toBeUndefined();
    expect(toolRow(plan(fold("ggui_render", RENDERED, false), "none"))).toBeUndefined();
  });

  it("a FAILED ggui_render row is KEPT even under the default — a refusal is a needed error, not chatter (guuey#836)", () => {
    const items = plan(fold("ggui_render", REFUSAL, true));
    const tool = toolRow(items);
    expect(tool).toBeDefined();
    expect(tool!.state).toBe("failed");
    expect(tool!.refusal?.code).toBe("app_policy_missing");
  });

  it("a NON-ggui tool row is NOT filtered by the default", () => {
    const items = plan(fold("weather_lookup", {}, false));
    expect(toolRow(items)?.name).toBe("weather_lookup");
  });

  it("the wire is unchanged — a host that wants the rows opts in; the default just doesn't render them", () => {
    // same fold, two policies: the events are identical, only the rendered rows differ.
    const f = fold("ggui_consume", {}, false);
    expect(toolRow(plan(f, "all"))?.name).toBe("ggui_consume");
    expect(toolRow(plan(f))).toBeUndefined();
  });
});
