import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const define = { __CLI_VERSION__: JSON.stringify(pkg.version) };

// Two builds, not one with two entries: tsup's `format` is per build, and the
// two outputs have different consumers. `index` is the programmatic API and
// ships ESM + CommonJS + declarations because package.json#exports names all
// three. `cli` is the bin — package.json#bin runs dist/cli.js and nothing can
// name a CommonJS twin or a declaration of it, so neither is built; both used
// to ship to every consumer as dead weight (guuey#1435).
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    define,
  },
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    dts: false,
    define,
  },
]);
