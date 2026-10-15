// @vitest-environment jsdom
/**
 * guuey#2355 — the native closed-conversation banner and the transcript that
 * draws it: the agent's message verbatim, and a "Start a new conversation"
 * control only when the host wires one. React Native's primitives are DOM
 * stand-ins, as in `view-host.test.tsx`.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  const passthrough =
    (tag: string) =>
    ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
      createElement(tag, accessibilityRole === "summary" ? { role: "status" } : null, children);
  return {
    View: passthrough("div"),
    Text: passthrough("span"),
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
      createElement("button", { type: "button", onClick: onPress }, children),
    Image: passthrough("img"),
    Linking: { openURL: () => Promise.resolve() },
  };
});

const { NativeThreadClosedBanner } = await import("./components.js");
const { resolveNativeTheme } = await import("./theme-native.js");
const { defaultChatStrings } = await import("../strings.js");
const { DEFAULT_CHAT_THEME } = await import("../theme.js");

afterEach(cleanup);

const tokens = resolveNativeTheme(DEFAULT_CHAT_THEME, "light");
const closed = { code: "app:CHAT_FULL", message: "This chat is **full**. <b>Start</b> a new one." };

describe("NativeThreadClosedBanner", () => {
  it("shows the title and the agent's message verbatim", () => {
    render(<NativeThreadClosedBanner closed={closed} strings={defaultChatStrings} tokens={tokens} />);
    expect(screen.getByText(defaultChatStrings.threadClosedTitle)).toBeTruthy();
    expect(screen.getByText(closed.message)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers Start a new conversation when the host wires it", () => {
    const onStartNew = vi.fn();
    render(
      <NativeThreadClosedBanner closed={closed} strings={defaultChatStrings} tokens={tokens} onStartNewConversation={onStartNew} />,
    );
    fireEvent.click(screen.getByRole("button", { name: defaultChatStrings.threadClosedStartNew }));
    expect(onStartNew).toHaveBeenCalledTimes(1);
  });
});
