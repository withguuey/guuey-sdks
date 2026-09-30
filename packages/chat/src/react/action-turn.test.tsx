// @vitest-environment jsdom
/**
 * guuey#2031 — the action turn: a tapped control's words drawn as the
 * visitor's turn in the quiet ink tint with a tap mark, never as typed speech
 * (no accent bubble), never as a control (no button), and never with machine
 * text on a visitor surface. The raw directive is offered only under the debug
 * preset, in a toggle BELOW the turn.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DefaultTap, DefaultUserMessage, type TranscriptItemContext } from "./components.js";
import { defaultChatStrings } from "../strings.js";
import type { TapItem, UserMessageItem } from "../types.js";

afterEach(cleanup);

function ctx(overrides: Partial<TranscriptItemContext> = {}): TranscriptItemContext {
  return { strings: defaultChatStrings, onToggle: vi.fn(), resolvedMounts: new Map(), onViewPhase: vi.fn(), ...overrides };
}

const DIRECTIVE = 'Call ggui_consume NOW.\n\n<ggui_directive kind="user-action">\n  <session_id>s1</session_id>\n</ggui_directive>';

const turn = (over: Partial<UserMessageItem> = {}): UserMessageItem => ({
  kind: "user",
  key: "u1",
  expanded: false,
  text: DIRECTIVE,
  state: "sent",
  retry: false,
  directive: true,
  tapLabels: ["Find me a mystery novel"],
  ...over,
});

describe("the labeled action turn (calm)", () => {
  it("shows the label verbatim in the action bubble, with a hidden tap mark and a screen-reader prefix", () => {
    const { container } = render(<DefaultUserMessage item={turn()} ctx={ctx()} />);
    const bubble = container.querySelector(".guuey-chat-action-bubble");
    expect(bubble).not.toBeNull();
    expect(bubble?.querySelector(".guuey-chat-action-label")?.textContent).toBe("Find me a mystery novel");
    const mark = bubble?.querySelector("svg.guuey-chat-action-mark");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(bubble?.querySelector(".guuey-chat-visually-hidden")?.textContent).toBe(defaultChatStrings.tappedLabelPrefix);
  });

  it("is never typed speech (no accent bubble) and never a control (no button, no toggle), and carries no directive", () => {
    const { container } = render(<DefaultUserMessage item={turn()} ctx={ctx()} />);
    expect(container.querySelector(".guuey-chat-user-bubble")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).not.toContain("ggui_consume");
  });

  it("a label is quoted, never rendered as markup", () => {
    const { container } = render(<DefaultUserMessage item={turn({ tapLabels: ["<b>x</b>"] })} ctx={ctx()} />);
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector(".guuey-chat-action-label")?.textContent).toBe("<b>x</b>");
  });

  it("a merged row draws one bubble per tap, and a null entry is the continuation line in its position", () => {
    const { container } = render(<DefaultUserMessage item={turn({ tapLabels: ["Opening hours", null, "Author events"] })} ctx={ctx()} />);
    const parts = [...container.querySelectorAll(".guuey-chat-action-label, .guuey-chat-directive-label")].map((el) => el.textContent);
    expect(parts).toEqual(["Opening hours", defaultChatStrings.directiveContinuation, "Author events"]);
  });

  it("sending wears the sending look; a failed send keeps the couldn't-send line and a Retry", () => {
    const sending = render(<DefaultUserMessage item={turn({ state: "sending" })} ctx={ctx()} />);
    expect(sending.container.querySelector(".guuey-chat-action-sending")).not.toBeNull();
    sending.unmount();
    const onRetry = vi.fn();
    const item = turn({ state: "failed", retry: true });
    render(<DefaultUserMessage item={item} ctx={ctx({ onRetry })} />);
    expect(screen.getByText(defaultChatStrings.userCouldntSend)).toBeTruthy();
    fireEvent.click(screen.getByText(defaultChatStrings.userRetry));
    expect(onRetry).toHaveBeenCalledWith(item);
  });
});

describe("the debug preset: the raw directive below the turn, the turn itself never a button", () => {
  it("offers a collapsed toggle below the bubble; expanded, it shows the directive byte for byte", () => {
    const onToggle = vi.fn();
    const collapsed = render(<DefaultUserMessage item={turn({ rawDirective: true })} ctx={ctx({ onToggle })} />);
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle.textContent).toContain(defaultChatStrings.directiveRawToggle);
    // The toggle comes AFTER the bubble in the row.
    const bubble = collapsed.container.querySelector(".guuey-chat-action-bubble");
    expect(bubble !== null && (bubble.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    expect(bubble?.closest("button")).toBeNull();
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith("u1");
    collapsed.unmount();

    const expanded = render(<DefaultUserMessage item={turn({ rawDirective: true, expanded: true })} ctx={ctx()} />);
    expect(expanded.container.querySelector(".guuey-chat-directive-raw-text")?.textContent).toBe(DIRECTIVE);
  });
});

describe("the pending tap (before its send)", () => {
  const pending = (labels: TapItem["labels"]): TapItem => ({ kind: "tap", key: "tap.t1", expanded: true, labels });

  it("draws the same bubble in the sending look, with no disclosure (no directive exists yet)", () => {
    const { container } = render(<DefaultTap item={pending(["Opening hours"])} ctx={ctx()} />);
    expect(container.querySelector(".guuey-chat-action-sending .guuey-chat-action-label")?.textContent).toBe("Opening hours");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a [null] pending tap shows the continuation copy at once", () => {
    const { container } = render(<DefaultTap item={pending([null])} ctx={ctx()} />);
    expect(container.querySelector(".guuey-chat-directive-label")?.textContent).toBe(defaultChatStrings.directiveContinuation);
  });
});

describe("the stylesheet carries the action turn's treatment", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "..", "styles.css"), "utf8");

  it("the quiet ink tint, never the accent, never an outline", () => {
    const rule = /\.guuey-chat-action-bubble\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("color-mix(in srgb, var(--guuey-chat-ink, var(--_guuey-chat-ink)) 7%, transparent)");
    expect(rule).not.toContain("accent");
    expect(rule).not.toMatch(/\bborder\s*:/);
  });

  it("the sending look is the typed bubble's (opacity 0.6), and the hidden prefix is visually hidden", () => {
    expect(css).toMatch(/\.guuey-chat-action-sending \.guuey-chat-action-bubble\s*\{\s*opacity: 0\.6;/);
    expect(css).toMatch(/\.guuey-chat-visually-hidden\s*\{[^}]*clip-path: inset\(50%\)/);
  });
});
