/**
 * Dev-time gate: until `pnpm bootstrap` has run, every page renders this
 * setup screen instead of a half-configured app. Production builds are
 * gated harder — vite.config.ts fails the build outright.
 */
import type { ReactNode } from "react";
import { appConfig } from "../config";

export function BootstrapGate({ children }: { children: ReactNode }) {
  if (appConfig.bootstrapped) return <>{children}</>;
  return (
    <main className="gate">
      <div className="gate-card">
        <h1>Run bootstrap first</h1>
        <p>
          This project has not been configured yet. From the project root:
        </p>
        <pre>
          <code>pnpm bootstrap</code>
        </pre>
        <p>
          That writes <code>guuey.app.json</code> (brand, theme, copy) and
          regenerates <code>AGENTS.md</code>. Then start the local stack with{" "}
          <code>pnpm dev</code>. When you are ready to bind a deployed guuey
          app: <code>pnpm bootstrap -- --link</code>.
        </p>
      </div>
    </main>
  );
}
