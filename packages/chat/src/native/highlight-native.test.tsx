// @vitest-environment jsdom
/**
 * guuey#2368 leg 2 — native code fences are highlighted from the shared
 * platform-free model (guuey#2367), and the rendered text is exactly the code.
 */
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockProps {
  children?: ReactNode;
  style?: { color?: string; fontWeight?: string };
}

vi.mock("react-native", () => {
  const passthrough =
    (tag: string) =>
    ({ children, style }: MockProps) =>
      createElement(tag, { "data-color": style?.color, "data-weight": style?.fontWeight }, children);
  return {
    View: passthrough("div"),
    Text: passthrough("span"),
    Pressable: passthrough("button"),
    Image: passthrough("img"),
    ScrollView: passthrough("div"),
    Linking: { openURL: () => Promise.resolve() },
  };
});

const { NativeHighlightedCode, nativeHighlightStyle } = await import("./highlight-native.js");
const { NativeMarkdown } = await import("./markdown.js");
const { resolveNativeTheme } = await import("./theme-native.js");
const { DEFAULT_CHAT_THEME } = await import("../theme.js");

afterEach(cleanup);

const tokens = resolveNativeTheme(DEFAULT_CHAT_THEME, "light");
const INK = tokens.palette.ink;

describe("NativeHighlightedCode (guuey#2368)", () => {
  it("renders exactly the code, whitespace and newlines included", () => {
    const code = 'const a = "x";\n\n  // note\r\nreturn 42;\n';
    const { container } = render(
      createElement(NativeHighlightedCode, { code, lang: "ts", color: INK, fontSize: 13, tokens }),
    );
    expect(container.textContent).toBe(code);
  });

  it("follows the shared syntax map: keywords/keys ink 600, strings/numbers link, comments muted italic", () => {
    const p = tokens.palette;
    expect(nativeHighlightStyle("keyword", tokens, INK)).toEqual({ color: INK, fontWeight: "600" });
    expect(nativeHighlightStyle("key", tokens, INK)).toEqual({ color: INK, fontWeight: "600" });
    expect(nativeHighlightStyle("string", tokens, INK)).toEqual({ color: p.link ?? INK });
    expect(nativeHighlightStyle("number", tokens, INK)).toEqual({ color: p.link ?? INK });
    expect(nativeHighlightStyle("comment", tokens, INK)).toEqual({ color: p.inkMuted, fontStyle: "italic" });
    expect(nativeHighlightStyle("punctuation", tokens, INK)).toEqual({ color: p.inkMuted });
    expect(nativeHighlightStyle("plain", tokens, INK)).toEqual({ color: INK });
  });

  it("styles a keyword run from the map", () => {
    const { container } = render(
      createElement(NativeHighlightedCode, { code: "const a = 1", lang: "ts", color: INK, fontSize: 13, tokens }),
    );
    const keyword = Array.from(container.querySelectorAll("span span")).find((s) => s.textContent === "const");
    expect(keyword?.getAttribute("data-color")).toBe(nativeHighlightStyle("keyword", tokens, INK).color);
    expect(keyword?.getAttribute("data-weight")).toBe("600");
  });

  it("leaves an unknown language as plain ink text", () => {
    const { container } = render(
      createElement(NativeHighlightedCode, { code: "SELECT 1", lang: "sql", color: INK, fontSize: 13, tokens }),
    );
    expect(container.querySelectorAll("span span")).toHaveLength(0);
    expect(container.textContent).toBe("SELECT 1");
  });
});

describe("NativeMarkdown code fences (guuey#2368)", () => {
  it("highlights a fenced block by its info string", () => {
    const { container } = render(
      createElement(NativeMarkdown, { text: "```json\n{\"a\": 1}\n```", color: INK, tokens }),
    );
    const coloured = Array.from(container.querySelectorAll("span span")).map((s) => s.textContent);
    expect(coloured).toContain('"a"');
    expect(coloured).toContain("1");
  });
});
