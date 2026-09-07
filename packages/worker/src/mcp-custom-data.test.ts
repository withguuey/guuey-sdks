import { describe, expect, it } from "vitest";
import { mcpToolCustomData } from "./mcp-custom-data.js";

// guuey#981: the ONE extractor every OpenAI worker passes to
// MCPServerStreamableHttp — structuredContent (cache marker, surface data) AND
// `_meta` (the MCP-Apps `ui` locator), or nothing at all.
describe("mcpToolCustomData (guuey#981)", () => {
  it("carries structuredContent AND resultMeta (as `_meta`) when both are present", () => {
    expect(
      mcpToolCustomData({
        structuredContent: { cache: { hit: false }, resourceUri: "ui://ggui/render/r1/abc" },
        resultMeta: { ui: { resourceUri: "ui://ggui/render/r1/abc" } },
      }),
    ).toEqual({
      structuredContent: { cache: { hit: false }, resourceUri: "ui://ggui/render/r1/abc" },
      _meta: { ui: { resourceUri: "ui://ggui/render/r1/abc" } },
    });
  });

  it("carries whichever is present alone, and returns undefined when neither is (no empty customData on the wire)", () => {
    expect(mcpToolCustomData({ structuredContent: { cache: { hit: true } } })).toEqual({
      structuredContent: { cache: { hit: true } },
    });
    expect(mcpToolCustomData({ resultMeta: { ui: { resourceUri: "ui://x" } } })).toEqual({
      _meta: { ui: { resourceUri: "ui://x" } },
    });
    expect(mcpToolCustomData({})).toBeUndefined();
  });
});
