import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Fail-loud production gate (never a half-styled deploy): `pnpm bootstrap`
 * not run yet → the BUILD fails with the exact command. An UNLINKED build
 * is allowed — the pages state the missing binding honestly — but gets a
 * loud warning, since a deployed frontend without a bound guuey app has no
 * live agent to talk to.
 *
 * Dev is NOT gated here — `src/components/BootstrapGate.tsx` renders the
 * "run bootstrap first" screen instead, so `pnpm dev` always starts.
 */
function bootstrapGatePlugin(): Plugin {
  return {
    name: "guuey-bootstrap-gate",
    apply: "build",
    buildStart() {
      const raw = readFileSync(join(projectRoot, "guuey.app.json"), "utf8");
      const app = JSON.parse(raw) as { bootstrapped?: boolean; link?: object | null };
      if (app.bootstrapped !== true) {
        throw new Error(
          "guuey.app.json is not bootstrapped — run `pnpm bootstrap` at the project root first.",
        );
      }
      if (!app.link) {
        console.warn(
          "[guuey-bootstrap-gate] building WITHOUT a bound guuey app — the deployed site will have " +
            "no live agent until you run `pnpm bootstrap -- --link --app-id <appId>` and rebuild.",
        );
      }
    },
  };
}

// Port is passed via the `dev` script's `--port 6890` flag (see package.json)
// so it stays visible in one place; `scripts/dev.mjs` boots this on the same
// port.
export default defineConfig({
  plugins: [react(), bootstrapGatePlugin()],
});
