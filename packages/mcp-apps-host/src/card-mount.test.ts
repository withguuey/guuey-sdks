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
import { resolveViewMount, snapshotViewMount, toolResultViewMount } from "./card-mount.js";
import { GGUI_RENDER_META_KEY } from "./ggui-render.js";

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

describe("toolResultViewMount", () => {
  it("still mounts an inline mcp-ui resource, byte-for-byte as before", () => {
    const mount = toolResultViewMount(
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
    const mount = toolResultViewMount(block({ resourceUri: RESOURCE_URI }, META));
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
    expect(toolResultViewMount(both)).toMatchObject({
      channel: "inline",
      resource: { text: INLINE_HTML },
    });
  });

  it("falls back to the locator channel for a live render whose bootstrap didn't reach us (#122)", () => {
    expect(toolResultViewMount(block({ resourceUri: RESOURCE_URI }))).toEqual({
      channel: "locator",
      resourceUri: RESOURCE_URI,
    });
    expect(toolResultViewMount(block({ events: [], status: "active" }))).toBeUndefined();
  });
});

describe("snapshotViewMount", () => {
  it("mounts an inline resource out of a persisted artifact's parts", () => {
    const snapshot: JsonValue = {
      artifactId: "a1",
      parts: [{ type: "resource", resource: { uri: "ui://x", text: INLINE_HTML } }],
    };
    expect(snapshotViewMount(snapshot)).toMatchObject({
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
    expect(snapshotViewMount(snapshot)).toEqual({ channel: "locator", resourceUri: RESOURCE_URI });
  });

  it("resolves the realistic persisted case (no stored `_meta`) to the locator channel (#122)", () => {
    const snapshot: JsonValue = {
      artifactId: "a1",
      parts: [{ type: "tool-result", uiData: { resourceUri: RESOURCE_URI } }],
    };
    expect(snapshotViewMount(snapshot)).toEqual({ channel: "locator", resourceUri: RESOURCE_URI });
  });

  it("reads a bare block snapshot (no `parts` wrapper)", () => {
    expect(
      snapshotViewMount({ type: "tool-result", uiData: { resourceUri: RESOURCE_URI }, _meta: META }),
    ).toEqual({ channel: "locator", resourceUri: RESOURCE_URI });
    expect(snapshotViewMount("nope")).toBeUndefined();
  });
});

describe("resolveViewMount (guuey#186 G6 — the resolved-only convenience)", () => {
  const RESOLVED = {
    channel: "inline",
    resource: { uri: "ui://tool/app.html", text: INLINE_HTML },
  } as const;

  it("passes an already-resolved mount through untouched — no reader round-trip", async () => {
    let reads = 0;
    const resolved = await resolveViewMount(RESOLVED, () => {
      reads++;
      return Promise.resolve(undefined);
    });
    expect(resolved).toBe(RESOLVED);
    expect(reads).toBe(0);
  });

  it("chains directly off a mount-less block (undefined in, undefined out)", async () => {
    expect(await resolveViewMount(undefined)).toBeUndefined();
  });

  it("resolves a locator through the reader", async () => {
    const seen: string[] = [];
    const resolved = await resolveViewMount(
      { channel: "locator", resourceUri: RESOURCE_URI },
      (uri) => {
        seen.push(uri);
        return Promise.resolve(RESOLVED);
      },
    );
    expect(resolved).toBe(RESOLVED);
    expect(seen).toEqual([RESOURCE_URI]);
  });

  it("is the honest placeholder (undefined) when no reader is wired — never a stale mount", async () => {
    expect(
      await resolveViewMount({ channel: "locator", resourceUri: RESOURCE_URI }),
    ).toBeUndefined();
  });

  it("treats a reader miss — and a locator answer, which would loop — as unresolved", async () => {
    expect(
      await resolveViewMount({ channel: "locator", resourceUri: RESOURCE_URI }, () =>
        Promise.resolve(undefined),
      ),
    ).toBeUndefined();
    expect(
      await resolveViewMount({ channel: "locator", resourceUri: RESOURCE_URI }, () =>
        Promise.resolve({ channel: "locator", resourceUri: "ui://another" }),
      ),
    ).toBeUndefined();
  });
});
