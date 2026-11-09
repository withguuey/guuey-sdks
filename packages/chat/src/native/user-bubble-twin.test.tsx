// @vitest-environment jsdom
/**
 * The SENT user bubble is one face on both tiers (`USER_BUBBLE_FACE`): the ink
 * fill under canvas words. Native reads the palette keys; the web stylesheet's
 * `.guuey-chat-user-bubble` reads the same tokens through both theming
 * channels. A change to either tier, or to the face, goes red here. The face
 * also holds AA text contrast in every shipped palette and mode.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockStyle {
  color?: string;
  backgroundColor?: string;
}
interface MockProps {
  children?: ReactNode;
  style?: MockStyle;
}

function styleData(style: MockStyle | undefined): Record<string, string | undefined> {
  return { "data-color": style?.color, "data-bg": style?.backgroundColor };
}

vi.mock("react-native", () => ({
  View: ({ children, style }: MockProps) => createElement("div", styleData(style), children),
  Text: ({ children, style }: MockProps) => createElement("span", styleData(style), children),
  Pressable: ({ children }: MockProps) => createElement("button", {}, children),
  Image: ({ children }: MockProps) => createElement("img", {}, children),
  ScrollView: ({ children }: MockProps) => createElement("div", {}, children),
  Linking: { openURL: () => Promise.resolve() },
}));

const { NativeUserMessage } = await import("./components.js");
const { resolveNativeTheme } = await import("./theme-native.js");
const { defaultChatStrings } = await import("../strings.js");
const { DEFAULT_CHAT_THEME, GUUEY_CHAT_THEME, USER_BUBBLE_FACE, contrastRatio, parseOpaqueColor } =
  await import("../theme.js");

import type { GuueyChatPalette } from "../theme.js";
import type { UserMessageItem } from "../types.js";
import type { NativeTranscriptItemContext } from "./components.js";

afterEach(cleanup);

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../styles.css"),
  "utf8"
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The one block whose selector list is exactly `selector`. */
function blockFor(selector: string): string {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const hits: string[] = [];
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    if (
      (m[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .includes(selector)
    )
      hits.push(m[2] ?? "");
  }
  expect(hits).toHaveLength(1);
  return hits[0] ?? "";
}

function declaration(block: string, property: string): string {
  return new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(block)?.[1]?.trim() ?? "";
}

/** A palette token as the stylesheet reads it: the host channel over the stamped one. */
function webRef(token: keyof GuueyChatPalette): string {
  const name = token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `var(--guuey-chat-${name}, var(--_guuey-chat-${name}))`;
}

const THEMES = [
  ["default", DEFAULT_CHAT_THEME],
  ["guuey", GUUEY_CHAT_THEME],
] as const;
const MODES = ["light", "dark"] as const;

function sent(text: string): UserMessageItem {
  return {
    key: "user:1",
    expanded: true,
    kind: "user",
    text,
    state: "sent",
    retry: false,
    directive: false,
  };
}

describe("the sent user bubble, both tiers", () => {
  it("web: the stylesheet paints USER_BUBBLE_FACE's tokens, through both theming channels", () => {
    const block = blockFor(".guuey-chat-user-bubble");
    expect(declaration(block, "background")).toBe(webRef(USER_BUBBLE_FACE.fill));
    expect(declaration(block, "color")).toBe(webRef(USER_BUBBLE_FACE.ink));
    expect(block).not.toMatch(/--guuey-chat-(accent|on-accent)\b/);
  });

  for (const [name, theme] of THEMES) {
    for (const mode of MODES) {
      it(`native (${name} ${mode}): the bubble fills with USER_BUBBLE_FACE.fill and its words take USER_BUBBLE_FACE.ink`, () => {
        const tokens = resolveNativeTheme(theme, mode);
        const ctx: NativeTranscriptItemContext = {
          strings: defaultChatStrings,
          tokens,
          onToggle: () => undefined,
          resolvedMounts: new Map(),
          onViewPhase: () => undefined,
        };
        render(<NativeUserMessage item={sent("hello there")} ctx={ctx} />);
        const words = screen.getByText("hello there");
        expect(words.parentElement?.dataset.bg).toBe(tokens.palette[USER_BUBBLE_FACE.fill]);
        expect(words.dataset.color).toBe(tokens.palette[USER_BUBBLE_FACE.ink]);
      });

      it(`the face holds AA text contrast (4.5:1) in ${name} ${mode}`, () => {
        const palette = resolveNativeTheme(theme, mode).palette;
        const fill = parseOpaqueColor(palette[USER_BUBBLE_FACE.fill]);
        const ink = parseOpaqueColor(palette[USER_BUBBLE_FACE.ink]);
        expect(fill).not.toBeNull();
        expect(ink).not.toBeNull();
        if (fill === null || ink === null) return;
        expect(contrastRatio(fill, ink)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
