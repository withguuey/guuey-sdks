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
import { cardCardMount, toolResultCardMount } from "./card-mount";
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

describe("toolResultCardMount", () => {
  it("still mounts an inline mcp-ui resource, byte-for-byte as before", () => {
    const mount = toolResultCardMount(
      block({ uri: "ui://tool/app.html", mimeType: "text/html", text: INLINE_HTML }),
    );
    expect(mount).toEqual({
      channel: "inline",
      resource: {
        uri: "ui://tool/app.html",
        mimeType: "text/html",
        text: INLINE_HTML,
      },
    });
  });

  it("mounts a ggui render through its self-contained shell, on the ggui channel", () => {
    const mount = toolResultCardMount(block({ resourceUri: RESOURCE_URI }, META));
    expect(mount?.channel).toBe("ggui");
    if (mount?.channel !== "ggui") throw new Error("narrowed above");
    expect(mount.resource.uri).toBe(RESOURCE_URI);
    expect(mount.resource.text).toContain(RUNTIME_URL);
  });

  it("prefers the inline resource when a block somehow carries both", () => {
    const both = block(
      { uri: "ui://tool/app.html", text: INLINE_HTML, resourceUri: RESOURCE_URI },
      META,
    );
    // Both the payload AND the channel come from the inline arm — a host must
    // not be told to grant ggui egress to HTML the server wrote itself.
    expect(toolResultCardMount(both)).toMatchObject({
      channel: "inline",
      resource: { text: INLINE_HTML },
    });
  });

  it("falls back to the locator channel for a live render whose bootstrap didn't reach us (#122)", () => {
    expect(toolResultCardMount(block({ resourceUri: RESOURCE_URI }))).toEqual({
      channel: "locator",
      resourceUri: RESOURCE_URI,
    });
    expect(toolResultCardMount(block({ events: [], status: "active" }))).toBeUndefined();
  });
});

describe("cardCardMount", () => {
  it("mounts an inline resource out of a persisted artifact's parts", () => {
    const snapshot: JsonValue = {
      artifactId: "a1",
      parts: [{ type: "resource", resource: { uri: "ui://x", text: INLINE_HTML } }],
    };
    expect(cardCardMount(snapshot)).toMatchObject({
      channel: "inline",
      resource: { text: INLINE_HTML },
    });
  });

  it("resolves a persisted locator to the locator channel even when a stale bootstrap survived (#122)", () => {
    // Persistence strips `_meta` (@guuey/threads), but a foreign snapshot
    // may still carry one — its wsToken is expired, so a mount off it would
    // be dead. The locator ALWAYS wins on the persisted path: rehydration
    // is a fresh resources/read, never a bootstrap replay.
    const snapshot: JsonValue = {
      artifactId: "a1",
      parts: [{ type: "tool-result", uiData: { resourceUri: RESOURCE_URI }, _meta: META }],
    };
    expect(cardCardMount(snapshot)).toEqual({ channel: "locator", resourceUri: RESOURCE_URI });
  });

  it("resolves the realistic persisted case (no stored `_meta`) to the locator channel (#122)", () => {
    const snapshot: JsonValue = {
      artifactId: "a1",
      parts: [{ type: "tool-result", uiData: { resourceUri: RESOURCE_URI } }],
    };
    expect(cardCardMount(snapshot)).toEqual({ channel: "locator", resourceUri: RESOURCE_URI });
  });

  it("reads a bare block snapshot (no `parts` wrapper)", () => {
    expect(
      cardCardMount({ type: "tool-result", uiData: { resourceUri: RESOURCE_URI }, _meta: META }),
    ).toEqual({ channel: "locator", resourceUri: RESOURCE_URI });
    expect(cardCardMount("nope")).toBeUndefined();
  });
});
