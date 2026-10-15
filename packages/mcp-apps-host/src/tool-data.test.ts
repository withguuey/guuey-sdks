import { describe, expect, it } from "vitest";
import type { AgBlock, JsonValue } from "@silverprotocol/core";
import {
  ELIDED_VALUE_MARKER,
  snapshotViewToolData,
  toolCallViewInput,
  toolResultViewResult,
  viewToolData,
} from "./tool-data.js";

type ToolResultBlock = Extract<AgBlock, { type: "tool-result" }>;

function result(fields: Partial<ToolResultBlock> = {}): ToolResultBlock {
  return { type: "tool-result", toolCallId: "call-1", content: [], ...fields };
}

describe("toolCallViewInput — the tool-input arguments", () => {
  it("passes a plain-object input through as the arguments", () => {
    expect(toolCallViewInput({ city: "Lisbon", days: 3 })).toEqual({ city: "Lisbon", days: 3 });
  });

  it("sends nothing for an elided input (the persisted marker stands in for the value)", () => {
    expect(toolCallViewInput({ [ELIDED_VALUE_MARKER]: { bytes: 120_000 } })).toBeUndefined();
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a string (a partial stream)", '{"city":"Lis'],
    ["an array", [1, 2]],
    ["a number", 7],
  ])("sends nothing for an input that is %s — arguments are a key-value object", (_label, input) => {
    expect(toolCallViewInput(input)).toBeUndefined();
  });
});

describe("toolResultViewResult — the tool-result params", () => {
  it("carries the surface data (uiData) as structuredContent, plus the text blocks", () => {
    const params = toolResultViewResult(
      result({
        uiData: { resourceUri: "ui://weather/forecast", temps: [21, 23] },
        content: [{ type: "text", text: "Forecast ready." }],
      }),
    );
    expect(params).toEqual({
      content: [{ type: "text", text: "Forecast ready." }],
      structuredContent: { resourceUri: "ui://weather/forecast", temps: [21, 23] },
    });
  });

  it("falls back to structuredContent when no uiData is held", () => {
    const params = toolResultViewResult(result({ structuredContent: { rows: 2 } }));
    expect(params).toEqual({ content: [], structuredContent: { rows: 2 } });
  });

  it("never echoes an inline mount resource back as data — that is the view's own document", () => {
    const params = toolResultViewResult(
      result({
        uiData: { uri: "ui://card/1", mimeType: "text/html", text: "<html></html>" },
        structuredContent: { rows: 2 },
      }),
    );
    expect(params.structuredContent).toEqual({ rows: 2 });
  });

  it("never sends media blocks or provider-raw parts (no base64 crosses into the view)", () => {
    const params = toolResultViewResult(
      result({
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" } },
          { type: "provider-raw", vendor: "anthropic", raw: { type: "resource" } },
          { type: "text", text: "kept" },
        ],
      }),
    );
    expect(params.content).toEqual([{ type: "text", text: "kept" }]);
  });

  it("marks an error result", () => {
    expect(toolResultViewResult(result({ isError: true })).isError).toBe(true);
    expect(toolResultViewResult(result()).isError).toBeUndefined();
  });

  it("never forwards the tool result's _meta (live mount material, short-TTL credentials)", () => {
    const params = toolResultViewResult(
      result({ _meta: { "ai.ggui/render": { wsToken: "secret" } }, structuredContent: { a: 1 } }),
    );
    expect(params).not.toHaveProperty("_meta");
  });
});

describe("viewToolData — a live card's call + result", () => {
  it("pairs the call's arguments with the result", () => {
    const data = viewToolData({ input: { q: "x" } }, result({ structuredContent: { hits: 1 } }));
    expect(data).toEqual({ input: { q: "x" }, result: { content: [], structuredContent: { hits: 1 } } });
  });

  it("omits the input when the call is unknown or its input elided", () => {
    expect(viewToolData(undefined, result()).input).toBeUndefined();
    expect(viewToolData({ input: { [ELIDED_VALUE_MARKER]: { bytes: 9 } } }, result()).input).toBeUndefined();
  });
});

describe("snapshotViewToolData — a persisted card", () => {
  const snapshot: JsonValue = {
    artifactId: "m1#ui#0",
    turnId: "t1",
    threadId: "th1",
    parts: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        content: [{ type: "text", text: "done" }, { type: "image", source: { type: "url", url: "https://x/y.png" } }],
        uiData: { resourceUri: "ui://weather/forecast", temps: [21] },
      },
    ],
  };

  it("rebuilds the result from the stored tool-result part; the input is not stored, so none is sent", () => {
    expect(snapshotViewToolData(snapshot)).toEqual({
      result: { content: [{ type: "text", text: "done" }], structuredContent: { resourceUri: "ui://weather/forecast", temps: [21] } },
    });
  });

  it("uses a stored tool-call part's input when the snapshot carries one", () => {
    const withCall: JsonValue = {
      parts: [
        { type: "tool-call", toolCallId: "call-1", name: "forecast", input: { city: "Porto" } },
        { type: "tool-result", toolCallId: "call-1", content: [], structuredContent: { ok: true } },
      ],
    };
    expect(snapshotViewToolData(withCall)).toEqual({
      input: { city: "Porto" },
      result: { content: [], structuredContent: { ok: true } },
    });
  });

  it("is undefined for a snapshot with no tool-result part", () => {
    expect(snapshotViewToolData({ parts: [{ type: "text", text: "hi" }] })).toBeUndefined();
    expect(snapshotViewToolData("not a snapshot")).toBeUndefined();
  });
});
