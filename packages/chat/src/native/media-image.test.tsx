// @vitest-environment jsdom
/**
 * An inline native image is sized to the image, the web's twin: before the
 * image reports its size a muted placeholder holds the row; after, the image
 * draws at its own aspect, never wider than the column or than itself and
 * never taller than the 320pt cap, so nothing is letterboxed.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockStyle {
  width?: number | string;
  height?: number;
  maxWidth?: number | string;
  maxHeight?: number;
  aspectRatio?: number;
  backgroundColor?: string;
}
interface LoadEvent {
  nativeEvent: { source: { width: number; height: number; uri: string } };
}
interface MockProps {
  children?: ReactNode;
  style?: MockStyle;
  onLoad?: (e: LoadEvent) => void;
}

let fireLoad: ((e: LoadEvent) => void) | undefined;

vi.mock("react-native", () => ({
  View: ({ children }: MockProps) => createElement("div", {}, children),
  Text: ({ children }: MockProps) => createElement("span", {}, children),
  Pressable: ({ children }: MockProps) => createElement("button", {}, children),
  ScrollView: ({ children }: MockProps) => createElement("div", {}, children),
  Image: ({ style, onLoad }: MockProps) => {
    fireLoad = onLoad;
    return createElement("img", {
      "data-testid": "image",
      "data-style": JSON.stringify(style ?? {}),
    });
  },
  Linking: { openURL: () => Promise.resolve() },
}));

const { NativeMedia } = await import("./components.js");
const { resolveNativeTheme } = await import("./theme-native.js");
const { defaultChatStrings } = await import("../strings.js");
const { DEFAULT_CHAT_THEME } = await import("../theme.js");

import type { MediaItem } from "../types.js";
import type { NativeTranscriptItemContext } from "./components.js";

afterEach(() => {
  cleanup();
  fireLoad = undefined;
});

const tokens = resolveNativeTheme(DEFAULT_CHAT_THEME, "light");
const ctx: NativeTranscriptItemContext = {
  strings: defaultChatStrings,
  tokens,
  onToggle: () => undefined,
  resolvedMounts: new Map(),
  onViewPhase: () => undefined,
};

const image: MediaItem = {
  kind: "media",
  key: "media.t1.0",
  expanded: true,
  media: "image",
  source: { type: "url", url: "data:image/png;base64,AAAA" },
  name: "chart",
  presentation: "inline",
  display: { kind: "image", src: "data:image/png;base64,AAAA" },
  toolCallId: "t1",
};

function drawn(): MockStyle {
  const raw = screen.getByTestId("image").getAttribute("data-style") ?? "{}";
  const parsed: MockStyle = JSON.parse(raw);
  return parsed;
}

function load(width: number, height: number): void {
  act(() => fireLoad?.({ nativeEvent: { source: { width, height, uri: image.display.kind === "image" ? image.display.src : "" } } }));
}

describe("the native inline image is sized to the image", () => {
  it("holds a muted placeholder until the image reports its size", () => {
    render(createElement(NativeMedia, { item: image, ctx }));
    expect(drawn()).toMatchObject({ width: "100%", height: 220, backgroundColor: tokens.palette.canvasMuted });
  });

  it("a wide image leads with the width, up to its own width, at its own aspect, capped at 320 tall", () => {
    render(createElement(NativeMedia, { item: image, ctx }));
    load(600, 300);
    const style = drawn();
    expect(style).toMatchObject({ width: "100%", maxWidth: 600, aspectRatio: 2, maxHeight: 320 });
    expect(style.height).toBeUndefined();
    expect(style.backgroundColor).toBeUndefined();
  });

  it("a tall image leads with the height, capped at 320, the width following the aspect", () => {
    render(createElement(NativeMedia, { item: image, ctx }));
    load(400, 1000);
    expect(drawn()).toMatchObject({ height: 320, aspectRatio: 0.4, maxWidth: "100%" });
  });

  it("a small image draws at its own size, never upscaled past it", () => {
    render(createElement(NativeMedia, { item: image, ctx }));
    load(80, 120);
    expect(drawn()).toMatchObject({ height: 120 });
  });

  it("an image that reports no size keeps the placeholder", () => {
    render(createElement(NativeMedia, { item: image, ctx }));
    load(0, 0);
    expect(drawn()).toMatchObject({ height: 220 });
  });
});
