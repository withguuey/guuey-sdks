// @vitest-environment jsdom
/**
 * The component kit's §3.2 accessibility obligations + the per-row states
 * that only a DOM can verify (focus, aria plumbing, keyboard toggles).
 * Content decisions themselves are the plan's — asserted by the corpus.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, render, screen , cleanup } from "@testing-library/react";
import { SETTLE_MS } from "@guuey/mcp-apps-host/react";
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
  HitlPromptItem,
  ProfilePromptItem,
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
  refusal: null,
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
  const prompt = (state: ProfilePromptItem["state"]): ProfilePromptItem => ({
    kind: "prompt",
    promptId: "link.0",
    key: "p.link.0",
    expanded: true,
    promptKind: "link",
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
    expect(onPromptAction).toHaveBeenCalledWith(expect.objectContaining({ key: "p.link.0" }), "decline");
  });
});

describe("R0 directive collapse (guuey#422)", () => {
  const directiveItem = (expanded: boolean): UserMessageItem => ({
    kind: "user",
    key: "u1",
    expanded,
    text: 'Call ggui_consume NOW.\n\n<ggui_directive kind="user-action">\n  <session_id>s1</session_id>\n</ggui_directive>',
    state: "sent",
    retry: false,
    directive: true,
  });

  it("collapsed: the calm continuation label shows and the verbatim carrier stays out of the DOM", () => {
    render(<DefaultUserMessage item={directiveItem(false)} ctx={ctx()} />);
    expect(screen.getByText(defaultChatStrings.directiveContinuation)).toBeTruthy();
    expect(screen.queryByText(/ggui_consume/)).toBeNull();
    // A real toggle, not a dead row.
    expect(screen.getByRole("button", { expanded: false })).toBeTruthy();
  });

  it("expanded: the wire-verbatim text is revealed exactly, still quoted (never rendered)", () => {
    const item = directiveItem(true);
    const { container } = render(<DefaultUserMessage item={item} ctx={ctx()} />);
    const bubble = container.querySelector(".guuey-chat-user-bubble");
    expect(bubble?.textContent).toBe(item.text);
    // Quoted: the directive tag is TEXT, not an element.
    expect(container.querySelector("ggui_directive")).toBeNull();
  });

  it("the toggle wires to onToggle with the item key", () => {
    const onToggle = vi.fn();
    render(<DefaultUserMessage item={directiveItem(false)} ctx={ctx({ onToggle })} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(onToggle).toHaveBeenCalledWith("u1");
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
      directive: false,
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
    diagnosis: null,
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

  // guuey#992 — the founder's first prod card grew to 86,816 px: a view whose
  // body is viewport-bound measures the frame's own height (+δ) back to the
  // host on every resize. The host owns the loop's stability (the view is
  // agent-generated HTML): a second same-δ growth inside the echo window
  // holds the frame; a `maxHeight` (default: the window) caps it.
  it("autoResize HOLDS the frame on the 100vh echo — the second same-δ growth never applies", async () => {
    const { container } = render(
      <DefaultView item={viewItem()} ctx={ctx({ viewProps: { autoResize: true } })} />,
    );
    const frame = container.querySelector("iframe")!;
    const report = (height: number) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } },
          source: frame.contentWindow,
        }),
      );
    report(420);
    await vi.waitFor(() => expect(frame.style.height).toBe("420px"));
    report(436); // the view re-measured the taller frame: +16
    await vi.waitFor(() => expect(frame.style.height).toBe("436px"));
    report(452); // +16 again — the echo
    report(468);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frame.style.height).toBe("436px");
    // A shrink still applies — the hold is against growth only.
    report(200);
    await vi.waitFor(() => expect(frame.style.height).toBe("200px"));
  });

  it("autoResize never applies above maxHeight — a viewport-tall card scrolls inside its frame", async () => {
    const { container } = render(
      <DefaultView
        item={viewItem()}
        ctx={ctx({ viewProps: { autoResize: true, maxHeight: 600 } })}
      />,
    );
    const frame = container.querySelector("iframe")!;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 86_816 } },
        source: frame.contentWindow,
      }),
    );
    await vi.waitFor(() => expect(frame.style.height).toBe("600px"));
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

  // The kit's `.guuey-chat-view iframe` min-height is a LOADING reservation
  // (no jump while a card mounts) and the whole sizing story for a mount
  // without autoResize (which would otherwise sit at the browser's default
  // 150px). Once autoResize has applied a size report AND that height has
  // settled (unchanged for SETTLE_MS), the frame is the card's height: a
  // short card no longer sits at the top of a 16rem box. The floor holds
  // through the card's first reports, which can be taken before the card
  // has mounted (a 0 is never applied at all). Read through the real
  // stylesheet, so the assertion is what a visitor gets. Fake timers drive
  // the settle window; every report and tick runs inside act() so React
  // commits before the assertion.
  describe("the kit's frame floor yields to a settled size report", () => {
    const KIT_CSS = readFileSync(join(import.meta.dirname, "..", "..", "styles.css"), "utf8");
    const FLOOR = "16rem";
    // jsdom reports the declared "0"; a browser resolves it to "0px".
    const RELEASED = /^0(px)?$/;
    let sheet: HTMLStyleElement | undefined;
    beforeEach(() => {
      vi.useFakeTimers();
      sheet = document.createElement("style");
      sheet.textContent = KIT_CSS;
      document.head.appendChild(sheet);
    });
    afterEach(() => {
      sheet?.remove();
      sheet = undefined;
      vi.useRealTimers();
    });
    const report = (frame: HTMLIFrameElement, height: number) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } },
            source: frame.contentWindow,
          })
        );
      });
    const elapse = (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    const floorOf = (frame: HTMLIFrameElement) => getComputedStyle(frame).minHeight;
    const mountAutoResize = (item: ViewMountItem = viewItem()) =>
      render(<DefaultView item={item} ctx={ctx({ viewProps: { autoResize: true } })} />);

    it("holds the floor before any size report (the loading reservation)", () => {
      const { container } = mountAutoResize();
      const frame = container.querySelector("iframe")!;
      expect(floorOf(frame)).toBe(FLOOR);
      expect(frame.style.minHeight).toBe("");
    });

    it("a 0 report is never applied — the frame keeps its height and the floor", () => {
      const { container } = mountAutoResize();
      const frame = container.querySelector("iframe")!;
      report(frame, 0);
      elapse(SETTLE_MS * 2);
      expect(frame.style.height).toBe("100%");
      expect(frame.style.minHeight).toBe("");
      expect(floorOf(frame)).toBe(FLOOR);
    });

    it("a negative report is never applied either", () => {
      const { container } = mountAutoResize();
      const frame = container.querySelector("iframe")!;
      report(frame, -24);
      elapse(SETTLE_MS * 2);
      expect(frame.style.height).toBe("100%");
      expect(floorOf(frame)).toBe(FLOOR);
    });

    it("0 then 152: 152 applies, the floor holds until 152 has settled, then a 152px card gets a 152px frame", () => {
      const { container } = mountAutoResize();
      const frame = container.querySelector("iframe")!;
      report(frame, 0);
      report(frame, 152);
      expect(frame.style.height).toBe("152px");
      expect(floorOf(frame)).toBe(FLOOR);
      elapse(SETTLE_MS - 1);
      expect(floorOf(frame)).toBe(FLOOR);
      elapse(1);
      expect(frame.style.height).toBe("152px");
      expect(floorOf(frame)).toMatch(RELEASED);
    });

    it("16, then 152 100ms later: the floor holds through both and releases a full window after the LAST change", () => {
      const { container } = mountAutoResize();
      const frame = container.querySelector("iframe")!;
      report(frame, 16);
      expect(frame.style.height).toBe("16px");
      expect(floorOf(frame)).toBe(FLOOR);
      elapse(100);
      report(frame, 152);
      expect(frame.style.height).toBe("152px");
      expect(floorOf(frame)).toBe(FLOOR);
      // Past SETTLE_MS since the 16 — but the 152 restarted the window.
      elapse(SETTLE_MS - 1);
      expect(floorOf(frame)).toBe(FLOOR);
      elapse(1);
      expect(floorOf(frame)).toMatch(RELEASED);
    });

    it("a new document after a release puts the floor back, and its own height must settle again", () => {
      const first = viewItem();
      const { container, rerender } = mountAutoResize(first);
      report(container.querySelector("iframe")!, 152);
      elapse(SETTLE_MS);
      expect(floorOf(container.querySelector("iframe")!)).toMatch(RELEASED);

      const next: ViewMountItem = {
        ...first,
        mount: {
          channel: "inline",
          resource: { uri: "ui://tool/next-card", mimeType: "text/html", text: "<p>next</p>" },
        },
      };
      rerender(<DefaultView item={next} ctx={ctx({ viewProps: { autoResize: true } })} />);
      const frame = container.querySelector("iframe")!;
      expect(frame.style.height).toBe("100%");
      expect(frame.style.minHeight).toBe("");
      expect(floorOf(frame)).toBe(FLOOR);

      report(frame, 120);
      expect(frame.style.height).toBe("120px");
      expect(floorOf(frame)).toBe(FLOOR);
      elapse(SETTLE_MS);
      expect(floorOf(frame)).toMatch(RELEASED);
    });

    it("a new document while the previous one's window is still open: the old window never releases the new frame's floor", () => {
      const first = viewItem();
      const { container, rerender } = mountAutoResize(first);
      report(container.querySelector("iframe")!, 152);
      elapse(SETTLE_MS / 2);

      const next: ViewMountItem = {
        ...first,
        mount: {
          channel: "inline",
          resource: { uri: "ui://tool/next-card", mimeType: "text/html", text: "<p>next</p>" },
        },
      };
      rerender(<DefaultView item={next} ctx={ctx({ viewProps: { autoResize: true } })} />);
      const frame = container.querySelector("iframe")!;
      // Past the point where the first document's window would have run out.
      elapse(SETTLE_MS);
      expect(frame.style.height).toBe("100%");
      expect(frame.style.minHeight).toBe("");
      expect(floorOf(frame)).toBe(FLOOR);

      // The new document's first report opens its own full window.
      report(frame, 120);
      expect(frame.style.height).toBe("120px");
      expect(floorOf(frame)).toBe(FLOOR);
      elapse(SETTLE_MS - 1);
      expect(floorOf(frame)).toBe(FLOOR);
      elapse(1);
      expect(floorOf(frame)).toMatch(RELEASED);
    });

    it("unmounting before the height settles leaves no settle timer behind", () => {
      // Baseline: what an unmount leaves pending when no settle window was
      // ever opened (the host's own teardown notice to the frame).
      const idle = mountAutoResize();
      idle.unmount();
      const baseline = vi.getTimerCount();
      vi.clearAllTimers();

      const { container, unmount } = mountAutoResize();
      report(container.querySelector("iframe")!, 152);
      unmount();
      expect(vi.getTimerCount()).toBe(baseline);
    });

    it("keeps the floor for a mount without autoResize, report or not", () => {
      const { container } = render(<DefaultView item={viewItem()} ctx={ctx()} />);
      const frame = container.querySelector("iframe")!;
      report(frame, 152);
      elapse(SETTLE_MS * 2);
      expect(frame.style.height).toBe("100%");
      expect(frame.style.minHeight).toBe("");
      expect(floorOf(frame)).toBe(FLOOR);
    });
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

describe("R10 hitl card (spec draft.2)", () => {
  const ask = {
    askId: "ask-1",
    kind: "approval" as const,
    message: "Remember this?",
    grantModes: [
      { id: "m.durable", label: "Always", description: "Keep it forever" },
      { id: "m.scoped", label: "Just this chat" },
    ],
  };
  const hitl = (state: HitlPromptItem["state"], expanded = true): HitlPromptItem => ({
    kind: "prompt",
    promptId: "ask-1",
    key: "p.ask-1",
    expanded,
    promptKind: "hitl",
    ask,
    message: ask.message,
    askKind: "approval",
    grantModes: ask.grantModes,
    oauth: null,
    state,
    chosenModeId: state === "resolved" ? "m.durable" : null,
    chosenModeLabel: state === "resolved" ? "Always" : null,
    raw: null,
  });

  it("pending renders one action per declared mode + decline, firing the mode ECHO", () => {
    const onPromptAction = vi.fn();
    render(<DefaultPrompt item={hitl("pending")} ctx={ctx({ onPromptAction })} />);
    fireEvent.click(screen.getByRole("button", { name: "Always" }));
    expect(onPromptAction).toHaveBeenCalledWith(hitl("pending"), { grantModeId: "m.durable" });
    fireEvent.click(screen.getByRole("button", { name: "Don't allow" }));
    expect(onPromptAction).toHaveBeenLastCalledWith(hitl("pending"), "decline");
  });

  it("resolved collapses to the CHOSEN MODE'S LABEL — ids never display as meaning", () => {
    render(<DefaultPrompt item={hitl("resolved")} ctx={ctx()} />);
    expect(screen.getByText("Allowed — Always")).toBeTruthy();
    expect(screen.queryByText(/m\.durable/)).toBeNull();
  });

  // guuey#178: the OAuth arm — the SAME card; the deny becomes "Not now"
  // (a dismissal: there is no durable deny for an authorize ask), the
  // resolved record says the user was sent to the provider.
  it("an oauth2 auth ask renders the mode buttons + Not now (dismiss), and a resolved record reads Connecting", () => {
    const authAsk = {
      askId: "mcp-oauth:app_1:linear:t1",
      kind: "auth" as const,
      message: "Trip Planner wants to use your Linear account",
      authConfig: { scheme: "oauth2", authorizationUrl: "https://mcp.example/oauth/start?state=abc" },
      grantModes: [
        { id: "always", label: "Always allow" },
        { id: "once", label: "Allow this chat" },
      ],
    };
    const oauthItem = (state: HitlPromptItem["state"]): HitlPromptItem => ({
      ...hitl(state),
      promptId: authAsk.askId,
      key: `p.${authAsk.askId}`,
      ask: authAsk,
      message: authAsk.message,
      askKind: "auth",
      grantModes: authAsk.grantModes,
      // `upfront: false` is the ON-DEMAND flavor (guuey#605) — this fixture is
      // the ordinary consent card, which must keep rendering exactly as it did
      // before the required-connection arm existed.
      oauth: { authorizationUrl: authAsk.authConfig.authorizationUrl, scopes: [], upfront: false },
      chosenModeId: state === "resolved" ? "always" : null,
      chosenModeLabel: state === "resolved" ? "Always allow" : null,
    });
    const onPromptAction = vi.fn();
    render(<DefaultPrompt item={oauthItem("pending")} ctx={ctx({ onPromptAction })} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow this chat" }));
    expect(onPromptAction).toHaveBeenCalledWith(oauthItem("pending"), { grantModeId: "once" });
    expect(screen.queryByRole("button", { name: "Don't allow" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onPromptAction).toHaveBeenLastCalledWith(oauthItem("pending"), "dismiss");
    render(<DefaultPrompt item={oauthItem("resolved")} ctx={ctx()} />);
    expect(screen.getByText("Connecting — Always allow")).toBeTruthy();
  });

  it("cancelled is a dismissed record that reopens to the actions (re-askable ruling)", () => {
    render(<DefaultPrompt item={hitl("cancelled", false)} ctx={ctx()} />);
    expect(screen.getByText("Dismissed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Always" })).toBeNull();
    render(<DefaultPrompt item={hitl("cancelled", true)} ctx={ctx()} />);
    expect(screen.getByRole("button", { name: "Always" })).toBeTruthy();
  });
});

