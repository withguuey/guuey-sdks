/**
 * Landing — the widget IS the hero (distribution way #1). On a linked app
 * the real guuey widget launcher mounts in the corner; before linking, an
 * honest placeholder explains what will appear here.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { appConfig, isLinked } from "../config";
import { CHAT_PATH, HOME_PATH } from "../routes";
import { mountWidget, type WidgetOutcome } from "../lib/widget";

export function Landing() {
  const [widget, setWidget] = useState<WidgetOutcome | "unlinked" | "loading">(
    isLinked ? "loading" : "unlinked",
  );

  useEffect(() => {
    if (!isLinked) return;
    mountWidget((outcome) => setWidget(outcome));
  }, []);

  return (
    <main className="page landing">
      <section className="hero">
        <h1>{appConfig.copy.landing.headline}</h1>
        <p>{appConfig.copy.landing.sub}</p>
        <div className="hero-actions">
          <Link to={CHAT_PATH} className="btn btn-accent">
            Open the chat
          </Link>
          <Link to={HOME_PATH} className="btn">
            How this app is wired
          </Link>
        </div>
        {widget === "unlinked" ? (
          <p className="hint">
            The floating agent launcher appears here once the app is bound to a
            deployed guuey agent — <code>pnpm bootstrap -- --link</code>.
          </p>
        ) : null}
        {widget === "offline" ? (
          <p className="hint">
            Widget script failed to load from this environment — check the app's
            Allowed Domains include this site.
          </p>
        ) : null}
      </section>
    </main>
  );
}
