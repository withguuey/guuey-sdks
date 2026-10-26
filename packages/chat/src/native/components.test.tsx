// @vitest-environment jsdom
/**
 * guuey#2368 leg 1 — the native data-result preview is READABLE: it renders
 * inside a capped SCROLL box (the web twin's capped <pre>), never a clipped
 * overflow:"hidden" View that cut every preview past ~220pt with no way to
 * see the rest.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockStyle {
  maxHeight?: number;
  overflow?: string;
  flexShrink?: number;
}
interface MockProps {
  children?: ReactNode;
  style?: MockStyle;
  nestedScrollEnabled?: boolean;
  onPress?: () => void;
}

vi.mock("react-native", () => {
  const passthrough =
    (tag: string) =>
    ({ children, style }: MockProps) =>
      createElement(
        tag,
        { "data-max-height": style?.maxHeight, "data-overflow": style?.overflow, "data-flex-shrink": style?.flexShrink },
        children,
      );
  return {
    View: passthrough("div"),
    Text: passthrough("span"),
    Pressable: ({ children, style, onPress }: MockProps) =>
      createElement("button", { onClick: onPress, "data-flex-shrink": style?.flexShrink }, children),
    Image: passthrough("img"),
    ScrollView: ({ children, style, nestedScrollEnabled }: MockProps) =>
      createElement(
        "div",
        {
          "data-testid": "scroll",
          "data-max-height": style?.maxHeight,
          "data-nested": String(nestedScrollEnabled === true),
        },
        children,
      ),
    Linking: { openURL: () => Promise.resolve() },
  };
});

const { NativeDataResult, NativeUserMessage } = await import("./components.js");
const { resolveNativeTheme } = await import("./theme-native.js");
const { defaultChatStrings } = await import("../strings.js");
const { DEFAULT_CHAT_THEME } = await import("../theme.js");

import type { DataResultItem, UserMessageItem } from "../types.js";
import type { NativeTranscriptItemContext } from "./components.js";

afterEach(cleanup);

const ctx: NativeTranscriptItemContext = {
  strings: defaultChatStrings,
  tokens: resolveNativeTheme(DEFAULT_CHAT_THEME, "light"),
  onToggle: () => undefined,
  resolvedMounts: new Map(),
  onViewPhase: () => undefined,
};

const LONG = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");

function result(over: Partial<DataResultItem> = {}): DataResultItem {
  return {
    key: "tool:1:result",
    expanded: true,
    kind: "data-result",
    preview: LONG,
    byteCount: LONG.length,
    state: "small",
    showBytes: false,
    ...over,
  };
}

describe("NativeDataResult (guuey#2368)", () => {
  it("renders the preview inside a capped, nested-scrollable scroll box", () => {
    render(createElement(NativeDataResult, { item: result(), ctx }));
    const box = screen.getByTestId("scroll");
    expect(box.getAttribute("data-max-height")).toBe("220");
    expect(box.getAttribute("data-nested")).toBe("true");
    expect(box.textContent).toContain("line 79");
  });

  it("never clips the preview with an overflow-hidden container", () => {
    const { container } = render(createElement(NativeDataResult, { item: result(), ctx }));
    expect(container.querySelector('[data-overflow="hidden"]')).toBeNull();
  });

  it("keeps the empty and byte-only faces out of the scroll box", () => {
    render(createElement(NativeDataResult, { item: result({ state: "empty", preview: null }), ctx }));
    expect(screen.queryByTestId("scroll")).toBeNull();
  });

  it("opens a cut result to its full text with Show all, and back with Show less (guuey#2367)", () => {
    const full = `${LONG}\nthe tail line`;
    render(createElement(NativeDataResult, { item: result({ full }), ctx }));
    expect(screen.getByTestId("scroll").textContent).not.toContain("the tail line");
    fireEvent.click(screen.getByText(defaultChatStrings.showAll));
    expect(screen.getByTestId("scroll").textContent).toBe(full);
    fireEvent.click(screen.getByText(defaultChatStrings.showLess));
    expect(screen.getByTestId("scroll").textContent).toBe(LONG);
  });

  it("shows no Show all when the result carries no full text (an N-1 plan)", () => {
    render(createElement(NativeDataResult, { item: result(), ctx }));
    expect(screen.queryByText(defaultChatStrings.showAll)).toBeNull();
  });

  it("highlights a JSON result and keeps its text exact", () => {
    const json = '{\n  "a": 1\n}';
    const { container } = render(createElement(NativeDataResult, { item: result({ preview: json, lang: "json" }), ctx }));
    expect(screen.getByTestId("scroll").textContent).toBe(json);
    const runs = Array.from(container.querySelectorAll("span span")).map((n) => n.textContent);
    expect(runs).toContain('"a"');
  });
});

describe("NativeUserMessage failed send (guuey#2604)", () => {
  const failed = (over: Partial<UserMessageItem> = {}): UserMessageItem => ({
    kind: "user",
    key: "u0",
    expanded: true,
    text: "hello?",
    directive: false,
    state: "failed",
    retry: true,
    ...over,
  });

  it("draws the refusal's own line with Retry when the plan carries one", () => {
    const onRetry = vi.fn();
    render(
      createElement(NativeUserMessage, {
        item: failed({ failureLine: defaultChatStrings.errorPodSaturated }),
        ctx: { ...ctx, onRetry },
      }),
    );
    expect(screen.getByText(defaultChatStrings.errorPodSaturated)).toBeTruthy();
    expect(screen.queryByText(defaultChatStrings.userCouldntSend)).toBeNull();
    fireEvent.click(screen.getByText(defaultChatStrings.userRetry));
    expect(onRetry).toHaveBeenCalled();
  });

  it("a long reason wraps and Retry keeps its size: the line shrinks, the Retry button never does", () => {
    const line = "High demand right now. Please try again in a moment, or come back a little later today.";
    render(createElement(NativeUserMessage, { item: failed({ failureLine: line }), ctx }));
    expect(screen.getByText(line).getAttribute("data-flex-shrink")).toBe("1");
    expect(screen.getByText(defaultChatStrings.userRetry).closest("button")?.getAttribute("data-flex-shrink")).toBe("0");
  });

  it("falls back to the couldn't-send line when the plan carries none", () => {
    render(createElement(NativeUserMessage, { item: failed(), ctx }));
    expect(screen.getByText(defaultChatStrings.userCouldntSend)).toBeTruthy();
  });
});
