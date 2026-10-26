// @vitest-environment jsdom
/**
 * The native streaming caret is a cue: it paints the palette's cue, never
 * the raw accent, which on the guuey light theme is a fill (the slime on fog
 * measures 1.10:1).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockProps {
  children?: ReactNode;
  style?: { color?: string };
}

vi.mock("react-native", () => ({
  View: ({ children }: MockProps) => createElement("div", {}, children),
  Text: ({ children, style }: MockProps) => createElement("span", { "data-color": style?.color }, children),
  Pressable: ({ children }: MockProps) => createElement("button", {}, children),
  Image: ({ children }: MockProps) => createElement("img", {}, children),
  ScrollView: ({ children }: MockProps) => createElement("div", {}, children),
  Linking: { openURL: () => Promise.resolve() },
}));

const { NativeText } = await import("./components.js");
const { resolveNativeTheme } = await import("./theme-native.js");
const { defaultChatStrings } = await import("../strings.js");
const { DEFAULT_CHAT_THEME, GUUEY_CHAT_THEME } = await import("../theme.js");

import type { TextItem } from "../types.js";
import type { NativeTranscriptItemContext } from "./components.js";

afterEach(cleanup);

function ctxFor(theme: typeof GUUEY_CHAT_THEME, mode: "light" | "dark"): NativeTranscriptItemContext {
  return {
    strings: defaultChatStrings,
    tokens: resolveNativeTheme(theme, mode),
    onToggle: () => undefined,
    resolvedMounts: new Map(),
    onViewPhase: () => undefined,
  };
}

const streaming: TextItem = {
  key: "text:1",
  expanded: true,
  kind: "text",
  text: "Hello",
  markdown: false,
  streaming: true,
  stopped: false,
};

function caretColour(): string | null {
  return screen.getByText((content) => content.includes("▍")).getAttribute("data-color");
}

describe("the native streaming caret paints the cue", () => {
  it("guuey light: the stroke green, not the slime", () => {
    render(createElement(NativeText, { item: streaming, ctx: ctxFor(GUUEY_CHAT_THEME, "light") }));
    expect(caretColour()).toBe("#4e740d");
    expect(caretColour()).not.toBe(GUUEY_CHAT_THEME.colors.light.accent);
  });

  it("the neutral default: its derived cue, which is its accent", () => {
    render(createElement(NativeText, { item: streaming, ctx: ctxFor(DEFAULT_CHAT_THEME, "light") }));
    expect(caretColour()).toBe(DEFAULT_CHAT_THEME.colors.light.accent);
  });

  it("the tokens carry the same cue the web stamps", () => {
    expect(resolveNativeTheme(GUUEY_CHAT_THEME, "dark").cue).toBe("#b8ff3a");
  });
});
