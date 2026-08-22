import { describe, expect, it } from "vitest";

import { humanizeToolName } from "./strings.js";

// guuey#307 — chip labels are end-user copy, not wire identifiers.
describe("humanizeToolName", () => {
  it("maps the ggui rail vocabulary to end-user words", () => {
    expect(humanizeToolName("mcp__ggui__ggui_handshake")).toBe("Preparing interactive card");
    expect(humanizeToolName("mcp__ggui__ggui_consume")).toBe("Updating interactive card");
    expect(humanizeToolName("mcp__ggui__ggui_render")).toBe("Rendering card");
  });

  it("prettifies generic MCP tools as Server · tool", () => {
    expect(humanizeToolName("mcp__todoist__create_task")).toBe("Todoist · create task");
    expect(humanizeToolName("mcp__google_workspace__send_email")).toBe(
      "Google workspace · send email",
    );
  });

  it("keeps the legacy de-underscore for non-MCP names", () => {
    expect(humanizeToolName("web_search")).toBe("web search");
    expect(humanizeToolName("plain")).toBe("plain");
  });

  it("leaves unknown ggui-server tools on the generic MCP path", () => {
    expect(humanizeToolName("mcp__ggui__something_new")).toBe("Ggui · something new");
  });
});
