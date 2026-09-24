import { describe, expect, it } from "vitest";
import type { AgBlock, AgEvent, JsonValue } from "@silverprotocol/core";
import {
  asResourcePayload,
  asUiResource,
  blockUiResource,
  snapshotUiResource,
  isJsonObject,
  resourceHtml,
  scanProviderRawForUiResource,
      toolResultUiResource,
  toolResultLocator,
} from "./block-ui.js";

describe("isJsonObject", () => {
  it("accepts plain objects, rejects arrays / null / primitives", () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("x")).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });
});

describe("asResourcePayload", () => {
  it("narrows a text resource", () => {
    expect(asResourcePayload({ uri: "ui://x", mimeType: "text/html", text: "<p>hi</p>" })).toEqual({
      uri: "ui://x",
      mimeType: "text/html",
      text: "<p>hi</p>",
    });
  });
  it("narrows a blob resource", () => {
    expect(asResourcePayload({ uri: "ui://x", blob: "PGI+" })).toEqual({ uri: "ui://x", blob: "PGI+" });
  });
  it("rejects missing uri", () => {
    expect(asResourcePayload({ text: "<p/>" })).toBeUndefined();
  });
  it("rejects a resource with neither text nor blob", () => {
    expect(asResourcePayload({ uri: "ui://x", mimeType: "text/html" })).toBeUndefined();
  });
  it("rejects non-objects", () => {
    expect(asResourcePayload(null)).toBeUndefined();
    expect(asResourcePayload("nope")).toBeUndefined();
    expect(asResourcePayload(["ui://x"])).toBeUndefined();
  });
});

describe("asUiResource — direct + {resource}-wrapped", () => {
  it("narrows a directly-inlined resource", () => {
    expect(asUiResource({ uri: "ui://card", text: "<h1/>" })).toEqual({ uri: "ui://card", text: "<h1/>" });
  });
  it("narrows a {resource:{...}}-wrapped resource", () => {
    expect(asUiResource({ resource: { uri: "ui://card", text: "<h1/>" } })).toEqual({
      uri: "ui://card",
      text: "<h1/>",
    });
  });
  it("does NOT require a ui:// scheme (uiData is the explicit surface channel)", () => {
    expect(asUiResource({ uri: "https://x/app", text: "<h1/>" })).toEqual({
      uri: "https://x/app",
      text: "<h1/>",
    });
  });
  it("returns undefined for undefined / invalid uiData", () => {
    expect(asUiResource(undefined)).toBeUndefined();
    expect(asUiResource({ nope: true })).toBeUndefined();
    expect(asUiResource("string")).toBeUndefined();
  });
});

describe("scanProviderRawForUiResource — ui:// gated", () => {
  it("finds a ui:// resource wrapped as an MCP resource content part", () => {
    const raw: JsonValue = { type: "resource", resource: { uri: "ui://weather", text: "<div/>" } };
    expect(scanProviderRawForUiResource(raw)).toEqual({ uri: "ui://weather", text: "<div/>" });
  });
  it("finds a ui:// resource inlined directly on raw", () => {
    expect(scanProviderRawForUiResource({ uri: "ui://weather", text: "<div/>" })).toEqual({
      uri: "ui://weather",
      text: "<div/>",
    });
  });
  it("rejects a non-ui:// resource (a plain file/text part is not a UI)", () => {
    const raw: JsonValue = { type: "resource", resource: { uri: "file:///etc/x", text: "secret" } };
    expect(scanProviderRawForUiResource(raw)).toBeUndefined();
  });
  it("rejects non-objects and resource-less raw", () => {
    expect(scanProviderRawForUiResource(undefined)).toBeUndefined();
    expect(scanProviderRawForUiResource("txt")).toBeUndefined();
    expect(scanProviderRawForUiResource({ type: "text", text: "hi" })).toBeUndefined();
  });
});

