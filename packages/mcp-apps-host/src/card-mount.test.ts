/**
 * The card-mount dispatcher — inline resource, else `ui://` locator; one
 * resource shape; inline-first precedence.
 *
 * The point of the precedence test is a guarantee, not a preference: no
 * existing inline card can change what it renders because a locator arm
 * exists.
 *
 * guuey#209 (2026-08-16): the ggui bootstrap arm is RETIRED. A tool result
 * that still carries `_meta["ai.ggui/render"]` (a producer that inlines
 * mount material) takes the locator arm like any other `ui://` producer;
 * the mount comes from a `resources/read`, and the `"ggui"` sandbox-trust
 * channel is assigned at resolution from the requested uri
 * (`uiResourceChannel`). "Same visual outcome, different arm" is pinned
 * below through the real reader assembly.
 */
import { describe, expect, it } from "vitest";
import type { AgBlock, JsonValue } from "@silverprotocol/core";
import { resolveViewMount, snapshotViewMount, toolResultViewMount } from "./card-mount.js";
import { createMcpUiResourceReader } from "./reader.js";

const INLINE_HTML = "<p>inline card</p>";
const RESOURCE_URI = "ui://ggui/render/render_1/hash";
const RUNTIME_URL = "https://dev.mcp.sandbox.ggui.ai/_ggui/iframe-runtime.js";
/**
 * ggui's `_meta["ai.ggui/render"]` bootstrap, as a producer that inlines
 * mount material still sends it (the key spelling is ggui's — the retired
 * arm's constant is deprecated, so this file carries the literal on purpose).
 */
const META: JsonValue = {
  "ai.ggui/render": { sessionId: "render_1", runtimeUrl: RUNTIME_URL, kind: "system-card" },
};
/**
 * What ggui's `resources/read` answers for a render locator (guuey#209 C2):
 * the shell with the live-channel material minted FRESH at read time.
 */
const READ_SHELL_HTML =
  `<!doctype html><html><head><script>window.__GGUI_META__=` +
  `{"ai.ggui/render":{"runtimeUrl":"${RUNTIME_URL}","wsUrl":"wss://dev.mcp.sandbox.ggui.ai/ws",` +
  `"wsToken":"fresh-at-read","expiresAt":"2026-08-16T00:03:00Z"}}</script>` +
  `<script type="module" src="${RUNTIME_URL}"></script></head><body></body></html>`;

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

  it("a ggui render carrying its `_meta` bootstrap takes the LOCATOR arm — the vendor arm is retired (#209)", () => {
    // Before 2026-08-16 this block mounted inline through ggui's shell on the
    // "ggui" channel, without a read. Now the bootstrap is inert: the
    // dispatcher hands back the durable locator (uiData won — the normalizer
    // stamped it because `_meta.ui` was present) and the mount comes from a
    // resources/read, exactly like a meta-less render or a non-ggui producer.
    expect(toolResultViewMount(block({ resourceUri: RESOURCE_URI }, META))).toEqual({
      channel: "locator",
      resourceUri: RESOURCE_URI,
    });
  });

  it("same visual outcome, different arm: the locator resolves through a reader to the ggui channel + shell", async () => {
    const mount = toolResultViewMount(block({ resourceUri: RESOURCE_URI }, META));
    const requested: string[] = [];
    const reader = createMcpUiResourceReader({
      readResource: (uri) => {
        requested.push(uri);
        return Promise.resolve({ uri, mimeType: "text/html;profile=mcp-app", text: READ_SHELL_HTML });
      },
    });
    const resolved = await resolveViewMount(mount, reader);
    // ONE read of the block's own locator…
    expect(requested).toEqual([RESOURCE_URI]);
    // …the "ggui" sandbox-trust channel, assigned at RESOLUTION from the
    // requested uri (never from the response, never from inlined `_meta`)…
    expect(resolved?.channel).toBe("ggui");
    if (resolved?.channel !== "ggui") throw new Error("narrowed above");
    // …and the mount material a consumer used to get from the bootstrap arm,
    // now minted fresh at read time (C2): runtime module + live channel.
    expect(resolved.resource.uri).toBe(RESOURCE_URI);
    expect(resolved.resource.text).toContain(RUNTIME_URL);
    expect(resolved.resource.text).toContain("__GGUI_META__");
    expect(resolved.resource.text).toContain("wss://dev.mcp.sandbox.ggui.ai/ws");
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

  it("a live locator with no `_meta` at all is the same locator arm (#122)", () => {
    expect(toolResultViewMount(block({ resourceUri: RESOURCE_URI }))).toEqual({
      channel: "locator",
      resourceUri: RESOURCE_URI,
    });
    expect(toolResultViewMount(block({ events: [], status: "active" }))).toBeUndefined();
  });

  it("a malformed bootstrap changes nothing — the locator arm never looked at `_meta` (#209)", () => {
    // Pre-flip this warned "malformed ggui render bootstrap — degrading to
    // the locator channel"; there is no longer a bootstrap to be malformed.
    const malformed: JsonValue = { "ai.ggui/render": { sessionId: "render_1" } };
    expect(toolResultViewMount(block({ resourceUri: RESOURCE_URI }, malformed))).toEqual({
      channel: "locator",
      resourceUri: RESOURCE_URI,
    });
  });

  // guuey#209 (route-A finding, ggui's 2026-08-16 dev dump): a producer that
  // withholds tool-result `_meta` yields a block with NO uiData and NO _meta —
  // AgJSON §2.1 routes the sibling structuredContent to the MODEL channel —
  // and the `ui://` locator rides `structuredContent.resourceUri`. Keys on
  // the wire: type,toolCallId,content,outcome,isError,structuredContent.
  it("reads a meta-less locator from structuredContent — the production shape a `_meta`-withholding producer emits (#209)", () => {
    const metaLess: Extract<AgBlock, { type: "tool-result" }> = {
      type: "tool-result",
      toolCallId: "call-1",
      content: [{ type: "text", text: "rendered" }],
      outcome: "ok",
      isError: false,
      structuredContent: { resourceUri: RESOURCE_URI, sessionId: "render_1" },
    };
    expect(toolResultViewMount(metaLess)).toEqual({ channel: "locator", resourceUri: RESOURCE_URI });
  });

  it("prefers uiData over structuredContent when both carry a locator (surface routing wins)", () => {
    const both: Extract<AgBlock, { type: "tool-result" }> = {
      ...block({ resourceUri: RESOURCE_URI }),
      structuredContent: { resourceUri: "ui://ggui/render/other/hash" },
    };
    expect(toolResultViewMount(both)).toEqual({ channel: "locator", resourceUri: RESOURCE_URI });
  });

  it("does not treat a non-ui:// structuredContent.resourceUri as a locator", () => {
    const notUi: Extract<AgBlock, { type: "tool-result" }> = {
      type: "tool-result",
      toolCallId: "call-1",
      content: [],
      structuredContent: { resourceUri: "https://example.com/not-a-locator" },
    };
    expect(toolResultViewMount(notUi)).toBeUndefined();
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

  it("resolves a persisted META-LESS placeholder (locator in structuredContent) to the locator channel (#209)", () => {
    const snapshot: JsonValue = {
      artifactId: "a1",
      parts: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          content: [],
          structuredContent: { resourceUri: RESOURCE_URI },
        },
      ],
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
