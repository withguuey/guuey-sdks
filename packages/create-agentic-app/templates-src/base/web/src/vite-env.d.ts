/// <reference types="vite/client" />

/**
 * Typed Vite env vars. `import.meta.env` is Vite's analog of Next.js's
 * `process.env.NEXT_PUBLIC_*` — anything declared here is exposed to the
 * browser bundle at build time.
 */
interface ImportMetaEnv {
  /**
   * The agent's base URL (e.g. `http://localhost:6790` in local dev, via
   * `guuey dev`). Falls back to that same local-dev default when unset —
   * see `useAgentChat.ts`.
   */
  readonly VITE_AGENT_ENDPOINT_URL?: string;
  /**
   * Second-origin MCP-Apps sandbox page URL for `<AppRenderer>` (e.g.
   * `https://sandbox.example.com/sandbox.html`). Optional in dev — the
   * `sandboxProxyPlugin` in `vite.config.ts` serves one on :6891. REQUIRED
   * for deployed builds that render UI resources: without it the app shows
   * a plain-text notice instead (see `App.tsx` + `../sandbox-proxy.ts`).
   */
  readonly VITE_SANDBOX_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
