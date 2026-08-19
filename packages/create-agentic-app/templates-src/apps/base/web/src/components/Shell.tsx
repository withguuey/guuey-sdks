/**
 * Base-template chrome: brand header + nav + auth affordance. Pages render
 * inside via the router outlet.
 */
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { appConfig } from "../config";
import { CHAT_PATH, HOME_PATH } from "../routes";
import { currentIdentityMode, logOut } from "../lib/identity";
import { oidcConfigured, signOutOidc } from "../lib/oidc";

export function Shell() {
  const navigate = useNavigate();
  // Subscribing to the location re-renders this chrome on every navigation,
  // so the render-time read below stays fresh after login/logout. (A
  // `storage` listener would NOT work — that event only fires in OTHER
  // tabs, never the one that wrote the change.)
  useLocation();
  const mode = currentIdentityMode();

  async function handleLogOut() {
    if (mode === "oidc" && oidcConfigured()) await signOutOidc();
    logOut();
    navigate("/");
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">{appConfig.brand.logoText}</span>
          <span>{appConfig.brand.name}</span>
        </Link>
        <nav>
          <NavLink to={CHAT_PATH}>Chat</NavLink>
          <NavLink to={HOME_PATH}>Home</NavLink>
          {mode === null ? (
            <NavLink to="/login" className="btn btn-accent">
              Sign in
            </NavLink>
          ) : (
            <button type="button" className="btn" onClick={() => void handleLogOut()}>
              Log out{mode === "guest" ? " (guest)" : ""}
            </button>
          )}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
