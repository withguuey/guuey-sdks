/**
 * The split sidebar (the agentic-app pattern):
 *
 *   ┌──────────┬────────────────────────┐
 *   │ ☰ Menu 1 │                        │
 *   │ ☰ Menu 2 │   FULLSCREEN AGENT     │
 *   │ ☰ Menu 3 │   chat + generative    │
 *   ├──────────┤   UI cards on the      │
 *   │ ● Agent  │   whole main canvas    │
 *   │ 📱 Talk   │                        │
 *   │   mobile │                        │
 *   └──────────┴────────────────────────┘
 *
 * Upper sidebar = your product's menus. Lower sidebar = the agent DOCK.
 * Activating the dock swaps the MAIN canvas to the fullscreen agent (the
 * generative-UI cards get the whole width) — the agent is never a cramped
 * pane inside the sidebar. Selecting a menu swaps the canvas back.
 */
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { appConfig } from "../config";
import { currentIdentityMode, logOut } from "../lib/identity";
import { oidcConfigured, signOutOidc } from "../lib/oidc";

export function AppShell() {
  const navigate = useNavigate();
  const mode = currentIdentityMode();

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
            <NavLink to="/app" end>
              Dashboard
            </NavLink>
            <NavLink to="/app/reports">Reports</NavLink>
            <NavLink to="/app/setup">Setup</NavLink>
          </nav>
          <nav className="sidebar-dock">
            <NavLink to="/app/agent" className="dock-agent">
              <span className="dock-dot" /> Agent
            </NavLink>
            <NavLink to="/app/mobile">📱 Talk on mobile</NavLink>
            <button type="button" className="dock-logout" onClick={() => void handleLogOut()}>
              Log out{mode === "guest" ? " (guest)" : ""}
            </button>
          </nav>
        </aside>
        <main className="canvas">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
