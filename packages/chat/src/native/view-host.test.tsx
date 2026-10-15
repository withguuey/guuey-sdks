// @vitest-environment jsdom
/**
 * The native view host, rendered. React Native's primitives are swapped for
 * DOM stand-ins (the host and the kit's placeholder only use View/Text), and
 * the WebView host is a fake that records its props, so the slot's wiring —
 * what it mounts, its height, its phase reports, its action relay — is
 * observable without a device.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpToolCallResult, ResolvedViewMount, ViewHostPhase } from "@guuey/mcp-apps-host";

vi.mock("react-native", () => {
  const passthrough =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return {
    View: passthrough("div"),
    Text: passthrough("span"),
    Pressable: passthrough("button"),
    Image: passthrough("img"),
    Linking: { openURL: () => Promise.resolve() },
  };
});

const { createNativeViewHost } = await import("./view-host.js");
const { resolveNativeTheme } = await import("./theme-native.js");
const { defaultChatStrings } = await import("../strings.js");
const { DEFAULT_CHAT_THEME } = await import("../theme.js");

import type { ViewMountItem } from "../types.js";
import type { NativeTranscriptItemContext } from "./components.js";
import type { NativeMcpAppFrameProps } from "./view-host.js";

afterEach(cleanup);

const INLINE: ResolvedViewMount = {
  channel: "inline",
  resource: { uri: "ui://app/card", mimeType: "text/html", text: "<p>card</p>" },
};

function viewItem(over: Partial<ViewMountItem> = {}): ViewMountItem {
  return {
    kind: "view",
    key: "view:1",
    expanded: true,
    mount: INLINE,
    channel: "inline",
    phase: "negotiating",
    label: defaultChatStrings.viewNegotiating,
    diagnosis: null,
    attribution: null,
    toolTitle: "Card",
    actionScope: "ui://app/card",
    ...over,
  };
}

function context(
  resolvedMounts: NativeTranscriptItemContext["resolvedMounts"] = new Map(),
): NativeTranscriptItemContext & { phases: [string, ViewHostPhase][] } {
  const phases: [string, ViewHostPhase][] = [];
  return {
    phases,
    strings: defaultChatStrings,
    tokens: resolveNativeTheme(DEFAULT_CHAT_THEME, "light"),
    onToggle: () => undefined,
    resolvedMounts,
    onViewPhase: (key, phase) => phases.push([key, phase]),
  };
}

/** A fake WebView host that records the props of its latest render. */
function fakeFrame() {
  const seen: { props: NativeMcpAppFrameProps | null; renders: number } = { props: null, renders: 0 };
  function FakeMcpAppIframe(props: NativeMcpAppFrameProps): ReactNode {
    seen.props = props;
    seen.renders += 1;
    return createElement("div", { "data-testid": "frame" });
  }
  return { seen, FakeMcpAppIframe };
}

describe("createNativeViewHost", () => {
  it("mounts inline content in the injected frame at the initial height", () => {
    const { seen, FakeMcpAppIframe } = fakeFrame();
    const View = createNativeViewHost({ McpAppIframe: FakeMcpAppIframe });
    render(createElement(View, { item: viewItem(), ctx: context() }));
    expect(screen.getByTestId("frame")).toBeTruthy();
    expect(seen.props?.resource).toEqual({ uri: "ui://app/card", mimeType: "text/html", text: "<p>card</p>" });
    expect(seen.props?.containerDimensions).toEqual({ height: 360 });
  });

  it("mounts a locator's resolution, and shows the labeled placeholder while it resolves", () => {
    const { seen, FakeMcpAppIframe } = fakeFrame();
    const View = createNativeViewHost({ McpAppIframe: FakeMcpAppIframe });
    const locator = viewItem({ mount: { channel: "locator", resourceUri: "ui://app/card" } });
    const { rerender } = render(createElement(View, { item: locator, ctx: context() }));
    expect(screen.queryByTestId("frame")).toBeNull();
    expect(screen.getByText(defaultChatStrings.viewNegotiating)).toBeTruthy();
    rerender(createElement(View, { item: locator, ctx: context(new Map([["view:1", INLINE]])) }));
    expect(screen.getByTestId("frame")).toBeTruthy();
    expect(seen.props?.resource).toMatchObject({ text: "<p>card</p>" });
  });

  it("never mounts a bare uri — the placeholder renders instead", () => {
    const { FakeMcpAppIframe } = fakeFrame();
    const View = createNativeViewHost({ McpAppIframe: FakeMcpAppIframe });
    const bare = viewItem({ mount: { channel: "inline", resource: { uri: "https://example.com/app" } } });
    render(createElement(View, { item: bare, ctx: context() }));
    expect(screen.queryByTestId("frame")).toBeNull();
    expect(screen.getByText(defaultChatStrings.viewSandboxUnavailable)).toBeTruthy();
  });

  it("renders the expired label for a dead locator", () => {
    const { FakeMcpAppIframe } = fakeFrame();
    const View = createNativeViewHost({ McpAppIframe: FakeMcpAppIframe });
    const locator = viewItem({ mount: { channel: "locator", resourceUri: "ui://app/card" } });
    render(createElement(View, { item: locator, ctx: context(new Map([["view:1", "expired"]])) }));
    expect(screen.queryByTestId("frame")).toBeNull();
    expect(screen.getByText(defaultChatStrings.viewExpired)).toBeTruthy();
  });

  it("clamps reported heights and reports connected once", () => {
    const { seen, FakeMcpAppIframe } = fakeFrame();
    const View = createNativeViewHost({ McpAppIframe: FakeMcpAppIframe, minHeight: 100, maxHeight: 500 });
    const ctx = context();
    render(createElement(View, { item: viewItem(), ctx }));
    act(() => seen.props?.onSizeChanged?.({ height: 9000 }));
    expect(seen.props?.containerDimensions).toEqual({ height: 500 });
    act(() => seen.props?.onSizeChanged?.({ height: 20 }));
    expect(seen.props?.containerDimensions).toEqual({ height: 100 });
    expect(ctx.phases).toEqual([["view:1", "connected"]]);
  });

  it("reports no-handshake when the frame fails before connecting", () => {
    const { seen, FakeMcpAppIframe } = fakeFrame();
    const View = createNativeViewHost({ McpAppIframe: FakeMcpAppIframe });
    const ctx = context();
    render(createElement(View, { item: viewItem(), ctx }));
    act(() => seen.props?.onError?.({ kind: "bootstrap" }));
    expect(ctx.phases).toEqual([["view:1", "no-handshake"]]);
    act(() => seen.props?.onLifecycle?.({ state: "code-ready" }));
    expect(ctx.phases).toEqual([
      ["view:1", "no-handshake"],
      ["view:1", "connected"],
    ]);
  });

  it("relays a tool call through onUiAction, scoped to the item's actionScope", async () => {
    const { seen, FakeMcpAppIframe } = fakeFrame();
    const answer: McpToolCallResult = { content: [{ type: "text", text: "done" }] };
    const onUiAction = vi.fn(() => Promise.resolve(answer));
    const View = createNativeViewHost({ McpAppIframe: FakeMcpAppIframe, onUiAction });
    const ctx = context();
    render(createElement(View, { item: viewItem({ actionScope: "ui://app/scope" }), ctx }));
    const result = await act(() => seen.props?.onToolCall?.("submit", { choice: "a" }));
    expect(onUiAction).toHaveBeenCalledWith({
      resourceUri: "ui://app/scope",
      name: "submit",
      arguments: { choice: "a" },
    });
    expect(result).toEqual(answer);
    expect(ctx.phases).toEqual([["view:1", "connected"]]);
  });
});
