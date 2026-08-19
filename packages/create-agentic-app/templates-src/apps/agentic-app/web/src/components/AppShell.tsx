/**
 * The CHAT-RAIL shell (guuey#303, founder-confirmed):
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
 */
import { useCallback, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import type { PlanViewSummary, ViewRefItem } from "@guuey/chat";
import { GuueyView } from "@guuey/mcp-apps-host/react";
import { appConfig } from "../config";
import { AgentChat } from "../components/AgentChat";
import { currentIdentityMode, logOut } from "../lib/identity";
import { oidcConfigured, signOutOidc } from "../lib/oidc";

export function AppShell() {
  const navigate = useNavigate();
  const mode = currentIdentityMode();

  // The rail↔canvas bridge: the kit's view roster (mount material lives
  // here, the rail shows only chips), the selected key, and whether the
  // canvas currently shows a view or the routed pages.
  const [views, setViews] = useState<PlanViewSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [canvasShowsView, setCanvasShowsView] = useState(false);
  const newestKeyRef = useRef<string | undefined>(undefined);

  const onViewsChange = useCallback((next: PlanViewSummary[]) => {
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
  }, []);

  const onViewRef = useCallback((item: ViewRefItem) => {
    setSelectedKey(item.key);
    setCanvasShowsView(true);
  }, []);

  const selected = views.find((v) => v.key === selectedKey && v.mount !== null);

  async function handleLogOut() {
    if (mode === "oidc" && oidcConfigured()) await signOutOidc();
    logOut();
    navigate("/");
  }

  return (
    <div className="app-shell">
      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <span className="brand-mark">{appConfig.brand.logoText}</span>
            <span>{appConfig.brand.name}</span>
          </div>
          <nav className="sidebar-menus">
            {/* Picking a menu swaps the canvas back to your pages. */}
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
          <div className="agent-rail" data-tour="agent-rail">
            <AgentChat
              className="rail-chat"
              viewsBridge={{ promotedViewKey: selectedKey, onViewRef, onViewsChange }}
            />
          </div>
        </aside>
        <main className="canvas" data-tour="canvas">
          {canvasShowsView && selected !== undefined && selected.mount !== null ? (
            <div className="canvas-view">
              <header className="canvas-view-bar">
                <span>{selected.title}</span>
                <button type="button" className="btn" onClick={() => setCanvasShowsView(false)}>
                  Back to {appConfig.brand.name}
                </button>
              </header>
              {selected.mount.channel !== "locator" ? (
                <GuueyView
                  key={selected.key}
                  mount={selected.mount}
                  title={selected.title}
                  className="canvas-view-mount"
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
        </main>
      </div>
    </div>
  );
}
