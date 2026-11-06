// @vitest-environment jsdom
/**
 * A user send that did not go: the bubble holds the reader's own words, so it
 * is calm in both tones, hollow (surface fill, a 1 px muted-ink border, ink
 * words, full opacity), and its words stay selectable. The tone lives on the
 * line under it: a fault keeps the error colour, the retry tone draws plain
 * ink. Retry is the accent in both tones.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockStyle {
  color?: string;
  backgroundColor?: string;
  borderWidth?: number;
  borderColor?: string;
  opacity?: number;
}
interface MockProps {
  children?: ReactNode;
  style?: MockStyle;
  selectable?: boolean;
  onPress?: () => void;
}

function styleData(style: MockStyle | undefined): Record<string, string | undefined> {
  return {
    "data-color": style?.color,
    "data-bg": style?.backgroundColor,
    "data-border-width": style?.borderWidth === undefined ? undefined : String(style.borderWidth),
    "data-border-color": style?.borderColor,
    "data-opacity": style?.opacity === undefined ? undefined : String(style.opacity),
  };
}

vi.mock("react-native", () => ({
  View: ({ children, style }: MockProps) => createElement("div", styleData(style), children),
  Text: ({ children, style, selectable }: MockProps) =>
    createElement("span", { ...styleData(style), "data-selectable": String(selectable === true) }, children),
  Pressable: ({ children, onPress }: MockProps) => createElement("button", { onClick: onPress }, children),
  Image: ({ children }: MockProps) => createElement("img", {}, children),
  ScrollView: ({ children }: MockProps) => createElement("div", {}, children),
  Linking: { openURL: () => Promise.resolve() },
}));

const { NativeUserMessage } = await import("./components.js");
const { resolveNativeTheme } = await import("./theme-native.js");
const { defaultChatStrings } = await import("../strings.js");
const { DEFAULT_CHAT_THEME } = await import("../theme.js");

import type { UserMessageItem } from "../types.js";
import type { NativeTranscriptItemContext } from "./components.js";

afterEach(cleanup);

const tokens = resolveNativeTheme(DEFAULT_CHAT_THEME, "light");
const ctx: NativeTranscriptItemContext = {
  strings: defaultChatStrings,
  tokens,
  onToggle: () => undefined,
  resolvedMounts: new Map(),
  onViewPhase: () => undefined,
};

function user(over: Partial<UserMessageItem> = {}): UserMessageItem {
  return {
    key: "user:1",
    expanded: true,
    kind: "user",
    text: "hello there",
    state: "failed",
    retry: true,
    directive: false,
    ...over,
  };
}

function bubbleOf(text: string): { words: HTMLElement; bubble: HTMLElement; row: HTMLElement } {
  const words = screen.getByText(text);
  const bubble = words.parentElement;
  const row = bubble?.parentElement;
  if (!bubble || !row) throw new Error("bubble not found");
  return { words, bubble, row };
}

describe("NativeUserMessage, failed send", () => {
  it("the palette's error colour differs from every colour the calm look uses", () => {
    for (const c of [tokens.palette.inkMuted, tokens.palette.ink, tokens.palette.surface, tokens.palette.accent]) {
      expect(c).not.toBe(tokens.palette.error);
    }
  });

  for (const tone of [undefined, "retry"] as const) {
    it(`draws a hollow bubble in the ${tone ?? "fault"} tone: surface fill, 1 px muted-ink border, ink words, full opacity`, () => {
      render(<NativeUserMessage item={user({ failureTone: tone })} ctx={ctx} />);
      const { words, bubble, row } = bubbleOf("hello there");
      expect(bubble.dataset.bg).toBe(tokens.palette.surface);
      expect(bubble.dataset.borderWidth).toBe("1");
      expect(bubble.dataset.borderColor).toBe(tokens.palette.inkMuted);
      expect(words.dataset.color).toBe(tokens.palette.ink);
      expect(row.dataset.opacity).toBe("1");
      for (const el of [bubble, words, row]) {
        expect(Object.values(el.dataset)).not.toContain(tokens.palette.error);
      }
    });
  }

  it("puts the tone on the line: a fault in the error colour, the retry tone in ink; Retry is the accent in both", () => {
    render(<NativeUserMessage item={user()} ctx={ctx} />);
    expect(screen.getByText(defaultChatStrings.userCouldntSend).dataset.color).toBe(tokens.palette.error);
    expect(screen.getByText(defaultChatStrings.userRetry).dataset.color).toBe(tokens.palette.accent);
    cleanup();
    render(<NativeUserMessage item={user({ failureTone: "retry" })} ctx={ctx} />);
    expect(screen.getByText(defaultChatStrings.userCouldntSend).dataset.color).toBe(tokens.palette.ink);
    expect(screen.getByText(defaultChatStrings.userRetry).dataset.color).toBe(tokens.palette.accent);
  });

  it("keeps the bubble's words selectable", () => {
    render(<NativeUserMessage item={user()} ctx={ctx} />);
    expect(screen.getByText("hello there").dataset.selectable).toBe("true");
  });

  it("keeps the tapped controls' words selectable", () => {
    render(<NativeUserMessage item={user({ directive: true, tapLabels: ["Book it"] })} ctx={ctx} />);
    expect(screen.getByText("Book it").dataset.selectable).toBe("true");
    expect(screen.getByText(defaultChatStrings.userCouldntSend)).toBeTruthy();
  });

  it("leaves a sent bubble filled in ink with no border", () => {
    render(<NativeUserMessage item={user({ state: "sent" })} ctx={ctx} />);
    const { words, bubble, row } = bubbleOf("hello there");
    expect(bubble.dataset.bg).toBe(tokens.palette.ink);
    expect(bubble.dataset.borderWidth).toBeUndefined();
    expect(words.dataset.color).toBe(tokens.palette.canvas);
    expect(row.dataset.opacity).toBe("1");
  });

  it("dims only the sending bubble", () => {
    render(<NativeUserMessage item={user({ state: "sending" })} ctx={ctx} />);
    expect(bubbleOf("hello there").row.dataset.opacity).toBe("0.6");
  });
});
