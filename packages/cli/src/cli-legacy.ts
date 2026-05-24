#!/usr/bin/env node
/**
 * Legacy `ggui` binary entry — deprecation shim.
 *
 * Prints a one-line deprecation notice, then delegates to the canonical
 * `guuey` CLI (same compiled module). Silence with GUUEY_SILENCE_LEGACY=1.
 *
 * Removal target: 2026-07-12.
 */

if (process.env.GUUEY_SILENCE_LEGACY !== '1') {
  process.stderr.write(
    '\x1b[33m[deprecated]\x1b[0m The `ggui` binary is now `guuey`. ' +
      'Run the same command with `guuey` instead. ' +
      'Silence with GUUEY_SILENCE_LEGACY=1. Removal: 2026-07-12.\n',
  );
}

// Dynamic import triggers cli.ts's top-level main() execution.
// Wrapped in an IIFE so this file compiles under both ESM and CJS outputs.
void (async () => {
  await import('./cli.js');
})();

export {};