describe("blockUiResource — dispatch by block.type", () => {
  it("reads a tool-result's uiData", () => {
    const block: JsonValue = { type: "tool-result", toolCallId: "t1", uiData: { uri: "ui://a", text: "<a/>" } };
    expect(blockUiResource(block)).toEqual({ uri: "ui://a", text: "<a/>" });
  });
  it("reads a provider-raw ui:// resource", () => {
    const block: JsonValue = {
      type: "provider-raw",
      vendor: "anthropic",
      raw: { type: "resource", resource: { uri: "ui://b", text: "<b/>" } },
    };
    expect(blockUiResource(block)).toEqual({ uri: "ui://b", text: "<b/>" });
  });
  it("reads a first-class resource block (ui:// gated)", () => {
    expect(blockUiResource({ type: "resource", resource: { uri: "ui://c", text: "<c/>" } })).toEqual({
      uri: "ui://c",
      text: "<c/>",
    });
    expect(blockUiResource({ type: "resource", resource: { uri: "https://c", text: "<c/>" } })).toBeUndefined();
  });
  it("returns undefined for text / unknown / non-object blocks", () => {
    expect(blockUiResource({ type: "text", text: "hello" })).toBeUndefined();
    expect(blockUiResource({ type: "reasoning", text: "thinking" })).toBeUndefined();
    expect(blockUiResource("nope")).toBeUndefined();
  });
});

describe("toolResultUiResource — live tool-result, both channels", () => {
  const mk = (over: Partial<Extract<AgBlock, { type: "tool-result" }>>): Extract<AgBlock, { type: "tool-result" }> => ({
    type: "tool-result",
    toolCallId: "t1",
    content: [],
    ...over,
  });
  it("prefers the uiData surface channel", () => {
    expect(toolResultUiResource(mk({ uiData: { uri: "ui://a", text: "<a/>" } }))).toEqual({
      uri: "ui://a",
      text: "<a/>",
    });
  });
  it("finds a ui:// resource degraded into a provider-raw content part", () => {
    const block = mk({
      content: [
        { type: "text", text: "here you go" },
        { type: "provider-raw", vendor: "anthropic", raw: { type: "resource", resource: { uri: "ui://b", text: "<b/>" } } },
      ],
    });
    expect(toolResultUiResource(block)).toEqual({ uri: "ui://b", text: "<b/>" });
  });
  it("returns undefined for a plain (non-UI) tool result", () => {
    expect(toolResultUiResource(mk({ content: [{ type: "text", text: "done" }] }))).toBeUndefined();
    expect(toolResultUiResource(mk({ structuredContent: { ok: true } }))).toBeUndefined();
  });
});

describe("snapshotUiResource — walks a persisted AgArtifact snapshot", () => {
  it("finds the first UI resource among artifact parts", () => {
    const snap: JsonValue = {
      artifactId: "art1",
      turnId: "turn1",
      threadId: "th1",
      parts: [
        { type: "text", text: "context" },
        { type: "tool-result", toolCallId: "t1", uiData: { uri: "ui://card", text: "<card/>" } },
      ],
    };
    expect(snapshotUiResource(snap)).toEqual({ uri: "ui://card", text: "<card/>" });
  });
  it("returns undefined when no part carries a UI resource (e.g. a ggui bootstrap card)", () => {
    const snap: JsonValue = {
      artifactId: "art1",
      turnId: "turn1",
      threadId: "th1",
      parts: [{ type: "tool-result", toolCallId: "t1", structuredContent: { stackItemId: "s1", url: "x" } }],
    };
    expect(snapshotUiResource(snap)).toBeUndefined();
  });
  it("falls back to treating the snapshot root as a block", () => {
    expect(snapshotUiResource({ type: "resource", resource: { uri: "ui://root", text: "<r/>" } })).toEqual({
      uri: "ui://root",
      text: "<r/>",
    });
  });
  it("returns undefined for non-object snapshots", () => {
    expect(snapshotUiResource(null)).toBeUndefined();
    expect(snapshotUiResource("card")).toBeUndefined();
  });
});

describe("resourceHtml", () => {
  it("prefers inline text", () => {
    expect(resourceHtml({ uri: "ui://x", text: "<p>hi</p>" })).toBe("<p>hi</p>");
  });
  it("base64-decodes blob with correct UTF-8 handling", () => {
    const html = "<p>café ☕</p>";
    const blob = Buffer.from(html, "utf-8").toString("base64");
    expect(resourceHtml({ uri: "ui://x", blob })).toBe(html);
  });
  it("returns undefined for invalid base64", () => {
    expect(resourceHtml({ uri: "ui://x", blob: "!!!not base64!!!" })).toBeUndefined();
  });
  it("returns undefined when neither text nor blob present", () => {
    expect(resourceHtml({ uri: "ui://x" })).toBeUndefined();
  });
});

