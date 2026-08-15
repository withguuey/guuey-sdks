// @vitest-environment jsdom
/**
 * The component kit's §3.2 accessibility obligations + the per-row states
 * that only a DOM can verify (focus, aria plumbing, keyboard toggles).
 * Content decisions themselves are the plan's — asserted by the corpus.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen , cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  DefaultError,
  DefaultPrompt,
  DefaultStatus,
  DefaultText,
  DefaultTool,
  DefaultToolGroup,
  DefaultUnknown,
  DefaultUserMessage,
  DefaultView,
  type TranscriptItemContext,
} from "./components.js";
import { defaultChatStrings } from "../strings.js";
import type {
  ErrorItem,
  PromptItem,
  StatusLineItem,
  TextItem,
  ToolGroupItem,
  ToolItem,
  UnknownItem,
  UserMessageItem,
  ViewMountItem,
} from "../types.js";

afterEach(cleanup);

function ctx(overrides: Partial<TranscriptItemContext> = {}): TranscriptItemContext {
  return {
    strings: defaultChatStrings,
    onToggle: vi.fn(),
    resolvedMounts: new Map(),
    onViewPhase: vi.fn(),
    ...overrides,
  };
}

const tool = (over: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  key: "tool.c1",
  expanded: false,
  toolCallId: "c1",
  name: "search_flights",
  title: "search flights",
  state: "done",
  argsPreview: '{"to":"NRT"}',
  result: null,
  attribution: false,
  ...over,
});

describe("toggle a11y (every expanded toggle is a keyboard-operable button)", () => {
  it("tool toggles carry aria-expanded + aria-controls and fire onToggle", () => {
    const onToggle = vi.fn();
    render(<DefaultTool item={tool()} ctx={ctx({ onToggle })} />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("guuey-chat-body-tool.c1");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledWith("tool.c1");
  });

  it("an expanded tool renders the controlled body with matching id", () => {
    const { container } = render(<DefaultTool item={tool({ expanded: true })} ctx={ctx()} />);
    expect(container.querySelector("#guuey-chat-body-tool\\.c1")).not.toBeNull();
  });

  it("an attribution tool line renders NOTHING (its view row carries the chrome)", () => {
    const { container } = render(<DefaultTool item={tool({ attribution: true })} ctx={ctx()} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("tool group", () => {
  it("collapsed group shows label + failure badge without unrolling", () => {
    const item: ToolGroupItem = {
      kind: "tool-group",
      key: "g.tool.c1",
      expanded: false,
      label: "Ran 3 tools",
      tools: [tool(), tool({ key: "tool.c2", toolCallId: "c2", state: "failed" }), tool({ key: "tool.c3", toolCallId: "c3" })],
      failureCount: 1,
      failureBadge: "1 failed",
    };
    render(<DefaultToolGroup item={item} ctx={ctx()} />);
    expect(screen.getByText("Ran 3 tools")).toBeTruthy();
    expect(screen.getByText("1 failed")).toBeTruthy();
    expect(screen.queryByText("search flights")).toBeNull();
  });
});

describe("streaming text announces politely; stopped marks the partial", () => {
  const text = (over: Partial<TextItem>): TextItem => ({
    kind: "text",
    key: "a0.t0",
    expanded: true,
    text: "Hello",
    markdown: true,
    streaming: false,
    stopped: false,
    ...over,
  });

  it("streaming bubble carries aria-live=polite; settled does not", () => {
    const { container, rerender } = render(<DefaultText item={text({ streaming: true })} ctx={ctx()} />);
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    rerender(<DefaultText item={text({ streaming: false })} ctx={ctx()} />);
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it("aborted-partial keeps the text and shows the stopped marker", () => {
    render(<DefaultText item={text({ stopped: true })} ctx={ctx()} />);
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.getByText(defaultChatStrings.stopped)).toBeTruthy();
  });
});

describe("R10 prompt focus management", () => {
  const prompt = (state: PromptItem["state"]): PromptItem => ({
    kind: "prompt",
    promptId: "consent.0",
    key: "p.consent.0",
    expanded: true,
    promptKind: "consent",
    appId: "app-1",
    requested: "read",
    state,
    raw: null,
  });

  it("takes focus on appearance and returns it on resolution", () => {
    const outside = document.createElement("button");
    outside.textContent = "composer";
    document.body.appendChild(outside);
    outside.focus();

    const { rerender } = render(<DefaultPrompt item={prompt("pending")} ctx={ctx()} />);
    expect(document.activeElement?.textContent).toBe("Allow");

    rerender(<DefaultPrompt item={prompt("answered")} ctx={ctx()} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("actions reach the host callback", () => {
    const onPromptAction = vi.fn();
    render(<DefaultPrompt item={prompt("pending")} ctx={ctx({ onPromptAction })} />);
    fireEvent.click(screen.getByText("Decline"));
    expect(onPromptAction).toHaveBeenCalledWith(expect.objectContaining({ key: "p.consent.0" }), "decline");
  });
});

describe("R0 failed send", () => {
  it("shows the couldn't-send notice with a working retry, and the text never disappears", () => {
    const onRetry = vi.fn();
    const item: UserMessageItem = {
      kind: "user",
      key: "u0",
      expanded: true,
      text: "hello?",
      state: "failed",
      retry: true,
    };
    render(<DefaultUserMessage item={item} ctx={ctx({ onRetry })} />);
    expect(screen.getByText("hello?")).toBeTruthy();
    expect(screen.getByText(defaultChatStrings.userCouldntSend)).toBeTruthy();
    fireEvent.click(screen.getByText(defaultChatStrings.userRetry));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("status + error live semantics", () => {
  it("the status line is a polite live region (role=status)", () => {
    const item: StatusLineItem = { kind: "status", key: "status", state: "thinking", copy: "Thinking…", detail: null };
    render(<DefaultStatus item={item} ctx={ctx()} />);
    expect(screen.getByRole("status").textContent).toBe("Thinking…");
  });

  it("errors are alerts with family copy; verbatim only when populated", () => {
    const item: ErrorItem = {
      kind: "error",
      key: "error",
      expanded: true,
      family: "transient",
      code: "TIMEOUT",
      message: "upstream timeout",
      copy: defaultChatStrings.errorTransient,
      verbatim: null,
    };
    render(<DefaultError item={item} ctx={ctx()} />);
    expect(screen.getByRole("alert").textContent).toContain(defaultChatStrings.errorTransient);
  });
});

describe("R15 unknown stays labeled and collapsed", () => {
  it("calm shows label + type + size, expand reveals size note (raw absent)", () => {
    const item: UnknownItem = {
      kind: "unknown",
      key: "a0.u0",
      expanded: true,
      label: defaultChatStrings.unknownLabel,
      typeName: "quantum-block",
      byteSize: 2048,
      raw: null,
    };
    render(<DefaultUnknown item={item} ctx={ctx()} />);
    expect(screen.getByText(/quantum-block/)).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
  });
});

describe("DefaultView — per-mount viewProps + autoResize (guuey#135 kit-refinement)", () => {
  const viewItem = (): ViewMountItem => ({
    kind: "view",
    key: "view.c9",
    expanded: true,
    mount: {
      channel: "inline",
      resource: { uri: "ui://tool/card", mimeType: "text/html", text: "<p>card</p>" },
    },
    channel: "inline",
    phase: "negotiating",
    label: null,
    attribution: null,
    toolTitle: "show card",
    actionScope: "ui://persisted/locator",
  });

  it("the viewProps FUNCTION form resolves against the item and its resolved mount", () => {
    const seen: Array<{ key: string; uri: string }> = [];
    render(
      <DefaultView
        item={viewItem()}
        ctx={ctx({
          viewProps: (item, mount) => {
            seen.push({ key: item.key, uri: mount.resource.uri });
            return { negotiationTimeoutMs: 0 };
          },
        })}
      />,
    );
    expect(seen).toEqual([{ key: "view.c9", uri: "ui://tool/card" }]);
  });

  it("autoResize applies the view's reported height to the frame", async () => {
    const { container } = render(
      <DefaultView item={viewItem()} ctx={ctx({ viewProps: { autoResize: true } })} />,
    );
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.style.height).toBe("100%");
    // The host filters by event.source — synthesize the message the way a
    // real view posts it (jsdom's about:srcdoc frame has a contentWindow).
    const source = frame!.contentWindow;
    expect(source).not.toBeNull();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          jsonrpc: "2.0",
          method: "ui/notifications/size-changed",
          params: { height: 420 },
        },
        source,
      }),
    );
    await vi.waitFor(() => expect(frame!.style.height).toBe("420px"));
  });

  it("without autoResize the reported height is NOT applied — additive by default", async () => {
    const { container } = render(<DefaultView item={viewItem()} ctx={ctx()} />);
    const frame = container.querySelector("iframe")!;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          jsonrpc: "2.0",
          method: "ui/notifications/size-changed",
          params: { height: 420 },
        },
        source: frame.contentWindow,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frame.style.height).toBe("100%");
  });

  it("sandboxPageUrl: null refuses with the labeled state — srcdoc is never a fallback", () => {
    const { container } = render(
      <DefaultView item={viewItem()} ctx={ctx({ viewProps: { sandboxPageUrl: null } })} />,
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("no sandbox page is configured");
  });
});

// Type-level guard that the context type stays renderable-friendly.
function _assertRenderable(node: ReactNode): ReactNode {
  return node;
}
void _assertRenderable;
