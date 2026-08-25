// @vitest-environment jsdom
/**
 * The React layer over the REAL machine: token application, the follow,
 * capture-phase menu wiring, the route-derived signal, the (d) working
 * state, floor rejection at wiring time, and the own-provider render
 * isolation contract's visible half (context changes only on transitions).
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("founder (d): the working state", () => {
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
});
