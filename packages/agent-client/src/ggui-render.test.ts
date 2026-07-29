/**
 * The ggui render channel: what counts as one, and what the self-contained
 * shell it mounts through must contain.
 *
 * The payloads below are the VERBATIM shapes from the production capture the
 * widget's fixtures replay (`.superpowers/sdd/issue2627-render-capture.sse.txt`,
 * seq 48) — not invented ones.
 */
import { describe, expect, it } from "vitest";
import type { AgBlock, JsonValue } from "@silverprotocol/core";
import {
  asGguiRender,
  asGguiRenderBootstrap,
  blockGguiRender,
  gguiRenderResource,
  gguiShellHtml,
  toolResultGguiRender,
  GGUI_RENDER_META_KEY,
} from "./ggui-render";

// Synthetic ids below reuse the SAME ordinal-keyed remap the widget's
// derived capture fixtures use (`apps/widget/scripts/derive-coalesced-capture.mjs`,
// `apps/widget/src/fixtures/issue2627-render-capture.sse.txt` seq 48) — no
// production identifiers, but shaped identically to the real render.
const RESOURCE_URI =
  "ui://ggui/render/render_00000000-0000-4000-8000-300000000001/c10a20553df2349b";
const RUNTIME_URL = "https://dev.mcp.sandbox.ggui.ai/_ggui/iframe-runtime.js";

const UI_DATA: JsonValue = {
  sessionId: "render_00000000-0000-4000-8000-300000000001",
  resourceUri: RESOURCE_URI,
  action: "create",
  contractHash: "c10a20553df2349b",
};

const SLICE: JsonValue = {
  sessionId: "render_00000000-0000-4000-8000-300000000001",
  appId: "APP00000",
  runtimeUrl: RUNTIME_URL,
  wsUrl: "wss://dev.mcp.sandbox.ggui.ai/ws",
  wsToken:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJraW5kIjoid3MiLCJpYXQiOjAsImV4cCI6MH0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  expiresAt: "2026-07-29T11:07:58.000Z",
  lastSequence: 0,
  propsJson:
    '{"todos":[{"id":"00000000-0000-4000-8000-100000000004","title":"Buy milk","done":false}]}',
};

const META: JsonValue = {
  [GGUI_RENDER_META_KEY]: SLICE,
  ui: { resourceUri: RESOURCE_URI },
  "ui/resourceUri": RESOURCE_URI,
};

function toolResultBlock(
  uiData: JsonValue | undefined,
  meta?: JsonValue,
): Extract<AgBlock, { type: "tool-result" }> {
  const block: Extract<AgBlock, { type: "tool-result" }> = {
    type: "tool-result",
    toolCallId: "toolu_000000000000000000000005",
    content: [],
    ...(uiData !== undefined ? { uiData } : {}),
  };
  if (meta === undefined) return block;
  // `_meta` on a block is `AgMeta` — a JSON record. Narrow structurally.
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return block;
  return { ...block, _meta: meta };
}

describe("asGguiRenderBootstrap", () => {
  it("reads the `ai.ggui/render` slice and keeps it verbatim", () => {
    const bootstrap = asGguiRenderBootstrap(META);
    expect(bootstrap?.runtimeUrl).toBe(RUNTIME_URL);
    expect(bootstrap?.slice).toEqual(SLICE);
  });

  it("rejects a slice with no runtimeUrl — the runtime cannot boot without it", () => {
    expect(asGguiRenderBootstrap({ [GGUI_RENDER_META_KEY]: { sessionId: "s" } })).toBeUndefined();
    expect(asGguiRenderBootstrap({ [GGUI_RENDER_META_KEY]: { runtimeUrl: "" } })).toBeUndefined();
  });

  it("rejects runtimeUrl with no mode discriminator — a bundle to load but nothing to mount", () => {
    // No wsUrl+wsToken, no codeUrl, no kind: ggui's own validateMeta rejects
    // this shape as MALFORMED_BOOTSTRAP, so mounting it would boot a blank
    // shell instead of a card. Undefined here means CanvasPane's empty state,
    // not a mount attempt.
    expect(
      asGguiRenderBootstrap({ [GGUI_RENDER_META_KEY]: { sessionId: "s", runtimeUrl: RUNTIME_URL } }),
    ).toBeUndefined();
    // Half a live-mode pair is still no discriminator.
    expect(
      asGguiRenderBootstrap({
        [GGUI_RENDER_META_KEY]: { runtimeUrl: RUNTIME_URL, wsUrl: "wss://x.test/ws" },
      }),
    ).toBeUndefined();
    // Any one of the three real discriminators is enough.
    expect(
      asGguiRenderBootstrap({
        [GGUI_RENDER_META_KEY]: { runtimeUrl: RUNTIME_URL, kind: "system-card" },
      }),
    ).toBeDefined();
  });

  it("rejects a `_meta` with no ggui slice at all (the MCP-Apps-only case)", () => {
    expect(asGguiRenderBootstrap({ ui: { resourceUri: RESOURCE_URI } })).toBeUndefined();
    expect(asGguiRenderBootstrap(undefined)).toBeUndefined();
    expect(asGguiRenderBootstrap("nope")).toBeUndefined();
  });
});

