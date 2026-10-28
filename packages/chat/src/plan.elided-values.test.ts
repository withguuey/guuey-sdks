/**
 * guuey#2388 — a tool call or result read back from the store can hold the
 * persistence elision marker (`{ "com.guuey/elided": { bytes } }`) in place
 * of a value that did not fit the row. Live never produces one; the history
 * read does. The planner's live arms read it as what it stands for:
 *  - an elided `structuredContent` is a giant result: its byte count is the
 *    marker's recorded size, and nothing of the marker is shown as a preview;
 *  - an elided `input` has no arguments to show, and the call's
 *    `providerMetadata.wireInput` is never read in its place.
 */
import { describe, expect, it } from "vitest";
import { AgProviderMeta, type AgBlock, type AgReduceResult, type JsonValue } from "@silverprotocol/core";
import { ELIDED_VALUE_MARKER } from "@guuey/mcp-apps-host";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { ToolItem } from "./types.js";

type ToolCallBlock = Extract<AgBlock, { type: "tool-call" }>;
type ToolResultBlock = Extract<AgBlock, { type: "tool-result" }>;

function marker(bytes: number): JsonValue {
  return { [ELIDED_VALUE_MARKER]: { bytes } };
}

function toolItem(call: ToolCallBlock, result: ToolResultBlock): ToolItem {
  const fold: AgReduceResult = {
    messages: [
      { id: "m1", role: "assistant", content: [call] },
      { id: "m1r", role: "tool", content: [result] },
    ],
    artifacts: [],
    memory: [],
    turns: [],
  };
  const plan = planTranscript(
    {
      result: fold,
      assistantText: "",
      status: "ready",
      statusElapsedMs: 0,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [{ role: "user", text: "go" }],
    },
    calmPolicy({ tool: { showToolRows: "all", argsVisible: true } }),
  );
  const tool = plan.items.find((i): i is ToolItem => i.kind === "tool");
  if (tool === undefined) throw new Error("no tool row was planned");
  return tool;
}

const CALL: ToolCallBlock = { type: "tool-call", toolCallId: "t1", name: "lookup", input: { city: "Seoul" } };

function resultWith(fields: Partial<ToolResultBlock>): ToolResultBlock {
  return { type: "tool-result", toolCallId: "t1", content: [], ...fields };
}

describe("an elided structuredContent reads as a giant result (guuey#2388)", () => {
  it("is giant, counts the marker's bytes, and shows no preview or full", () => {
    const tool = toolItem(CALL, resultWith({ structuredContent: marker(900_000) }));
    expect(tool.state).toBe("done");
    expect(tool.result).toEqual({
      kind: "data-result",
      key: "tool.t1.result",
      expanded: true,
      preview: null,
      byteCount: 900_000,
      state: "giant",
      showBytes: true,
    });
  });

  it("never leaks the marker, even beside the text a tool returned", () => {
    const tool = toolItem(
      CALL,
      resultWith({
        structuredContent: marker(2_000_000),
        content: [{ type: "text", text: '{"rows":"elided too"}' }],
      }),
    );
    expect(tool.result?.state).toBe("giant");
    expect(tool.result?.byteCount).toBe(2_000_000);
    expect(tool.result?.preview).toBeNull();
    expect(JSON.stringify(tool)).not.toContain(ELIDED_VALUE_MARKER);
  });

  it("leaves a structuredContent that merely contains other keys alone", () => {
    const tool = toolItem(CALL, resultWith({ structuredContent: { temp: 21 } }));
    expect(tool.result?.state).toBe("small");
    expect(tool.result?.byteCount).toBe(JSON.stringify({ temp: 21 }).length);
  });
});

describe("an elided input shows no arguments (guuey#2388)", () => {
  it("serves no argsPreview, and never reads the wire input in its place", () => {
    const elided: ToolCallBlock = {
      ...CALL,
      input: marker(500_000),
      providerMetadata: AgProviderMeta.parse({ wireInput: { city: "Seoul", raw: "the wire form" } }),
    };
    const tool = toolItem(elided, resultWith({ content: [{ type: "text", text: "sunny" }] }));
    expect(tool.argsPreview).toBeNull();
    expect(JSON.stringify(tool)).not.toContain(ELIDED_VALUE_MARKER);
    expect(JSON.stringify(tool)).not.toContain("the wire form");
  });

  it("still previews a stored input that is not elided", () => {
    const tool = toolItem(CALL, resultWith({ content: [{ type: "text", text: "sunny" }] }));
    expect(tool.argsPreview).toBe(JSON.stringify({ city: "Seoul" }, null, 2));
  });
});
