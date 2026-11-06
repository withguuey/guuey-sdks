// @vitest-environment jsdom
/**
 * A user send that did not go: the bubble holds the reader's own words, so it
 * is calm in both tones, hollow (surface fill, a 1 px muted-ink border, ink
 * words, full opacity), and its words stay selectable. The tone lives on the
 * line under it: a fault keeps the error colour, the retry tone draws muted
 * ink. Retry is a chip in the theme's chip face in both tones (the accent fill
 * under on-accent words when the accent stands out on the canvas, else surface
 * fill, ink edge and ink words; 32pt tall at the default scale and growing
 * with it; dimmed while pressed).
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
  minHeight?: number;
  lineHeight?: number;
  paddingTop?: number;
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
    "data-line-height": style?.lineHeight === undefined ? undefined : String(style.lineHeight),
    "data-padding-top": style?.paddingTop === undefined ? undefined : String(style.paddingTop),
  };
}

vi.mock("react-native", () => ({
  View: ({ children, style }: MockProps) => createElement("div", styleData(style), children),
  Text: ({ children, style, selectable }: MockProps) =>
    createElement("span", { ...styleData(style), "data-selectable": String(selectable === true) }, children),
  Pressable: ({
    children,
    onPress,
    style,
  }: Omit<MockProps, "style"> & { style?: MockStyle | ((state: { pressed: boolean }) => MockStyle) }) => {
    const at = (pressed: boolean): MockStyle | undefined => (typeof style === "function" ? style({ pressed }) : style);
    return createElement(
      "button",
      {
        onClick: onPress,
        ...styleData(at(false)),
        "data-min-height": at(false)?.minHeight === undefined ? undefined : String(at(false)?.minHeight),
        "data-pressed-opacity": at(true)?.opacity === undefined ? undefined : String(at(true)?.opacity),
      },
      children,
    );
  },
  Image: ({ children }: MockProps) => createElement("img", {}, children),
  ScrollView: ({ children }: MockProps) => createElement("div", {}, children),
  Linking: { openURL: () => Promise.resolve() },
}));

const { NativeUserMessage } = await import("./components.js");
const { resolveNativeTheme } = await import("./theme-native.js");
const { defaultChatStrings } = await import("../strings.js");
const { DEFAULT_CHAT_THEME, GUUEY_CHAT_THEME } = await import("../theme.js");

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

  for (const tone of [undefined, "retry"] as const) {
    it(`puts the ${tone ?? "fault"} tone on the line and, on an accent that stands out, makes Retry an accent chip: accent fill, on-accent words, no edge`, () => {
      render(<NativeUserMessage item={user({ failureTone: tone })} ctx={ctx} />);
      const label = screen.getByText(defaultChatStrings.userCouldntSend);
      expect(label.dataset.color).toBe(tone === "retry" ? tokens.palette.inkMuted : tokens.palette.error);
      const words = screen.getByText(defaultChatStrings.userRetry);
      expect(words.dataset.color).toBe(tokens.palette.onAccent);
      const chip = words.closest("button");
      expect(chip?.dataset.bg).toBe(tokens.palette.accent);
      expect(chip?.dataset.borderWidth).toBe("0");
    });
  }

  it("on a light accent that does not stand out (guuey light), Retry takes the hollow face: surface fill, 1px ink edge, ink words", () => {
    const guuey = resolveNativeTheme(GUUEY_CHAT_THEME, "light");
    render(<NativeUserMessage item={user()} ctx={{ ...ctx, tokens: guuey }} />);
    const words = screen.getByText(defaultChatStrings.userRetry);
    expect(words.dataset.color).toBe(guuey.palette.ink);
    const chip = words.closest("button");
    expect(chip?.dataset.bg).toBe(guuey.palette.surface);
    expect(chip?.dataset.borderWidth).toBe("1");
    expect(chip?.dataset.borderColor).toBe(guuey.palette.ink);
  });

  it("on guuey dark the slime stands out on the canvas, so Retry is the accent chip again", () => {
    const guuey = resolveNativeTheme(GUUEY_CHAT_THEME, "dark");
    render(<NativeUserMessage item={user()} ctx={{ ...ctx, tokens: guuey }} />);
    const chip = screen.getByText(defaultChatStrings.userRetry).closest("button");
    expect(chip?.dataset.bg).toBe(guuey.palette.accent);
  });

  it("the row's line and the chip grow with the type scale, the reason's first line still centred on the chip", () => {
    const big = resolveNativeTheme({ ...DEFAULT_CHAT_THEME, typography: { ...DEFAULT_CHAT_THEME.typography, scale: 2 } }, "light");
    render(<NativeUserMessage item={user()} ctx={{ ...ctx, tokens: big }} />);
    const words = screen.getByText(defaultChatStrings.userRetry);
    const line = Number(words.dataset.lineHeight);
    expect(line).toBeGreaterThanOrEqual((big.fontSize - 2) * 1.3);
    const chip = words.closest("button");
    const height = Number(chip?.dataset.minHeight);
    expect(height).toBeGreaterThan(32);
    const label = screen.getByText(defaultChatStrings.userCouldntSend);
    expect(Number(label.dataset.lineHeight)).toBe(line);
    expect(Number(label.dataset.paddingTop)).toBe((height - line) / 2);
  });

  it("the Retry chip is 32pt tall, full opacity at rest and 0.85 while pressed", () => {
    render(<NativeUserMessage item={user()} ctx={ctx} />);
    const chip = screen.getByText(defaultChatStrings.userRetry).closest("button");
    expect(chip?.dataset.minHeight).toBe("32");
    expect(screen.getByText(defaultChatStrings.userCouldntSend).dataset.paddingTop).toBe("7");
    expect(chip?.dataset.opacity).toBe("1");
    expect(chip?.dataset.pressedOpacity).toBe("0.85");
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
