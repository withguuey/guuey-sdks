/**
 * Placeholder product page — REPLACE with your app's real dashboard. It
 * exists so the shell demonstrates the swap: menus render your product
 * here; the agent dock swaps this canvas for the fullscreen agent.
 */
import { Link } from "react-router-dom";
import { appConfig } from "../config";

export function Dashboard() {
  return (
    <div className="page">
      <h1>Dashboard</h1>
      <p className="calm">
        This is your product's canvas — replace this page with the real thing. The agent lives in
        the RAIL at the bottom of the sidebar: type there, and any UI the agent draws takes this
        whole canvas (the rail's chips are the history — click one to bring its render back).
      </p>
      <section className="card">
        <h2>Getting oriented</h2>
        <ul>
          <li>
            <Link to="/app/mobile">📱 Talk on mobile</Link> — the same agent, on a phone via the
            guuey portal
          </li>
          <li>
            <Link to="/app/setup">Setup</Link> — live status + the three distribution channels for{" "}
            {appConfig.brand.name}
          </li>
        </ul>
      </section>
    </div>
  );
}
