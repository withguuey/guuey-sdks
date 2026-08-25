/**
 * The CHAT-RAIL shell (guuey#303, founder-confirmed), on
 * `@guuey/agent-layout` (guuey#403 — this migration is the lib's
 * acceptance test):
 *
 *   ┌──────────┬────────────────────────┐
 *   │ ☰ Menu 1 │                        │
 *   │ ☰ Menu 2 │   MAIN CANVAS          │
 *   │ ☰ Menu 3 │   your pages — or the  │
 *   ├──────────┤   full generated UI    │
 *   │ AGENT    │   when the agent draws │
 *   │ RAIL     │   one                  │
 *   │ (chat)   │                        │
 *   └──────────┴────────────────────────┘
 *
 * Upper sidebar = your product's menus. LOWER sidebar = the embed-SDK
 * agent rail — the visitor TYPES THERE; generative views collapse to
 * compact CHIPS in the rail (the kit's chips presentation) and the full
 * render takes the MAIN canvas. Chips are the history: clicking one
 * re-selects its render onto the canvas ("just like a web browser's
 * history"); a new render navigates forward automatically; picking a
 * menu swaps the canvas back to your pages.
 *
 * The layout lib owns the AGENT-MODE physics — the two-tone sidebar, the
 * pane's ground following the user's attention (submit → agent tone; any
 * navigation → app tone, derived from the route change), the working
 * state while the agent has the room, light/dark via the SAME mode you
 * give the chat. The shell wires it once: `navigationKey` from the
 * router, `bindGuueyChat` onto the rail, `agentViewClosed` on the back
 * affordance. Zero per-link wiring.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { GuueyChatHandle } from "@guuey/chat/react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import type { PlanViewSummary, ViewRefItem } from "@guuey/chat";
import { GuueyView } from "@guuey/mcp-apps-host/react";
import {
  ActivePane,
  AgentModeProvider,
  AgentModeShell,
  AgentModeSidebar,
  SidebarPanel,
  bindGuueyChat,
  useAgentMode,
} from "@guuey/agent-layout/react";
import { appConfig } from "../config";
import { AgentChat } from "../components/AgentChat";
import { currentIdentityMode, logOut } from "../lib/identity";
import { oidcConfigured, signOutOidc } from "../lib/oidc";

export function AppShell() {
  const location = useLocation();
  return (
    <AgentModeProvider
      mode={appConfig.theme.mode}
      navigationKey={location.pathname}
      identity={<span className="brand-mark">{appConfig.brand.logoText}</span>}
    >
      <ShellBody />
    </AgentModeProvider>
  );
}

function ShellBody() {
  const navigate = useNavigate();
  const mode = currentIdentityMode();
  const { dispatch } = useAgentMode();
  // The lib's chat bridge: submit/settle/view-mount flow into the
  // active-panel machine; the shell composes its own roster handling on top.
  const binding = useMemo(() => bindGuueyChat(dispatch), [dispatch]);

  // The rail↔canvas bridge: the kit's view roster (mount material lives
  // here, the rail shows only chips), the selected key, and whether the
  // canvas currently shows a view or the routed pages.
  const [views, setViews] = useState<PlanViewSummary[]>([]);
  // The chat handle carries the kit's view-host wiring (action relay,
  // model-context sink, theme announce) — the canvas mounts with it so a
  // rendered card's Confirm works OUTSIDE the transcript too (guuey#335).
  const [chat, setChat] = useState<GuueyChatHandle | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [canvasShowsView, setCanvasShowsView] = useState(false);
  const newestKeyRef = useRef<string | undefined>(undefined);

  const onViewsChange = useCallback(
    (next: PlanViewSummary[]) => {
      binding.onViewsChange(next); // the (d) working state clears on a live mount
      setViews(next);
      // Browser-history forward-navigation: a NEW live render takes the
      // canvas. (Reversed find = newest mountable; live entries sit after
      // history in the roster's transcript order.)
      const newest = [...next].reverse().find((v) => v.mount !== null && v.phase !== "expired");
      if (newest !== undefined && newest.key !== newestKeyRef.current) {
        newestKeyRef.current = newest.key;
        setSelectedKey(newest.key);
        setCanvasShowsView(true);
        // The demo-tour hook (guuey#303): step machines outside the app can
        // key on "the agent just drew UI".
        window.dispatchEvent(
          new CustomEvent("demo:render-complete", {
            detail: { key: newest.key, title: newest.title },
          }),
        );
      }
    },
    [binding],
  );

  const onViewRef = useCallback((item: ViewRefItem) => {
    setSelectedKey(item.key);
    setCanvasShowsView(true);
  }, []);

  const closeView = useCallback(() => {
    setCanvasShowsView(false);
    // The lib rule: closing an agent view returns the tone to the menu
    // UNLESS a turn is still streaming.
    dispatch({ type: "agentViewClosed" });
  }, [dispatch]);

  const selected = views.find((v) => v.key === selectedKey && v.mount !== null);

  async function handleLogOut() {
    if (mode === "oidc" && oidcConfigured()) await signOutOidc();
    logOut();
    navigate("/");
  }

  return (
    <div className="app-shell">
      <AgentModeShell className="app-body">
        <AgentModeSidebar className="sidebar">
          <SidebarPanel section="app" className="sidebar-top">
            <div className="sidebar-brand">
              <span className="brand-mark">{appConfig.brand.logoText}</span>
              <span>{appConfig.brand.name}</span>
            </div>
            <nav className="sidebar-menus">
              {/* Picking a menu swaps the canvas back to your pages — the
                  TONE follow is the lib's (route change + capture-phase). */}
              <NavLink to="/app" end onClick={() => setCanvasShowsView(false)}>
                Dashboard
              </NavLink>
              <NavLink to="/app/reports" onClick={() => setCanvasShowsView(false)}>
                Reports
              </NavLink>
              <NavLink to="/app/setup" onClick={() => setCanvasShowsView(false)}>
                Setup
              </NavLink>
              <NavLink to="/app/mobile" onClick={() => setCanvasShowsView(false)}>
                📱 Talk on mobile
              </NavLink>
              <button type="button" className="dock-logout" onClick={() => void handleLogOut()}>
                Log out{mode === "guest" ? " (guest)" : ""}
              </button>
            </nav>
          </SidebarPanel>
          <SidebarPanel section="agent" className="agent-rail" data-tour="agent-rail">
            <AgentChat
              className="rail-chat"
              viewsBridge={{ promotedViewKey: selectedKey, onViewRef, onViewsChange }}
              onReady={setChat}
              onActivity={binding.onActivity}
            />
          </SidebarPanel>
        </AgentModeSidebar>
        <ActivePane className="canvas" data-tour="canvas">
          {canvasShowsView && selected !== undefined && selected.mount !== null ? (
            <div className="canvas-view">
              <header className="canvas-view-bar">
                <span>{selected.title}</span>
                <button type="button" className="btn" onClick={closeView}>
                  Back to {appConfig.brand.name}
                </button>
              </header>
              {selected.mount.channel !== "locator" ? (
                <GuueyView
                  key={selected.key}
                  mount={selected.mount}
                  title={selected.title}
                  className="canvas-view-mount"
                  // The kit's slot wiring (guuey#335): action relay +
                  // model-context sink + the #302 theme announce, identical
                  // to the transcript's own mounts — Confirm inside a
                  // canvas-mounted card is a tools/call and needs the relay.
                  {...(chat !== null ? chat.viewSlotProps() : {})}
                  // Explicit announce kept (same value the kit defaults):
                  // the canvas mounts correctly even pre-handle.
                  hostContext={{ theme: appConfig.theme.mode }}
                />
              ) : (
                // A locator still resolving — the kit reads it and the next
                // roster emission carries the material (a FAILED read
                // surfaces as the chip's expired state instead).
                <p className="calm canvas-view-loading">Loading card…</p>
              )}
            </div>
          ) : (
            <Outlet />
          )}
        </ActivePane>
      </AgentModeShell>
    </div>
  );
}
