/**
 * "Talk on mobile" — a QR code to this agent in the guuey portal
 * (app.guuey.com and its env twins). The QR targets the agent's CARD page
 * (`/agent/<slug-or-appId>`), which resolves the live endpoint itself —
 * never the chat route directly. Plain URL today; upgrades to a native
 * deep link when portal applinks land (same path, so the QR stays valid).
 */
import { appConfig } from "../config";
import { QrLink } from "../components/QrLink";

export function TalkOnMobile() {
  const link = appConfig.link;
  const target = link ? `${link.portalUrl}/agent/${link.slug ?? link.appId}` : null;

  return (
    <div className="page mobile-page">
      <h1>Talk on mobile</h1>
      {target ? (
        <>
          <p className="calm">
            Scan with a phone — the same agent, in the guuey portal. (The portal
            has its own sign-in, so phone conversations are separate threads.)
          </p>
          <QrLink url={target} size={240} />
        </>
      ) : (
        <p className="calm">
          Available once the app is bound to a deployed guuey agent —{" "}
          <code>pnpm bootstrap -- --link</code>.
        </p>
      )}
    </div>
  );
}
