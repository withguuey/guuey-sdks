import { defineConfig } from 'tsup';

// Self-contained ON PURPOSE — do not delete this file. Without a local
// config, tsup's upward config discovery finds the scaffold ROOT
// tsup.config.ts; its bundled form imports 'tsup' from the scaffold root,
// which the platform image build deliberately leaves un-installed when the
// bundled guuey.worker.js skips the root install — every colocated build
// then dies with ERR_MODULE_NOT_FOUND (guuey#19). A config here stops the
// walk; `defineConfig` resolves from this package's own devDependencies.
export default defineConfig({
  entry: ['src/server.ts'],
  format: 'esm',
  outDir: 'dist',
});
