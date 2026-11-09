import { describe, expect, it } from "vitest";
import { A2UI_GUUEY_CATALOG_ID, JSON_RENDER_CATALOG_ID } from "./catalogs.js";
import { A2UI_CAPABILITIES } from "./useAgentInvoke.js";

describe("the A2UI catalog ids (guuey#2386)", () => {
  // Wire values: a pod and a host compare them as strings, and a release of
  // either reads the previous one's, so a change here is a rolling-release change.
  it("are the wire's exact strings", () => {
    expect(A2UI_GUUEY_CATALOG_ID).toBe("guuey.a2ui.v1");
    expect(JSON_RENDER_CATALOG_ID).toBe("guuey.json-render.v1");
  });

  it("are what A2UI_CAPABILITIES advertises, in that order", () => {
    expect(A2UI_CAPABILITIES.uiResources.catalogs).toEqual([A2UI_GUUEY_CATALOG_ID, JSON_RENDER_CATALOG_ID]);
  });
});
