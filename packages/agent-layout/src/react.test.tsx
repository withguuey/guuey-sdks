// @vitest-environment jsdom
/**
 * The React layer over the REAL machine: token application, the follow,
 * capture-phase menu wiring, the route-derived signal, the (d) working
 * state, floor rejection at wiring time, and the own-provider render
 * isolation contract's visible half (context changes only on transitions).
 */
import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import type { ReactNode } from "react";
import {
  ActivePane,
  AgentModeProvider,
  AgentModeShell,
  AgentModeSidebar,
  SidebarPanel,
  useAgentMode,
} from "./react.js";
import { DEFAULT_TONES } from "./tones.js";

afterEach(cleanup);

function Bridge({ children }: { children?: ReactNode }): ReactNode {
  const { dispatch } = useAgentMode();
  return (
    <>
      <button type="button" onClick={() => dispatch({ type: "agentSubmit" })}>
        submit
      </button>
      <button type="button" onClick={() => dispatch({ type: "agentSettled" })}>
        settle
      </button>
      <button type="button" onClick={() => dispatch({ type: "agentViewMounted" })}>
        mount-view
      </button>
      {children}
    </>
  );
}

function shell(extra?: { mode?: "light" | "dark"; navigationKey?: unknown; identity?: ReactNode }) {
  return render(
    <AgentModeProvider {...extra}>
      <AgentModeShell data-testid="shell">
        <AgentModeSidebar>
          <SidebarPanel section="app" data-testid="app-panel">
            <a href="#x">Dashboard</a>
          </SidebarPanel>
          <SidebarPanel section="agent" data-testid="agent-panel">
            <Bridge />
          </SidebarPanel>
        </AgentModeSidebar>
        <ActivePane data-testid="pane">
          <p>page content</p>
        </ActivePane>
      </AgentModeShell>
    </AgentModeProvider>,
  );
}

function layoutRoot(): HTMLElement {
  const el = document.querySelector(".guuey-agent-layout");
  if (!(el instanceof HTMLElement)) throw new Error("layout root missing");
  return el;
}

