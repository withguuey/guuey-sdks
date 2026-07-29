/**
 * The card-mount dispatcher — both generative-UI channels, one resource shape,
 * inline-first precedence.
 *
 * The point of the precedence test is a guarantee, not a preference: no
 * existing inline card can change what it renders because the ggui branch
 * exists.
 */
import { describe, expect, it } from "vitest";
import type { AgBlock, JsonValue } from "@silverprotocol/core";
import { cardCardResource, toolResultCardResource } from "./card-mount";
import { GGUI_RENDER_META_KEY } from "./ggui-render";

const INLINE_HTML = "<p>inline card</p>";
const RESOURCE_URI = "ui://ggui/render/render_1/hash";
const RUNTIME_URL = "https://dev.mcp.sandbox.ggui.ai/_ggui/iframe-runtime.js";
const META: JsonValue = {
  // `kind` is one of the three mode discriminators `asGguiRenderBootstrap`
  // requires alongside `runtimeUrl` (see `ggui-render.ts`'s
  // `hasModeDiscriminator`) — without one a real bootstrap is malformed and
  // this fixture would (correctly) fail to mount, same as production.
  [GGUI_RENDER_META_KEY]: { sessionId: "render_1", runtimeUrl: RUNTIME_URL, kind: "system-card" },
};

function block(uiData: JsonValue, meta?: JsonValue): Extract<AgBlock, { type: "tool-result" }> {
  const base: Extract<AgBlock, { type: "tool-result" }> = {
    type: "tool-result",
    toolCallId: "call-1",
    content: [],
    uiData,
  };
  if (meta === undefined || typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return base;
  }
  return { ...base, _meta: meta };
}

describe("toolResultCardResource", () => {
  it("still mounts an inline mcp-ui resource, byte-for-byte as before", () => {
    const resource = toolResultCardResource(
      block({ uri: "ui://tool/app.html", mimeType: "text/html", text: INLINE_HTML }),
    );
    expect(resource).toEqual({
      uri: "ui://tool/app.html",
      mimeType: "text/html",
      text: INLINE_HTML,
    });
  });

  it("mounts a ggui render through its self-contained shell", () => {
    const resource = toolResultCardResource(block({ resourceUri: RESOURCE_URI }, META));
    expect(resource?.uri).toBe(RESOURCE_URI);
    expect(resource?.text).toContain(RUNTIME_URL);
  });

  it("prefers the inline resource when a block somehow carries both", () => {
    const both = block(
      { uri: "ui://tool/app.html", text: INLINE_HTML, resourceUri: RESOURCE_URI },
      META,
    );
    expect(toolResultCardResource(both)?.text).toBe(INLINE_HTML);
  });

  it("returns undefined for a ggui render with no bootstrap, and for plain results", () => {
    expect(toolResultCardResource(block({ resourceUri: RESOURCE_URI }))).toBeUndefined();
    expect(toolResultCardResource(block({ events: [], status: "active" }))).toBeUndefined();
  });
});

describe("cardCardResource", () => {
  it("mounts an inline resource out of a persisted artifact's parts", () => {
    const snapshot: JsonValue = {
      artifactId: "a1",
      parts: [{ type: "resource", resource: { uri: "ui://x", text: INLINE_HTML } }],
    };
    expect(cardCardResource(snapshot)?.text).toBe(INLINE_HTML);
  });

  it("mounts a ggui render part when the snapshot preserved its `_meta`", () => {
    const snapshot: JsonValue = {
      artifactId: "a1",
      parts: [{ type: "tool-result", uiData: { resourceUri: RESOURCE_URI }, _meta: META }],
    };
    expect(cardCardResource(snapshot)?.uri).toBe(RESOURCE_URI);
  });

  it("stays undefined for a ggui card whose stored bootstrap is absent", () => {
    // The realistic persisted case: the fold never stored `_meta`, and a
    // stored bootstrap's wsToken would be expired anyway. The host shows its
    // placeholder rather than a broken mount.
    const snapshot: JsonValue = {
      artifactId: "a1",
      parts: [{ type: "tool-result", uiData: { resourceUri: RESOURCE_URI } }],
    };
    expect(cardCardResource(snapshot)).toBeUndefined();
  });

  it("reads a bare block snapshot (no `parts` wrapper)", () => {
    expect(
      cardCardResource({ type: "tool-result", uiData: { resourceUri: RESOURCE_URI }, _meta: META })
        ?.uri,
    ).toBe(RESOURCE_URI);
    expect(cardCardResource("nope")).toBeUndefined();
  });
});
