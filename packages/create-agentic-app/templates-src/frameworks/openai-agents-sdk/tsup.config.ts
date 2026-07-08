import { defineConfig } from "tsup";

export default defineConfig({
  entry: { worker: "src/worker.ts" },
  format: ["esm"],
  outDir: ".",
  clean: false,
  // Dependencies stay EXTERNAL (tsup's default): @openai/agents' dependency
  // tree is not ESM-bundle-safe (debug's dynamic require("tty"); circular
  // class hierarchies in its MCP module — both crash a noExternal bundle at
  // boot, caught by the first live openai pod gate). The platform installs
  // deps from the lockfile at image-build time — the same registry-install
  // path the google-adk graceful lane uses. The output is `worker.js` (via
  // guuey.json#worker): the `guuey.worker.js` name specifically means
  // "self-contained, skip install" to the platform's image build.
});
