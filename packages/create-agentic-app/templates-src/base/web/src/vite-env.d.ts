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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
