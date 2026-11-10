// @vitest-environment jsdom
/**
 * guuey#2368 leg 3 — a native code fence carries a copy control when the host
 * gives the kit a clipboard (`onCopyText`), the twin of the web `CodeFence`
 * button: the same words and labels, the same reset, and a failed copy keeps
 * "Copy". Without `onCopyText` no control is drawn, so a host with no
 * clipboard shows no dead button.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRichText } from "@silverprotocol/richtext";

interface MockProps {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
}

vi.mock("react-native", () => {
  const passthrough =
    (tag: string) =>
    ({ children }: MockProps) =>
      createElement(tag, null, children);
  return {
    View: passthrough("div"),
    Text: passthrough("span"),
    Pressable: ({ children, onPress, accessibilityLabel }: MockProps) =>
      createElement("button", { onClick: onPress, "aria-label": accessibilityLabel }, children),
    Image: passthrough("img"),
    ScrollView: passthrough("div"),
    Linking: { openURL: () => Promise.resolve() },
  };
});

const { NativeMarkdown } = await import("./markdown.js");
const { NativeText } = await import("./components.js");
const { resolveNativeTheme } = await import("./theme-native.js");
const { defaultChatStrings } = await import("../strings.js");
const { DEFAULT_CHAT_THEME } = await import("../theme.js");

import type { TextItem } from "../types.js";
import type { NativeTranscriptItemContext } from "./components.js";

const tokens = resolveNativeTheme(DEFAULT_CHAT_THEME, "light");
const INK = tokens.palette.ink;

/** A multi-line fence whose code ends in a blank line, so the exact text is load-bearing. */
const MD = "Here:\n\n```ts\nconst a = 1;\n\n  return a;\n\n```\n";
/** The fence text exactly as the shared parser yields it: what web's CodeFence copies too. */
function fenceCode(md: string): string {
  const block = parseRichText(md).find((b) => b.type === "code-fence");
  if (block === undefined || block.type !== "code-fence") throw new Error("fixture has no code fence");
  return block.code;
}

function renderFence(md: string, onCopyText?: (text: string) => Promise<void>) {
  return render(createElement(NativeMarkdown, { text: md, color: INK, tokens, onCopyText }));
}

/** Settle the copy promise and the state update it schedules. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("native code fence copy control (guuey#2368)", () => {
  it("draws no control when the host gives no onCopyText", () => {
    renderFence(MD);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Copy")).toBeNull();
  });

  it("a press hands the host the fence text exactly, newlines and trailing blank line kept", async () => {
    const onCopyText = vi.fn(async (_text: string) => undefined);
    renderFence(MD, onCopyText);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await flush();
    expect(onCopyText).toHaveBeenCalledTimes(1);
    const copied = onCopyText.mock.calls[0]?.[0];
    expect(copied).toBe(fenceCode(MD));
    // Not vacuous: the parsed code holds the inner blank line and the indent.
    expect(copied).toContain("const a = 1;\n\n  return a;");
  });

  it("a json fence is copied as written, never pretty-printed (web parity)", async () => {
    const md = '```json\n{"a":1,"b":[2,3]}\n```\n';
    const onCopyText = vi.fn(async (_text: string) => undefined);
    renderFence(md, onCopyText);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await flush();
    expect(onCopyText.mock.calls[0]?.[0]).toBe(fenceCode(md));
    expect(onCopyText.mock.calls[0]?.[0]).toContain('{"a":1,"b":[2,3]}');
  });

  it("a copy that lands shows Copied, then returns to Copy after the web interval", async () => {
    renderFence(MD, async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await flush();
    expect(screen.getByRole("button", { name: "Copied" }).textContent).toBe("Copied");
    act(() => {
      vi.advanceTimersByTime(1599);
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button", { name: "Copy code" }).textContent).toBe("Copy");
  });

  it("a failed copy keeps Copy (truthful, as web does)", async () => {
    renderFence(MD, () => Promise.reject(new Error("no clipboard access")));
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await flush();
    expect(screen.getByRole("button", { name: "Copy code" }).textContent).toBe("Copy");
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("the host's write is called inside the press, before any await (a web clipboard may need the gesture)", () => {
    const onCopyText = vi.fn(async (_text: string) => undefined);
    renderFence(MD, onCopyText);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    // No flush: the call must already have happened synchronously.
    expect(onCopyText).toHaveBeenCalledTimes(1);
  });

  it("a host that throws synchronously instead of rejecting also keeps Copy, with nothing thrown from the press", async () => {
    renderFence(MD, () => {
      throw new Error("clipboard module missing");
    });
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Copy code" }))).not.toThrow();
    await flush();
    await flush();
    expect(screen.getByRole("button", { name: "Copy code" }).textContent).toBe("Copy");
  });

  it("unmounting while Copied is showing leaves no reset timer behind", async () => {
    const { unmount } = renderFence(MD, async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await flush();
    // Precondition: the reset is scheduled, so the check below is not vacuous.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the transcript context carries onCopyText to the answer's fences (guuey#2368)", () => {
  const item: TextItem = {
    key: "text:1",
    expanded: true,
    kind: "text",
    text: MD,
    markdown: true,
    streaming: false,
    stopped: false,
  };
  const base: NativeTranscriptItemContext = {
    strings: defaultChatStrings,
    tokens,
    onToggle: () => undefined,
    resolvedMounts: new Map(),
    onViewPhase: () => undefined,
  };

  it("an answer bubble draws the control when the context has onCopyText", () => {
    render(createElement(NativeText, { item, ctx: { ...base, onCopyText: async () => undefined } }));
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  });

  it("and draws none when it does not", () => {
    render(createElement(NativeText, { item, ctx: base }));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
