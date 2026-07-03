import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sandboxProxyPlugin } from "./sandbox-proxy";

// Port is passed via the `dev` script's `--port 6890` flag (see package.json)
// so it stays visible in one place; `scripts/dev.mjs` boots this on the same
// port. The sandbox proxy plugin serves the MCP-Apps sandbox page on :6891 —
// a SECOND origin, as the spec's double-iframe architecture requires (see
// ./sandbox-proxy.ts).
export default defineConfig({
  plugins: [react(), sandboxProxyPlugin()],
});
