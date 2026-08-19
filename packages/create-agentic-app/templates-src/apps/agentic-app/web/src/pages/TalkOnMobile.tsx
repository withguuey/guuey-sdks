/**
 * "Talk on mobile" — a QR code to this agent in the guuey portal
 * (app.guuey.com and its env twins). The QR targets the agent's CARD page
 * (`/agent/<slug-or-appId>`), which resolves the live endpoint itself —
 * never the chat route directly. Plain URL today; upgrades to a native
 * deep link when portal applinks land (same path, so the QR stays valid).
 */
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { appConfig } from "../config";

export function TalkOnMobile() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = appConfig.link;
  const target = link ? `${link.portalUrl}/agent/${link.slug ?? link.appId}` : null;

  useEffect(() => {
    if (!target || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, target, { width: 240, margin: 1 }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [target]);

  return (
    <div className="page mobile-page">
      <h1>Talk on mobile</h1>
      {target ? (
        <>
          <p className="calm">
            Scan with a phone — the same agent, same memory, in the guuey portal.
          </p>
          <canvas ref={canvasRef} className="qr" />
          <p>
            <a href={target} target="_blank" rel="noreferrer">
              {target}
            </a>
          </p>
          {error ? <p className="error">QR render failed: {error}</p> : null}
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
