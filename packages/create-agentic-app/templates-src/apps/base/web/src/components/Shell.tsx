/**
 * Base-template chrome: brand header + nav + auth affordance. Pages render
 * inside via the router outlet.
 */
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { appConfig } from "../config";
import { CHAT_PATH, HOME_PATH } from "../routes";
import { currentIdentityMode, logOut } from "../lib/identity";
import { oidcConfigured, signOutOidc } from "../lib/oidc";

export function Shell() {
  const navigate = useNavigate();
  const [mode, setMode] = useState(currentIdentityMode());

  // Re-read on route changes triggered by login/logout.
  useEffect(() => {
    const onStorage = () => setMode(currentIdentityMode());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  async function handleLogOut() {
    if (mode === "oidc" && oidcConfigured()) await signOutOidc();
    logOut();
    setMode(null);
    navigate("/");
  }

  return (
    <div className="shell">
      {appConfig.demoMode ? (
        <div className="demo-strip">
          Demo — a fictional product built with guuey.{" "}
          <a href="https://guuey.com" target="_blank" rel="noreferrer">
            Build your own agentic app →
          </a>
        </div>
      ) : null}
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
