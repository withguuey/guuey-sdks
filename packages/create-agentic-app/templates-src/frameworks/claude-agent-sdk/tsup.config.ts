import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "guuey.worker": "src/worker.ts" },
  format: ["esm"],
  outDir: ".",
  clean: false,
  noExternal: [/./], // bundle everything — the deploy tarball must be runnable via `node guuey.worker.js`
});