describe("asGguiRender", () => {
  it("recognises the capture's render and carries its bootstrap", () => {
    const render = asGguiRender(UI_DATA, META);
    expect(render).toBeDefined();
    expect(render?.resourceUri).toBe(RESOURCE_URI);
    expect(render?.sessionId).toBe("render_00000000-0000-4000-8000-300000000001");
    expect(render?.bootstrap?.runtimeUrl).toBe(RUNTIME_URL);
  });

  it("recognises the render WITHOUT `_meta`, but leaves it unmountable", () => {
    // This is the shape the pinned reducer's fold produces on its own — the
    // render is identifiable, and deliberately not mountable.
    const render = asGguiRender(UI_DATA, undefined);
    expect(render?.resourceUri).toBe(RESOURCE_URI);
    expect(render?.bootstrap).toBeUndefined();
    expect(gguiRenderResource(render!)).toBeUndefined();
  });

  it("is gated on the `ui://` scheme — `uiData` is not a UI claim by itself", () => {
    expect(asGguiRender({ resourceUri: "https://example.test/x" }, META)).toBeUndefined();
    expect(asGguiRender({ resourceUri: 7 }, META)).toBeUndefined();
    expect(asGguiRender({ status: "active" }, META)).toBeUndefined();
    expect(asGguiRender(undefined, META)).toBeUndefined();
  });
});

describe("toolResultGguiRender / blockGguiRender", () => {
  it("reads a live tool-result block's uiData + _meta", () => {
    const render = toolResultGguiRender(toolResultBlock(UI_DATA, META));
    expect(render?.bootstrap?.runtimeUrl).toBe(RUNTIME_URL);
  });

  it("returns undefined for an ordinary tool result", () => {
    expect(toolResultGguiRender(toolResultBlock({ events: [], status: "active" }))).toBeUndefined();
    expect(toolResultGguiRender(toolResultBlock(undefined))).toBeUndefined();
  });

  it("reads the same shape off an untyped persisted block", () => {
    expect(blockGguiRender({ type: "tool-result", uiData: UI_DATA, _meta: META })?.resourceUri).toBe(
      RESOURCE_URI,
    );
    expect(blockGguiRender({ type: "text", text: "hi" })).toBeUndefined();
    expect(blockGguiRender("nope")).toBeUndefined();
  });
});

describe("gguiShellHtml", () => {
  const html = gguiShellHtml({ runtimeUrl: RUNTIME_URL, slice: { runtimeUrl: RUNTIME_URL } });

  it("inlines the slice ENVELOPE at __GGUI_META__, keyed exactly as the wire is", () => {
    // The runtime's `parseMetaFromGlobal` defers to the same combiner as the
    // wire `_meta`, so the global must carry the envelope — not the bare slice.
    const match = /globalThis\.__GGUI_META__=(\{[\s\S]*?\});/.exec(html);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toEqual({
      [GGUI_RENDER_META_KEY]: { runtimeUrl: RUNTIME_URL },
    });
  });

  it("loads the runtime from `runtimeUrl` verbatim, as a module", () => {
    expect(html).toContain(`<script type="module" src="${RUNTIME_URL}"></script>`);
  });

  it("populates the global BEFORE the runtime module tag", () => {
    // The runtime autostarts at module evaluation and reads the global
    // synchronously; a global set afterwards is never seen.
    expect(html.indexOf("__GGUI_META__")).toBeLessThan(html.indexOf('type="module"'));
  });

  it("escapes `<` so a slice value can never close the inline script", () => {
    const hostile = gguiShellHtml({
      runtimeUrl: RUNTIME_URL,
      slice: { runtimeUrl: RUNTIME_URL, propsJson: '</script><script>alert(1)</script>' },
    });
    expect(hostile).not.toContain("</script><script>alert(1)");
    expect(hostile.match(/<script/g)).toHaveLength(2);
    const match = /globalThis\.__GGUI_META__=(\{[\s\S]*?\});/.exec(hostile);
    // Escaped, but still the SAME JSON value — escaping must not corrupt it.
    expect(JSON.parse(match![1])[GGUI_RENDER_META_KEY].propsJson).toBe(
      '</script><script>alert(1)</script>',
    );
  });

  it("escapes the runtimeUrl into its attribute", () => {
    const html2 = gguiShellHtml({
      runtimeUrl: 'https://x.test/r.js?a=1&b="2"',
      slice: { runtimeUrl: "https://x.test/r.js" },
    });
    expect(html2).toContain('src="https://x.test/r.js?a=1&amp;b=&quot;2&quot;"');
  });
});

describe("gguiRenderResource", () => {
  it("mounts through the SAME McpUiResourcePayload shape an inline card uses", () => {
    const resource = gguiRenderResource(asGguiRender(UI_DATA, META)!);
    expect(resource?.uri).toBe(RESOURCE_URI); // the render's real uri, not a synthetic one
    expect(resource?.mimeType).toBe("text/html");
    expect(resource?.text).toContain(GGUI_RENDER_META_KEY);
    expect(resource?.text).toContain(RUNTIME_URL);
  });
});
