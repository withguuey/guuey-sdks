import { describe, expect, it } from "vitest";
import type { AgBlock, AgMessage, JsonValue } from "@silverprotocol/core";
import type { HistoryCard } from "./types";
import {
  asResourcePayload,
  asUiResource,
  blockUiResource,
  cardUiResource,
  isJsonObject,
  resourceHtml,
  scanProviderRawForUiResource,
  sortHistoryCards,
  toolNameFor,
  toolResultUiResource,
} from "./block-ui";

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

describe("cardUiResource — walks a persisted AgArtifact snapshot", () => {
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
    expect(cardUiResource(snap)).toEqual({ uri: "ui://card", text: "<card/>" });
  });
  it("returns undefined when no part carries a UI resource (e.g. a ggui bootstrap card)", () => {
    const snap: JsonValue = {
      artifactId: "art1",
      turnId: "turn1",
      threadId: "th1",
      parts: [{ type: "tool-result", toolCallId: "t1", structuredContent: { stackItemId: "s1", url: "x" } }],
    };
    expect(cardUiResource(snap)).toBeUndefined();
  });
  it("falls back to treating the snapshot root as a block", () => {
    expect(cardUiResource({ type: "resource", resource: { uri: "ui://root", text: "<r/>" } })).toEqual({
      uri: "ui://root",
      text: "<r/>",
    });
  });
  it("returns undefined for non-object snapshots", () => {
    expect(cardUiResource(null)).toBeUndefined();
    expect(cardUiResource("card")).toBeUndefined();
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

describe("toolNameFor", () => {
  const message: AgMessage = {
    id: "m1",
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "call-1", name: "render_weather", input: {} },
      { type: "tool-result", toolCallId: "call-1", content: [] },
    ],
  };
  it("resolves the paired tool-call name", () => {
    expect(toolNameFor(message, "call-1")).toBe("render_weather");
  });
  it("falls back to 'tool' when the pair is absent", () => {
    expect(toolNameFor(message, "call-missing")).toBe("tool");
  });
});

describe("sortHistoryCards", () => {
  const card = (seq: number, at: string): HistoryCard => ({ seq, at, cardSnapshot: { seq } });
  it("sorts ascending by seq without mutating input", () => {
    const input = [card(5, "e"), card(1, "a"), card(3, "c")];
    const out = sortHistoryCards(input);
    expect(out.map((c) => c.seq)).toEqual([1, 3, 5]);
    expect(input.map((c) => c.seq)).toEqual([5, 1, 3]);
  });
  it("is stable for equal seq", () => {
    const a = card(2, "first");
    const b = card(2, "second");
    const out = sortHistoryCards([a, b]);
    expect(out[0].at).toBe("first");
    expect(out[1].at).toBe("second");
  });
});