describe("blockUiResource — tool-result provider-raw arm (guuey#86 snapshot parity)", () => {
  const uiResource = { uri: "ui://checklist/1", mimeType: "text/html", text: "<html>card</html>" };

  it("mounts a snapshot tool-result whose UI rides only a provider-raw content part", () => {
    const block = {
      type: "tool-result",
      toolCallId: "c1",
      content: [{ type: "provider-raw", vendor: "anthropic", raw: { resource: uiResource } }],
    };
    expect(blockUiResource(block)).toEqual(uiResource);
  });

  it("still prefers uiData over the content scan", () => {
    const surfaced = { uri: "ui://surfaced/1", text: "<html>surfaced</html>" };
    const block = {
      type: "tool-result",
      toolCallId: "c1",
      content: [{ type: "provider-raw", vendor: "anthropic", raw: { resource: uiResource } }],
      uiData: surfaced,
    };
    expect(blockUiResource(block)).toEqual(surfaced);
  });

  it("keeps rejecting non-ui:// provider-raw resources in the content scan", () => {
    const block = {
      type: "tool-result",
      toolCallId: "c1",
      content: [
        { type: "provider-raw", vendor: "anthropic", raw: { resource: { uri: "file://a.txt", text: "hi" } } },
      ],
    };
    expect(blockUiResource(block)).toBeUndefined();
  });
});

describe("toolResultLocator — _meta.ui first, so a folded card survives an omitting final (AgJSON draft.4)", () => {
  const URI = "ui://ggui/render/r1";

  it("reads _meta.ui.resourceUri when the payload channels are gone", () => {
    expect(toolResultLocator({ _meta: { ui: { resourceUri: URI } } })).toBe(URI);
  });

  it("_meta.ui wins over the payload channels; without it the old order holds (uiData, then structuredContent)", () => {
    expect(toolResultLocator({ _meta: { ui: { resourceUri: URI } }, uiData: { resourceUri: "ui://other/1" } })).toBe(URI);
    expect(toolResultLocator({ uiData: { resourceUri: URI }, structuredContent: { resourceUri: "ui://other/1" } })).toBe(URI);
    expect(toolResultLocator({ structuredContent: { resourceUri: URI } })).toBe(URI);
    expect(toolResultLocator({ _meta: { ui: { resourceUri: "https://not-a-ui-uri" } } })).toBeUndefined();
  });

  it("ASSEMBLY on the real 0.7.0 reducer: a kept-open result then a final that omits uiData folds a block whose payload is cleared, and the locator is still found", async () => {
    const { Reducer } = await import("@silverprotocol/core");
    const r = new Reducer();
    const events: AgEvent[] = [
      { type: "turn.start", seq: 1, turnId: "t1" },
      { type: "message.start", seq: 2, id: "m1", turnId: "t1", role: "assistant" },
      { type: "tool.start", seq: 3, toolCallId: "c1", turnId: "t1", messageId: "m1", name: "render", input: {} },
      { type: "tool.done", seq: 4, toolCallId: "c1", turnId: "t1", messageId: "m1", content: [], more: true, uiData: { resourceUri: URI }, _meta: { ui: { resourceUri: URI } } },
      { type: "tool.done", seq: 5, toolCallId: "c1", turnId: "t1", messageId: "m1", content: [{ type: "text", text: "final" }] },
    ];
    for (const e of events) r.push(e);
    const block = r.result().messages.flatMap((m) => m.content).find((b) => b.type === "tool-result");
    if (block?.type !== "tool-result") throw new Error("no tool-result folded");
    // The reducer's own rule: the omitting final cleared the payload channel…
    expect(block.uiData).toBeUndefined();
    // …and the descriptor survived, so the card keeps its identity.
    expect(toolResultLocator(block)).toBe(URI);
  });
});

