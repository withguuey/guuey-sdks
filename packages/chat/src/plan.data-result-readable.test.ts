/**
 * guuey#2367 gap 3: a tool result is READABLE. A non-giant result whose preview
 * was cut carries `full` (the complete text), JSON reads pretty-printed and is
 * tagged `lang: "json"`, and `preview` keeps its bound for N−1 renderers (the
 * installed native builds read only `preview`). A giant result still never
 * travels in full (fixture 6).
 */
import { describe, expect, it } from "vitest";
import type { AgBlock, AgReduceResult, JsonValue } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { DataResultItem, ToolItem } from "./types.js";

type ToolResultContent = Extract<AgBlock, { type: "tool-result" }>["content"];

function resultOf(content: ToolResultContent, structuredContent?: JsonValue): DataResultItem {
  const fold: AgReduceResult = {
    messages: [
      { id: "m1", role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", name: "lookup", input: {} }] },
      {
        id: "m1r",
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            content,
            ...(structuredContent !== undefined ? { structuredContent } : {}),
          },
        ],
      },
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
    calmPolicy({ tool: { showToolRows: "all" } }),
  );
  const tool = plan.items.find((i): i is ToolItem => i.kind === "tool");
  expect(tool?.result).not.toBeNull();
  return tool!.result!;
}

const PREVIEW_CHARS = calmPolicy().dataResult.previewChars;

describe("a readable tool result (guuey#2367 gap 3)", () => {
  it("JSON returned as TEXT reads pretty-printed and is tagged json", () => {
    const r = resultOf([{ type: "text", text: '{"city":"Seoul","temp":21}' }]);
    expect(r.preview).toBe('{\n  "city": "Seoul",\n  "temp": 21\n}');
    expect(r.lang).toBe("json");
    expect(r.full).toBeUndefined(); // nothing was cut
  });

  it("plain text stays as it came, with no lang", () => {
    const r = resultOf([{ type: "text", text: "All done." }]);
    expect(r.preview).toBe("All done.");
    expect(r.lang).toBeUndefined();
  });

  it("a cut but non-giant result carries `full`; `preview` keeps its bound (N−1)", () => {
    const long = "x".repeat(PREVIEW_CHARS + 500);
    const r = resultOf([{ type: "text", text: long }]);
    expect(r.state).toBe("small");
    expect(r.preview).toHaveLength(PREVIEW_CHARS);
    expect(r.full).toBe(long);
  });

  it("structuredContent gets `full` too when cut, pretty-printed, tagged json", () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i, name: `row ${i}` }));
    const r = resultOf([], { rows });
    expect(r.lang).toBe("json");
    expect(r.preview).toHaveLength(PREVIEW_CHARS);
    expect(r.full).toBe(JSON.stringify({ rows }, null, 2));
  });

  it("a GIANT result never travels in full (fixture 6)", () => {
    const giant = "y".repeat(20_000);
    const r = resultOf([{ type: "text", text: giant }]);
    expect(r.state).toBe("giant");
    expect(r.full).toBeUndefined();
    expect(r.preview).toHaveLength(PREVIEW_CHARS);
  });
});
