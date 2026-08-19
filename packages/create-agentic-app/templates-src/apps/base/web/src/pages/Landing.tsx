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
import { QrLink } from "../components/QrLink";

export function Landing() {
  const [widget, setWidget] = useState<WidgetOutcome | "unlinked" | "loading">(
    isLinked ? "loading" : "unlinked",
  );

  useEffect(() => {
    if (!isLinked) return;
    mountWidget((outcome) => setWidget(outcome));
  }, []);

  // The demo posture (spec §2.3): a REAL product site whose hero's one job
  // is getting the visitor INTO the demo — big CTA to the console page +
  // a QR to continue on mobile via the portal.
  const portalTarget =
    appConfig.link !== null
      ? `${appConfig.link.portalUrl}/agent/${appConfig.link.slug ?? appConfig.link.appId}`
      : null;

  return (
    <main className="page landing">
      <section className="hero" data-tour="hero">
        <h1>{appConfig.copy.landing.headline}</h1>
        <p>{appConfig.copy.landing.sub}</p>
        <div className="hero-actions">
          <Link to={CHAT_PATH} className="btn btn-accent">
            {appConfig.demoMode ? "Enter the demo" : "Open the chat"}
          </Link>
          <Link to={HOME_PATH} className="btn">
            How this app is wired
          </Link>
        </div>
        {appConfig.demoMode && portalTarget !== null ? (
          <div className="hero-qr">
            <p className="hint">Or continue on your phone:</p>
            <QrLink url={portalTarget} size={140} />
          </div>
        ) : null}
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
