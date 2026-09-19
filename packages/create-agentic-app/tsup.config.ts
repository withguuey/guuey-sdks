import { defineConfig } from 'tsup';

// ESM only: the package has no `exports` map, `main` is dist/index.js and
// `bin` is dist/cli.js, so no consumer can name a CommonJS twin — the four
// that used to be built (index.cjs, cli.cjs and their .d.cts) shipped to every
// consumer as dead weight (guuey#1435).
export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
});
