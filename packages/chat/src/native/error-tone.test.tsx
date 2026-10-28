// @vitest-environment jsdom
/**
 * guuey#2453 — the native error item's face follows its planned tone: `retry`
 * draws the plain surface with a neutral rule (no error tint) and the in-place
 * Retry as the only cue; an item without a tone is a fault and keeps the
 * error rule.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockStyle {
  backgroundColor?: string;
  borderLeftColor?: string;
  color?: string;
}
interface MockProps {
  children?: ReactNode;
  style?: MockStyle;
  onPress?: () => void;
}

vi.mock("react-native", () => {
  const passthrough =
    (tag: string) =>
    ({ children, style }: MockProps) =>
      createElement(
        tag,
        {
          "data-bg": style?.backgroundColor,
          "data-rule": style?.borderLeftColor,
          "data-color": style?.color,
          "data-testid": tag === "div" ? "box" : undefined,
        },
        children,
      );
  return {
    View: passthrough("div"),
    Text: passthrough("span"),
    Pressable: ({ children, onPress }: MockProps) => createElement("button", { onClick: onPress }, children),
    Image: passthrough("img"),
    ScrollView: passthrough("div"),
    Linking: { openURL: () => Promise.resolve() },
  };
});

const { NativeError, NativeUserMessage } = await import("./components.js");
const { resolveNativeTheme } = await import("./theme-native.js");
const { defaultChatStrings } = await import("../strings.js");
const { DEFAULT_CHAT_THEME } = await import("../theme.js");

import type { ErrorItem, UserMessageItem } from "../types.js";
import type { NativeTranscriptItemContext } from "./components.js";

afterEach(cleanup);

const tokens = resolveNativeTheme(DEFAULT_CHAT_THEME, "light");
const ctx: NativeTranscriptItemContext = {
  strings: defaultChatStrings,
  tokens,
  onToggle: () => undefined,
  resolvedMounts: new Map(),
  onViewPhase: () => undefined,
  onErrorAction: () => undefined,
};

const item = (tone: ErrorItem["tone"]): ErrorItem => ({
  kind: "error",
  key: "error",
  expanded: true,
  family: "transient",
  code: tone === "retry" ? "WAKE_TIMED_OUT" : "TIMEOUT",
  message: "agent responded 503",
  copy: defaultChatStrings.errorWakeTimedOut,
  verbatim: null,
  ...(tone !== undefined ? { tone } : {}),
});

describe("NativeError tone (guuey#2453)", () => {
  it("retry: the plain surface, a neutral rule, no error tint, and the in-place Retry", () => {
    expect(tokens.palette.canvasMuted).not.toBe(tokens.palette.error);
    render(<NativeError item={item("retry")} ctx={ctx} />);
    const box = screen.getAllByTestId("box")[0]!;
    expect(box.getAttribute("data-bg")).toBe(tokens.palette.surface);
    expect(box.getAttribute("data-rule")).toBe(tokens.palette.canvasMuted);
    expect(box.outerHTML).not.toContain(tokens.palette.error);
    expect(screen.getByRole("button").textContent).toBe(defaultChatStrings.userRetry);
  });

  it("an item without a tone is a fault and keeps the error rule", () => {
    render(<NativeError item={item(undefined)} ctx={ctx} />);
    expect(screen.getAllByTestId("box")[0]!.getAttribute("data-rule")).toBe(tokens.palette.error);
  });
});

describe("NativeUserMessage refused bubble tone (guuey#2453)", () => {
  const failed = (failureTone?: "retry"): UserMessageItem => ({
    kind: "user",
    key: "u0",
    expanded: true,
    text: "hello",
    directive: false,
    state: "failed",
    retry: true,
    failureLine: defaultChatStrings.errorWakeTimedOut,
    ...(failureTone !== undefined ? { failureTone } : {}),
  });
  const lineColor = () => screen.getByText(defaultChatStrings.errorWakeTimedOut).getAttribute("data-color");

  it("retry: the line in the plain text colour, never the error colour, and its Retry", () => {
    expect(tokens.palette.ink).not.toBe(tokens.palette.error);
    render(<NativeUserMessage item={failed("retry")} ctx={ctx} />);
    expect(lineColor()).toBe(tokens.palette.ink);
    expect(screen.getByRole("button").textContent).toBe(defaultChatStrings.userRetry);
  });

  it("without a tone the line keeps the error colour", () => {
    render(<NativeUserMessage item={failed()} ctx={ctx} />);
    expect(lineColor()).toBe(tokens.palette.error);
  });
});
