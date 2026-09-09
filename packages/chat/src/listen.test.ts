import { describe, expect, it } from "vitest";
import { isGguiConsumeTool, isWaitingOnUser } from "./listen.js";

describe("listen predicates (guuey#1038)", () => {
  it("recognises ggui_consume bare and under any MCP server prefix, nothing else", () => {
    expect(isGguiConsumeTool("ggui_consume")).toBe(true);
    expect(isGguiConsumeTool("mcp__ggui__ggui_consume")).toBe(true);
    expect(isGguiConsumeTool("mcp__acme__ggui_consume")).toBe(true);
    expect(isGguiConsumeTool("ggui_render")).toBe(false);
    expect(isGguiConsumeTool("mcp__ggui__ggui_consume_all")).toBe(false);
    expect(isGguiConsumeTool("xggui_consume")).toBe(false);
    expect(isGguiConsumeTool(null)).toBe(false);
  });

  it("waiting on the user = using-tool AND the tool is the listen", () => {
    expect(isWaitingOnUser("using-tool", "mcp__ggui__ggui_consume")).toBe(true);
    expect(isWaitingOnUser("using-tool", "mcp__ggui__ggui_render")).toBe(false);
    expect(isWaitingOnUser("thinking", "mcp__ggui__ggui_consume")).toBe(false);
    expect(isWaitingOnUser("ready", null)).toBe(false);
  });
});
