// @vitest-environment jsdom
/**
 * `<Transcript>` structure: theme projection, windowing (DOM capped, keys
 * stable across the window edge), component overrides, and the status
 * line's placement. Scroll PHYSICS (stick-to-bottom, release, jump,
 * resize re-anchor) are real-browser behavior — the e2e sdk project owns
 * them (jsdom has no layout).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen , cleanup } from "@testing-library/react";
import { GUUEY_CHAT_THEME } from "../theme.js";
import { calmPolicy } from "../policy.js";
import { planTranscript } from "../plan.js";
import type { TranscriptInputs, ToolItem, UserMessageItem } from "../types.js";
import { Transcript } from "./transcript.js";
import { viewNeverHandshakes } from "../corpus/fixtures.js";
import { ANCHOR_GAP_PX } from "./scroll-anchor.js";
import type { TranscriptItemContext } from "./components.js";

afterEach(cleanup);

function planOf(messageCount: number) {
  const inputs: TranscriptInputs = {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: Array.from({ length: messageCount }, (_, i) =>
      i % 2 === 0
        ? ({ role: "user", text: `question ${i}` } as const)
        : ({ role: "assistant", text: `answer ${i}` } as const),
    ),
  };
  return planTranscript(inputs, calmPolicy());
}

const noopCtx = {
  onToggle: () => {},
  resolvedMounts: new Map<string, never>(),
  onViewPhase: () => {},
};

describe("Transcript", () => {
  it("projects the theme as INTERNAL --_guuey-chat-* stamps, leaving the documented channel to the host (guuey#521)", () => {
    const { container } = render(
      <Transcript plan={planOf(2)} theme={GUUEY_CHAT_THEME} mode="dark" {...noopCtx} />,
    );
    const root = container.querySelector(".guuey-chat");
    const style = root?.getAttribute("style") ?? "";
    expect(style).toContain("--_guuey-chat-accent: #b8ff3a");
    expect(style).toContain("--_guuey-chat-canvas: #0e1014");
    // The documented `--guuey-chat-*` channel is NEVER stamped inline — a
    // host CSS variable set on any ancestor must win per-token (the
    // stylesheet reads `var(--guuey-chat-<t>, var(--_guuey-chat-<t>))`),
    // so the two theming channels compose instead of shadowing.
    expect(style).not.toMatch(/(?<!_)guuey-chat-accent/);
    expect(root?.getAttribute("data-guuey-chat-mode")).toBe("dark");
  });

  it("surface='bare' marks the root; default stays the card presentation (guuey#521)", () => {
    const { container, unmount } = render(
      <Transcript plan={planOf(2)} surface="bare" {...noopCtx} />,
    );
    expect(container.querySelector(".guuey-chat")?.className).toContain("guuey-chat--bare");
    unmount();
    const { container: cardContainer } = render(<Transcript plan={planOf(2)} {...noopCtx} />);
    expect(cardContainer.querySelector(".guuey-chat")?.className).not.toContain(
      "guuey-chat--bare",
    );
  });

  it("windows long transcripts: tail rendered, earlier items behind the expander", () => {
    const plan = planOf(60); // 60 display items
    render(<Transcript plan={plan} window={{ tail: 10 }} {...noopCtx} />);
    expect(screen.queryByText("question 0")).toBeNull();
    expect(screen.getByText("answer 59")).toBeTruthy();
    const expander = screen.getByText("Show 50 earlier");
    fireEvent.click(expander);
    expect(screen.getByText("answer 49")).toBeTruthy();
  });

  it("window=false renders everything", () => {
    render(<Transcript plan={planOf(60)} window={false} {...noopCtx} />);
    expect(screen.getByText("question 0")).toBeTruthy();
  });

  it("component overrides replace one slot without forfeiting the rest", () => {
    const plan = planOf(2);
    const CustomUser = ({ item }: { item: UserMessageItem; ctx: TranscriptItemContext }) => (
      <div data-testid="custom-user">{item.text.toUpperCase()}</div>
    );
    render(<Transcript plan={plan} components={{ userMessage: CustomUser }} {...noopCtx} />);
    expect(screen.getByTestId("custom-user").textContent).toBe("QUESTION 0");
    expect(screen.getByText("answer 1")).toBeTruthy(); // default text still renders
  });

  it("renders the status line after the items when present", () => {
    const inputs: TranscriptInputs = {
      result: null,
      assistantText: "",
      status: "thinking",
      statusElapsedMs: 100,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [{ role: "user", text: "hi" }],
    };
    const plan = planTranscript(inputs, calmPolicy());
    render(<Transcript plan={plan} {...noopCtx} />);
    expect(screen.getByRole("status").textContent).toBe("Thinking…");
  });

  it("toggle events reach the handler with the item's stable key", () => {
    const onToggle = vi.fn();
    const inputs: TranscriptInputs = {
      result: null,
      assistantText: "",
      status: "ready",
      statusElapsedMs: 0,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "done" }],
    };
    // Hand-build a reasoning item path through the real plan: reasoning
    // requires a fold, so instead assert via the unknown row? Simpler: the
    // toggle wiring is per-component (components.test) — here we assert the
    // ctx threading end-to-end with a collapsed group built from the plan.
    const plan = planTranscript(inputs, calmPolicy());
    const tool: ToolItem = {
      kind: "tool",
      key: "tool.x",
      expanded: false,
      toolCallId: "x",
      name: "n",
      title: "do a thing",
      state: "done",
      argsPreview: "{}",
      result: null,
      refusal: null,
      attribution: false,
    };
    render(
      <Transcript plan={{ ...plan, items: [...plan.items, tool] }} onRetry={undefined} {...{ ...noopCtx, onToggle }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /do a thing/ }));
    expect(onToggle).toHaveBeenCalledWith("tool.x");
  });
});

/**
 * guuey#1328 — the card anchor's WIRING, on mocked geometry (jsdom has no
 * layout; the real-browser physics is `e2e/tests/sdk/chat-kit.spec.ts`). The
 * panel is 560 px; the content is 2000 px; the turn's first card sits at
 * content-y 1000 — QA's prod shape, where following the bottom (1440) left a
 * quarter of the card on screen.
 */
