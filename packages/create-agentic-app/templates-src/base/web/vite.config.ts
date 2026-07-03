import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port is passed via the `dev` script's `--port 6890` flag (see package.json)
// so it stays visible in one place; `scripts/dev.mjs` boots this on the same
// port. No `server.port` override here — the CLI flag is the source of truth.
export default defineConfig({
  plugins: [react()],
});
