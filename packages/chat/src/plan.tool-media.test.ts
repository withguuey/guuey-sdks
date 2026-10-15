/**
 * guuey#2369 — a tool result's image and audio parts render in their own R7
 * row, in flow after the tool row, and every R7 row loads only from `data:`,
 * `blob:` or the guuey media origin.
 *
 * - An image-only result no longer reads as a byte count inside the tool row:
 *   the tool row carries no data result, the image is its own row.
 * - Text plus image: the data result keeps the text, the image follows.
 * - A row the ggui filter hides still shows its media, like a view mount.
 * - An https URL outside the media origins is a link chip, never fetched.
 * - SVG never renders inline; inline bytes over the cap are a chip.
 */
import { describe, expect, it } from "vitest";
import type { AgBlock, AgReduceResult } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy, type TranscriptPolicy } from "./policy.js";
import type { DisplayItem, MediaItem, ToolGroupItem, ToolItem } from "./types.js";

type ToolResultContent = Extract<AgBlock, { type: "tool-result" }>["content"];

/** A 1x1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const WAV = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

function toolFold(name: string, content: ToolResultContent, extra: AgBlock[] = []): AgReduceResult {
  return {
    messages: [
      { id: "m1", role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", name, input: {} }] },
      { id: "m1r", role: "tool", content: [{ type: "tool-result", toolCallId: "t1", content }] },
      ...(extra.length > 0 ? [{ id: "m2", role: "assistant" as const, content: extra }] : []),
    ],
    artifacts: [],
    memory: [],
    turns: [],
  };
}

function assistantFold(content: AgBlock[]): AgReduceResult {
  return { messages: [{ id: "m1", role: "assistant", content }], artifacts: [], memory: [], turns: [] };
}

function plan(fold: AgReduceResult, policy: TranscriptPolicy = calmPolicy()): DisplayItem[] {
  return planTranscript(
    {
      result: fold,
      assistantText: "",
      status: "ready",
      statusElapsedMs: 0,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [{ role: "user", text: "go" }],
    },
    policy,
  ).items;
}

const mediaOf = (items: DisplayItem[]): MediaItem[] => items.filter((i): i is MediaItem => i.kind === "media");
const toolOf = (items: DisplayItem[]): ToolItem | undefined => items.find((i): i is ToolItem => i.kind === "tool");

describe("tool-result media becomes its own row (guuey#2369)", () => {
  it("an image-only result renders the image after the tool row, not a byte count", () => {
    const items = plan(toolFold("chart", [{ type: "image", source: { type: "base64", mediaType: "image/png", data: PNG } }]));
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "media"]);
    const tool = toolOf(items)!;
    expect(tool.result).toBeNull();
    const [media] = mediaOf(items);
    expect(media!.key).toBe("media.t1.0");
    expect(media!.media).toBe("image");
    expect(media!.presentation).toBe("inline");
    expect(media!.display).toEqual({ kind: "image", src: `data:image/png;base64,${PNG}` });
  });

  it("text plus image: the data result keeps the text, the image follows the tool row", () => {
    const items = plan(
      toolFold("chart", [
        { type: "text", text: "Here is the chart." },
        { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG } },
      ]),
    );
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "media"]);
    const result = toolOf(items)!.result!;
    expect(result.state).toBe("small");
    expect(result.preview).toBe("Here is the chart.");
    expect(mediaOf(items)).toHaveLength(1);
  });

  it("a row hidden by the ggui filter still shows its image", () => {
    const items = plan(
      toolFold("mcp__ggui__ggui_consume", [{ type: "image", source: { type: "base64", mediaType: "image/png", data: PNG } }]),
    );
    expect(toolOf(items)).toBeUndefined();
    expect(items.map((i) => i.kind)).toEqual(["user", "media"]);
    expect(mediaOf(items)[0]!.display.kind).toBe("image");
  });

  it("base64 audio becomes an audio row whose bytes the renderer wraps in a blob: URL", () => {
    const items = plan(toolFold("speak", [{ type: "audio", source: { type: "base64", mediaType: "audio/wav", data: WAV } }]));
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "media"]);
    const [media] = mediaOf(items);
    expect(media!.media).toBe("audio");
    expect(media!.display).toEqual({ kind: "audio-bytes", mediaType: "audio/wav", data: WAV });
  });

  it("inline bytes over the cap render as an oversized chip, not the image", () => {
    const big = "A".repeat(4 * 1024);
    const items = plan(
      toolFold("chart", [{ type: "image", source: { type: "base64", mediaType: "image/png", data: big } }]),
      calmPolicy({ media: { maxInlineBytes: 1024 } }),
    );
    expect(mediaOf(items)[0]!.display).toEqual({ kind: "chip", reason: "oversized" });
  });

  it("a media-bearing call breaks the tool group (R4's display-bearing rule)", () => {
    const fold: AgReduceResult = {
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "a", name: "lookup", input: {} },
            { type: "tool-call", toolCallId: "b", name: "lookup", input: {} },
            { type: "tool-call", toolCallId: "t1", name: "chart", input: {} },
          ],
        },
        {
          id: "m1r",
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "a", content: [{ type: "text", text: "x" }] },
            { type: "tool-result", toolCallId: "b", content: [{ type: "text", text: "y" }] },
            {
              type: "tool-result",
              toolCallId: "t1",
              content: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: PNG } }],
            },
          ],
        },
      ],
      artifacts: [],
      memory: [],
      turns: [],
    };
    const items = plan(fold);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool-group", "tool", "media"]);
    const group = items.find((i): i is ToolGroupItem => i.kind === "tool-group")!;
    expect(group.tools.map((t) => t.toolCallId)).toEqual(["a", "b"]);
  });

  it("debug keeps the same promotion (tool row with no byte count, then the image)", () => {
    const items = plan(
      toolFold("chart", [{ type: "image", source: { type: "base64", mediaType: "image/png", data: PNG } }]),
      debugPolicy(),
    );
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "media"]);
  });
});

describe("R7 loads only data:, blob: and the guuey media origin (guuey#2369)", () => {
  const image = (source: Extract<AgBlock, { type: "image" }>["source"]): MediaItem =>
    mediaOf(plan(assistantFold([{ type: "image", source }])))[0]!;

  it("the default media origins are the guuey media origin", () => {
    expect(calmPolicy().media.origins).toContain("https://guueyusercontent.com");
  });

  it("an https URL outside the media origins is a link chip, never an image src", () => {
    const m = image({ type: "url", url: "https://evil.test/pixel.png?d=secret", mediaType: "image/png" });
    expect(m.display).toEqual({ kind: "link", url: "https://evil.test/pixel.png?d=secret" });
  });

  it("an allowed guueyusercontent.com URL renders", () => {
    const url = "https://media.dev.guueyusercontent.com/app/thread/abc";
    expect(image({ type: "url", url, mediaType: "image/png" }).display).toEqual({ kind: "image", src: url });
    const bare = "https://guueyusercontent.com/x.png";
    expect(image({ type: "url", url: bare }).display).toEqual({ kind: "image", src: bare });
  });

  it("a lookalike host is not the media origin", () => {
    for (const url of [
      "https://guueyusercontent.com.evil.com/x.png",
      "https://evil.com/?x=guueyusercontent.com",
      "https://evil.com/guueyusercontent.com/x.png",
      "https://notguueyusercontent.com/x.png",
    ]) {
      expect(image({ type: "url", url }).display).toEqual({ kind: "link", url });
    }
  });

  it("a builder's own media origin list is honoured", () => {
    const items = plan(
      assistantFold([{ type: "image", source: { type: "url", url: "https://cdn.example/a.png" } }]),
      calmPolicy({ media: { origins: ["https://cdn.example"] } }),
    );
    expect(mediaOf(items)[0]!.display).toEqual({ kind: "image", src: "https://cdn.example/a.png" });
  });

  it("SVG is refused inline, from bytes or from the media origin", () => {
    expect(image({ type: "base64", mediaType: "image/svg+xml", data: "PHN2Zy8+" }).display).toEqual({
      kind: "chip",
      reason: "refused-type",
    });
    expect(
      image({ type: "url", url: "https://guueyusercontent.com/a.svg", mediaType: "image/svg+xml" }).display,
    ).toEqual({ kind: "chip", reason: "refused-type" });
    expect(image({ type: "url", url: "data:image/svg+xml;base64,PHN2Zy8+" }).display).toEqual({
      kind: "chip",
      reason: "refused-type",
    });
  });

  it("blob: and data:image URLs load; http: and other schemes do not", () => {
    expect(image({ type: "url", url: "blob:https://app.example/1234" }).display).toEqual({
      kind: "image",
      src: "blob:https://app.example/1234",
    });
    expect(image({ type: "url", url: `data:image/png;base64,${PNG}` }).display).toEqual({
      kind: "image",
      src: `data:image/png;base64,${PNG}`,
    });
    expect(image({ type: "url", url: "http://guueyusercontent.com/x.png" }).display).toEqual({
      kind: "chip",
      reason: "unsupported",
    });
    expect(image({ type: "url", url: "javascript:alert(1)" }).display).toEqual({ kind: "chip", reason: "unsupported" });
  });

  it("a non-image type in an image row is refused", () => {
    expect(image({ type: "base64", mediaType: "text/html", data: "PGI+" }).display).toEqual({
      kind: "chip",
      reason: "refused-type",
    });
  });

  it("chipOnly keeps an https source behind an open-link action", () => {
    const items = plan(
      assistantFold([{ type: "image", source: { type: "url", url: "https://guueyusercontent.com/x.png" } }]),
      calmPolicy({ media: { chipOnly: true } }),
    );
    const [m] = mediaOf(items);
    expect(m!.presentation).toBe("chip");
    expect(m!.display).toEqual({ kind: "link", url: "https://guueyusercontent.com/x.png" });
  });
});