describe("Transcript — the turn's card anchor (guuey#1328)", () => {
  const PANEL = 560;
  const CONTENT = 2000;
  /** The live content height — a test grows it to prove what following does next. */
  let content = CONTENT;
  const CARD_TOPS = [1000, 1600];
  const restore: Array<() => void> = [];

  function mockLayout(): void {
    const proto = HTMLElement.prototype;
    const scrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    const clientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    const rect = Element.prototype.getBoundingClientRect;
    const isScroller = (el: Element): boolean => el.classList.contains("guuey-chat-scroller");
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? content : 0;
      },
    });
    Object.defineProperty(proto, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? PANEL : 0;
      },
    });
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const scroller = this.closest(".guuey-chat-scroller");
      const views = scroller === null ? [] : Array.from(scroller.querySelectorAll(".guuey-chat-view"));
      const i = views.indexOf(this);
      const scrolled = scroller instanceof HTMLElement ? scroller.scrollTop : 0;
      const top = i >= 0 ? (CARD_TOPS[i] ?? 0) - scrolled : 0;
      return new DOMRect(0, top, 300, 100);
    };
    restore.push(() => {
      if (scrollHeight !== undefined) Object.defineProperty(proto, "scrollHeight", scrollHeight);
      if (clientHeight !== undefined) Object.defineProperty(proto, "clientHeight", clientHeight);
      Element.prototype.getBoundingClientRect = rect;
    });
  }

  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
    content = CONTENT;
  });

  const cardPlan = () => planTranscript(viewNeverHandshakes(), calmPolicy());
  const scrollerOf = (container: HTMLElement): HTMLElement => {
    const el = container.querySelector(".guuey-chat-scroller");
    if (!(el instanceof HTMLElement)) throw new Error("no scroller");
    return el;
  };

  it("the fixture is the shape under test: a user turn whose items carry two top-level cards", () => {
    const { container } = render(<Transcript plan={cardPlan()} {...noopCtx} />);
    const column = container.querySelector(".guuey-chat-column");
    const direct = Array.from(column?.children ?? []).filter((c) => c.classList.contains("guuey-chat-view"));
    expect(direct).toHaveLength(2);
  });

  it("following rests at the card's top, not the bottom, and says there is more below", () => {
    mockLayout();
    const { container } = render(<Transcript plan={cardPlan()} {...noopCtx} />);
    expect(scrollerOf(container).scrollTop).toBe(CARD_TOPS[0]! - ANCHOR_GAP_PX);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("negative control: a custom `view` component (no kit class) keeps plain stick-to-bottom", () => {
    mockLayout();
    const { container } = render(
      <Transcript plan={cardPlan()} components={{ view: () => <div className="host-card" /> }} {...noopCtx} />,
    );
    // "At the bottom" (jsdom does not clamp scrollTop, so the old path writes scrollHeight itself).
    expect(scrollerOf(container).scrollTop).toBeGreaterThanOrEqual(CONTENT - PANEL);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("the viewer reaching the tail releases the hold: later growth follows the new bottom", () => {
    mockLayout();
    const plan = cardPlan();
    const { container, rerender } = render(<Transcript plan={plan} {...noopCtx} />);
    const el = scrollerOf(container);
    el.scrollTop = CONTENT - PANEL;
    fireEvent.scroll(el);
    // More prose streams in below: a released turn follows it (a held one would stay put).
    content = CONTENT + 1000;
    rerender(<Transcript plan={{ ...plan }} {...noopCtx} />);
    expect(el.scrollTop).toBe(content - PANEL);
  });

  it("the viewer scrolling UP is never pulled back down by the next render", () => {
    mockLayout();
    const plan = cardPlan();
    const { container, rerender } = render(<Transcript plan={plan} {...noopCtx} />);
    const el = scrollerOf(container);
    el.scrollTop = 200;
    fireEvent.scroll(el);
    rerender(<Transcript plan={{ ...plan }} {...noopCtx} />);
    expect(el.scrollTop).toBe(200);
  });

  it("Jump to latest goes to the true bottom and releases the hold for the turn", () => {
    mockLayout();
    const plan = cardPlan();
    const { container, rerender } = render(<Transcript plan={plan} {...noopCtx} />);
    const el = scrollerOf(container);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    // jsdom has no smooth scroll and no clamp: the jump writes scrollHeight.
    expect(el.scrollTop).toBe(CONTENT);
    content = CONTENT + 1000;
    rerender(<Transcript plan={{ ...plan }} {...noopCtx} />);
    expect(el.scrollTop).toBe(content - PANEL);
  });
});
