#!/usr/bin/env node
/**
 * guuey#153 — the plain-Node ESM import smoke.
 *
 * For every publishable package under packages/, import EVERY `exports`
 * subpath's `import`/`default` target under plain `node` — no bundler, no
 * tsx, no jest transform. This is the property that rotted silently once:
 * `tsc` emits relative specifiers verbatim, so a single extensionless
 * `from "./sse"` in a tsc-built package breaks every server-side npm
 * consumer at first import (ERR_MODULE_NOT_FOUND) while every
 * bundler/Metro consumer keeps working — no repo test path exercised the
 * dist graph the way a plain-Node consumer does.
 *
 * Each target is imported by its RESOLVED FILE PATH (the exports entry is
 * read and existence-checked by this script), so the smoke runs
 * identically in the monorepo and in the guuey-sdks mirror; the package's
 * own dependency chain still resolves node_modules the normal way, and
 * the dist-internal relative graph — the thing guuey#153 is about — is
 * walked by the real Node ESM resolver.
 *
 * Run AFTER `pnpm build` (release.yml gate job does).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages');

/**
 * Exports arms that are TEST-RUNNER-HOSTED by design: the `./testing`
 * contract suites import `vitest` at module scope and can only load inside
 * a vitest run ("Vitest failed to access its internal state" under bare
 * node). Importing them from a plain Node script is not a supported use,
 * so they are skipped EXPLICITLY — a new arm that fails under bare node
 * still fails this smoke until it is either fixed or classified here.
 */
const TEST_RUNNER_ONLY = new Set(['@guuey/state/testing', '@guuey/threads/testing']);

/**
 * An exports entry → its plain-Node ESM target, honoring the condition
 * order Node itself applies for `import` (skipping `react-native`/`types`,
 * which never apply under plain node).
 */
function importTarget(entry) {
  if (typeof entry === 'string') return entry;
  if (entry === null || typeof entry !== 'object') return undefined;
  return importTarget(entry.import ?? entry.node ?? entry.default);
}

let checked = 0;
let failures = 0;

for (const dir of readdirSync(PACKAGES_DIR).sort()) {
  const pkgPath = join(PACKAGES_DIR, dir, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.private) continue;

  const subpaths = pkg.exports
    ? Object.entries(pkg.exports).filter(([k]) => k === '.' || k.startsWith('./'))
    : [['.', pkg.main ?? './index.js']];

  for (const [subpath, entry] of subpaths) {
    if (subpath === './package.json') continue;
    const target = importTarget(entry);
    const label = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
    // Non-module assets (a shipped stylesheet) are existence-checked but not
    // imported — plain Node has no loader for them, and consumers reach them
    // through a bundler by design.
    if (target !== undefined && target.endsWith('.css')) {
      const assetFile = join(PACKAGES_DIR, dir, target);
      if (!existsSync(assetFile)) {
        console.error(`FAIL ${label} — exports target missing on disk: ${target}`);
        failures++;
      } else {
        console.log(`skip ${label} (stylesheet asset, existence-checked)`);
      }
      continue;
    }
    if (TEST_RUNNER_ONLY.has(label)) {
      console.log(`skip ${label} (test-runner-hosted contract suite)`);
      continue;
    }
    if (target === undefined) {
      console.error(`FAIL ${label} — exports entry has no import/default arm`);
      failures++;
      continue;
    }
    const file = join(PACKAGES_DIR, dir, target);
    checked++;
    if (!existsSync(file)) {
      console.error(`FAIL ${label} — exports target missing on disk: ${target}`);
      failures++;
      continue;
    }
    try {
      await import(pathToFileURL(file).href);
      console.log(`ok   ${label}`);
    } catch (err) {
      console.error(`FAIL ${label} — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      failures++;
    }
  }
}

if (checked === 0) {
  console.error('FAIL — no exports arms found to check (script broken or packages unbuilt)');
  process.exit(1);
}
console.log(`\n${checked} exports arms checked, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
