/** A QR code for a URL, with the plain link beneath — mobile hand-off. */
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

export function QrLink({ url, size = 200 }: { url: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, url, { width: size, margin: 1 }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [url, size]);

  return (
    <span className="qr-link">
      <canvas ref={canvasRef} className="qr" />
      <a href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
      {error ? <span className="error">QR render failed: {error}</span> : null}
    </span>
  );
}
