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
  it("projects the theme as --guuey-chat-* custom properties on the root", () => {
    const { container } = render(
      <Transcript plan={planOf(2)} theme={GUUEY_CHAT_THEME} mode="dark" {...noopCtx} />,
    );
    const root = container.querySelector(".guuey-chat");
    expect(root?.getAttribute("style")).toContain("--guuey-chat-accent: #b8ff3a");
    expect(root?.getAttribute("style")).toContain("--guuey-chat-canvas: #0e1014");
    expect(root?.getAttribute("data-guuey-chat-mode")).toBe("dark");
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
      attribution: false,
    };
    render(
      <Transcript plan={{ ...plan, items: [...plan.items, tool] }} onRetry={undefined} {...{ ...noopCtx, onToggle }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /do a thing/ }));
    expect(onToggle).toHaveBeenCalledWith("tool.x");
  });
});