describe("<AgentModeProvider> tokens", () => {
  it("applies the mode's default tones + the lib-written pane tone, and stamps data-mode", () => {
    shell({ mode: "dark" });
    const root = layoutRoot();
    expect(root.dataset.mode).toBe("dark");
    expect(root.style.getPropertyValue("--guuey-layout-tone-upper")).toBe(DEFAULT_TONES.dark.upper);
    // Opens as the app: the pane holds the upper tone.
    expect(root.style.getPropertyValue("--guuey-layout-pane-tone")).toBe(DEFAULT_TONES.dark.upper);
    expect(root.style.getPropertyValue("--guuey-layout-tone-transition")).toBe("150ms");
  });

  it("submit flips the pane tone to the agent's; settle does NOT flip it back", () => {
    shell();
    fireEvent.click(screen.getByText("submit"));
    expect(layoutRoot().style.getPropertyValue("--guuey-layout-pane-tone")).toBe(
      DEFAULT_TONES.light.lower,
    );
    fireEvent.click(screen.getByText("settle"));
    expect(layoutRoot().style.getPropertyValue("--guuey-layout-pane-tone")).toBe(
      DEFAULT_TONES.light.lower,
    );
  });

  it("a below-floor tones override is rejected at wiring time with the explanation", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        render(
          <AgentModeProvider
            tones={{ upper: "#EDEDED", upperOn: "#111111", lower: "#E4E4E4", lowerOn: "#111111" }}
          >
            <p>x</p>
          </AgentModeProvider>,
        ),
      ).toThrow(/perceptibility floor/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the follow (§3 wired)", () => {
  it("a click anywhere inside the app panel re-follows — zero per-link wiring", () => {
    shell();
    fireEvent.click(screen.getByText("submit"));
    expect(layoutRoot().dataset.activePanel).toBe("agent");
    fireEvent.pointerDown(screen.getByText("Dashboard"));
    expect(layoutRoot().dataset.activePanel).toBe("app");
  });

  it("the route-derived signal flips to app on ANY navigationKey change, not on mount", () => {
    const view = render(
      <AgentModeProvider navigationKey="/app">
        <AgentModeShell>
          <AgentModeSidebar>
            <SidebarPanel section="agent">
              <Bridge />
            </SidebarPanel>
          </AgentModeSidebar>
          <ActivePane>x</ActivePane>
        </AgentModeShell>
      </AgentModeProvider>,
    );
    expect(layoutRoot().dataset.activePanel).toBe("app"); // mount fired nothing
    fireEvent.click(screen.getByText("submit"));
    expect(layoutRoot().dataset.activePanel).toBe("agent");
    view.rerender(
      <AgentModeProvider navigationKey="/app/reports">
        <AgentModeShell>
          <AgentModeSidebar>
            <SidebarPanel section="agent">
              <Bridge />
            </SidebarPanel>
          </AgentModeSidebar>
          <ActivePane>x</ActivePane>
        </AgentModeShell>
      </AgentModeProvider>,
    );
    expect(layoutRoot().dataset.activePanel).toBe("app");
  });
});

describe("requirement (d): the working state", () => {
  it("on submit the pane presents the working state, never the prior page content", () => {
    shell({ identity: <span>BrandMark</span> });
    expect(screen.getByText("page content")).toBeTruthy();
    fireEvent.click(screen.getByText("submit"));
    expect(screen.queryByText("page content")).toBeNull();
    expect(screen.getByText("BrandMark")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("a view mount clears it; content returns", () => {
    shell();
    fireEvent.click(screen.getByText("submit"));
    expect(screen.queryByText("page content")).toBeNull();
    fireEvent.click(screen.getByText("mount-view"));
    expect(screen.getByText("page content")).toBeTruthy();
  });
});

describe("the drawer toggle", () => {
  it("is a real disclosure button controlling the sidebar", () => {
    shell();
    const toggle = screen.getByRole("button", { name: "Menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("guuey-layout-sidebar");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("shell").dataset.drawerOpen).toBe("true");
  });

  it("guuey#2450: closing with focus inside the drawer moves focus to the toggle; focus elsewhere is left alone", () => {
    function view(navigationKey: string): ReactNode {
      return (
        <AgentModeProvider navigationKey={navigationKey}>
          <AgentModeShell data-testid="shell">
            <AgentModeSidebar>
              <SidebarPanel section="app">
                <a href="#x">Dashboard</a>
              </SidebarPanel>
            </AgentModeSidebar>
            <ActivePane>
              <button type="button">in the page</button>
            </ActivePane>
          </AgentModeShell>
        </AgentModeProvider>
      );
    }
    const { rerender } = render(view("/a"));
    const toggle = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(toggle);
    const link = screen.getByText("Dashboard");
    act(() => link.focus());
    expect(document.activeElement).toBe(link);
    // A route change closes the drawer.
    rerender(view("/b"));
    expect(screen.getByTestId("shell").dataset.drawerOpen).toBeUndefined();
    expect(document.activeElement).toBe(toggle);

    // Focus in the page when the drawer closes stays where it is.
    fireEvent.click(toggle);
    const inPage = screen.getByRole("button", { name: "in the page" });
    act(() => inPage.focus());
    rerender(view("/c"));
    expect(screen.getByTestId("shell").dataset.drawerOpen).toBeUndefined();
    expect(document.activeElement).toBe(inPage);
  });
});

describe("guuey#427 — setActivePanel is the neutral setter its name promises", () => {
  function SetterProbe(): ReactNode {
    const { setActivePanel, pending } = useAgentMode();
    return (
      <>
        <button type="button" onClick={() => setActivePanel("agent")}>
          open-agent
        </button>
        <span data-testid="pending">{pending ? "pending" : "idle"}</span>
      </>
    );
  }

  it("setActivePanel('agent') flips the tone without arming the working state", () => {
    render(
      <AgentModeProvider>
        <AgentModeShell>
          <AgentModeSidebar>
            <SidebarPanel section="agent">
              <SetterProbe />
            </SidebarPanel>
          </AgentModeSidebar>
          <ActivePane>
            <p>page content</p>
          </ActivePane>
        </AgentModeShell>
      </AgentModeProvider>,
    );
    fireEvent.click(screen.getByText("open-agent"));
    expect(layoutRoot().dataset.activePanel).toBe("agent");
    // The near-miss face: NO permanent spinner — content stays.
    expect(screen.getByTestId("pending").textContent).toBe("idle");
    expect(screen.getByText("page content")).toBeTruthy();
  });
});

describe("guuey#430 — the configurable standby slot", () => {
  it("Provider standby replaces the built-in default; per-pane workingState wins over both", () => {
    const view = render(
      <AgentModeProvider standby={<span>BRAND SPLASH</span>} identity={<span>Mark</span>}>
        <AgentModeShell>
          <AgentModeSidebar>
            <SidebarPanel section="agent">
              <Bridge />
            </SidebarPanel>
          </AgentModeSidebar>
          <ActivePane>
            <p>page content</p>
          </ActivePane>
        </AgentModeShell>
      </AgentModeProvider>,
    );
    fireEvent.click(screen.getByText("submit"));
    // The configured standby shows; the built-in identity+pulse does not.
    expect(screen.getByText("BRAND SPLASH")).toBeTruthy();
    expect(screen.queryByText("Mark")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    view.rerender(
      <AgentModeProvider standby={<span>BRAND SPLASH</span>} identity={<span>Mark</span>}>
        <AgentModeShell>
          <AgentModeSidebar>
            <SidebarPanel section="agent">
              <Bridge />
            </SidebarPanel>
          </AgentModeSidebar>
          <ActivePane workingState={<span>PANE-LOCAL</span>}>
            <p>page content</p>
          </ActivePane>
        </AgentModeShell>
      </AgentModeProvider>,
    );
    expect(screen.getByText("PANE-LOCAL")).toBeTruthy();
    expect(screen.queryByText("BRAND SPLASH")).toBeNull();
  });
});

describe("guuey#2450 — the app panel says when its content is hidden (the fade's flag)", () => {
  /** A controllable ResizeObserver: jsdom ships none and performs no layout. */
  const observers: FakeResizeObserver[] = [];
  class FakeResizeObserver implements ResizeObserver {
    readonly observed = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element): void {
      this.observed.add(target);
    }
    unobserve(target: Element): void {
      this.observed.delete(target);
    }
    disconnect(): void {
      this.observed.clear();
    }
  }

  function setBox(el: HTMLElement, box: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: box.scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: box.clientHeight });
    el.scrollTop = box.scrollTop;
  }

  function resize(): void {
    act(() => {
      for (const o of observers) o.callback([], o);
    });
  }

  afterEach(() => {
    observers.length = 0;
    vi.unstubAllGlobals();
  });

  it("flags data-overflow only while content is hidden below the panel's edge, and the agent panel never carries it", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    shell();
    const app = screen.getByTestId("app-panel");
    // Observes the panel and its content (a nav that grows inside a bounded panel).
    expect(observers.some((o) => o.observed.has(app))).toBe(true);
    expect(app.dataset.overflow).toBeUndefined();

    setBox(app, { scrollHeight: 600, clientHeight: 300, scrollTop: 0 });
    resize();
    expect(app.dataset.overflow).toBe("true");

    // Scrolled to the end: nothing is hidden below, so no fade.
    setBox(app, { scrollHeight: 600, clientHeight: 300, scrollTop: 300 });
    act(() => {
      fireEvent.scroll(app);
    });
    expect(app.dataset.overflow).toBeUndefined();

    // The nav fits again: no flag.
    setBox(app, { scrollHeight: 300, clientHeight: 300, scrollTop: 0 });
    resize();
    expect(app.dataset.overflow).toBeUndefined();

    expect(screen.getByTestId("agent-panel").dataset.overflow).toBeUndefined();
  });

  it("flags data-overflow-above once content has scrolled under the top edge, and drops it back at the top", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    shell();
    const app = screen.getByTestId("app-panel");
    setBox(app, { scrollHeight: 600, clientHeight: 300, scrollTop: 0 });
    resize();
    expect(app.dataset.overflowAbove).toBeUndefined();
    expect(app.dataset.overflow).toBe("true");

    // Mid-scroll: hidden on both edges, both fades.
    setBox(app, { scrollHeight: 600, clientHeight: 300, scrollTop: 150 });
    act(() => {
      fireEvent.scroll(app);
    });
    expect(app.dataset.overflowAbove).toBe("true");
    expect(app.dataset.overflow).toBe("true");

    // At the end: only the top fade.
    setBox(app, { scrollHeight: 600, clientHeight: 300, scrollTop: 300 });
    act(() => {
      fireEvent.scroll(app);
    });
    expect(app.dataset.overflowAbove).toBe("true");
    expect(app.dataset.overflow).toBeUndefined();

    // Back at the top: only the bottom fade.
    setBox(app, { scrollHeight: 600, clientHeight: 300, scrollTop: 0 });
    act(() => {
      fireEvent.scroll(app);
    });
    expect(app.dataset.overflowAbove).toBeUndefined();
    expect(app.dataset.overflow).toBe("true");
    expect(screen.getByTestId("agent-panel").dataset.overflowAbove).toBeUndefined();
  });

  it("without ResizeObserver the panel renders unflagged (no fade, never a throw)", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    shell();
    expect(screen.getByTestId("app-panel").dataset.overflow).toBeUndefined();
    expect(screen.getByTestId("app-panel").dataset.overflowAbove).toBeUndefined();
  });
});
