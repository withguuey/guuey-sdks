import { defineConfig } from "tsup";

export default defineConfig({
  entry: { agent: "src/agent.ts" },
  format: ["esm"],
  outDir: ".",
  clean: false,
  // Dependencies stay EXTERNAL (tsup's default): the platform installs them
  // from the lockfile at image-build time and the Guuey host imports your
  // agent.js — with @google/adk resolved from YOUR node_modules (your pinned
  // version wins). Do NOT bundle @google/adk; its dependency tree is not
  // bundler-safe.
});
