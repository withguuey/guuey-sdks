/**
 * The per-turn tool withholds (`Invoke.withheldTools`) as a worker applies them
 * when it builds its own MCP connections: the names withheld on one server, and
 * the OpenAI Agents SDK `toolFilter` callable that drops them on top of MCP Apps
 * visibility. Imported from the package entry, so the public surface is tested.
 */
import { describe, expect, it } from "vitest";
import { modelVisibleToolFilterFor, withheldToolNamesFor, type WithheldTool } from "./index.js";

const consumeOnGgui: WithheldTool[] = [{ server: "ggui", tool: "ggui_consume" }];

const consume = { name: "ggui_consume", inputSchema: { type: "object" } };
const render = {
  name: "ggui_render",
  inputSchema: { type: "object" },
  _meta: { ui: { visibility: ["model", "app"] } },
};
const appOnly = {
  name: "ggui_runtime_submit_action",
  inputSchema: { type: "object" },
  _meta: { ui: { visibility: ["app"] } },
};

describe("withheldToolNamesFor", () => {
  it("names the tools withheld on that server only, once each", () => {
    const withheld: WithheldTool[] = [
      { server: "ggui", tool: "ggui_consume" },
      { server: "todo", tool: "todo_clear" },
      { server: "ggui", tool: "ggui_consume" },
    ];
    expect(withheldToolNamesFor("ggui", withheld)).toEqual(["ggui_consume"]);
    expect(withheldToolNamesFor("todo", withheld)).toEqual(["todo_clear"]);
  });

  it("is empty when nothing is withheld, or nothing on that server", () => {
    expect(withheldToolNamesFor("ggui", undefined)).toEqual([]);
    expect(withheldToolNamesFor("ggui", [])).toEqual([]);
    expect(withheldToolNamesFor("memory", consumeOnGgui)).toEqual([]);
  });
});

describe("modelVisibleToolFilterFor", () => {
  it("drops a tool withheld on its server and keeps the server's other tools", async () => {
    const filter = modelVisibleToolFilterFor("ggui", consumeOnGgui);
    expect(await filter({}, consume)).toBe(false);
    expect(await filter({}, render)).toBe(true);
  });

  it("a withhold on one server leaves a tool of the same name on another server", async () => {
    expect(await modelVisibleToolFilterFor("todo", consumeOnGgui)({}, consume)).toBe(true);
  });

  it("still applies MCP Apps visibility, withheld or not", async () => {
    expect(await modelVisibleToolFilterFor("ggui", consumeOnGgui)({}, appOnly)).toBe(false);
    expect(await modelVisibleToolFilterFor("ggui", undefined)({}, appOnly)).toBe(false);
  });

  it("with nothing withheld, keeps every tool the model may call", async () => {
    const filter = modelVisibleToolFilterFor("ggui", undefined);
    expect(await filter({}, consume)).toBe(true);
    expect(await filter({}, render)).toBe(true);
  });
});
