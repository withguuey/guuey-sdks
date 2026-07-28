/**
 * Post-build smoke: prove the BUILT package is importable the way a customer
 * imports it, and that nothing in `dist` carries an extension-less relative
 * specifier.
 *
 * ## Why this exists
 *
 * The T11 review found the published package was unimportable: `tsconfig` used
 * `moduleResolution: "bundler"`, so `tsc` emitted `from './errors'` verbatim
 * into `dist/index.js`, and Node's ESM resolver requires the extension. The
 * package's only function was unreachable with `ERR_MODULE_NOT_FOUND`.
 *
 * **Nothing in the pipeline caught it**, and that is the point of this file. The
 * unit suite imports from `src` through vitest's bundler-style resolver, which
 * happily resolves the extension-less specifier; `tsc --noEmit` is clean because
 * the defect is in what is EMITTED, not in what typechecks; and the release
 * workflow's only pre-publish gate is `pnpm publish --dry-run`, which packs a
 * broken tarball without complaint. The gap was structural — every existing
 * check looks at source, and the defect only exists in the artifact.
 *
 * ## Two checks, because one is not enough
 *
 * 1. **Import `dist/index.js` with Node's real resolver.** This is the customer's
 *    exact path. It catches the runtime half.
 * 2. **Scan every emitted `.js` AND `.d.ts` for extension-less relative
 *    specifiers.** The `.d.ts` carries the same defect independently: a runtime
 *    import cannot detect it, but a consumer on `node16`/`nodenext` resolution
 *    fails to typecheck against the package. Check 1 alone would ship that.
 *
 * A first npm publish is a manual operator cut and irreversible per version, so
 * this runs as part of `pnpm test` rather than living in a runbook.
 *
 * **Candidate for the other oss leaf packages.** `@guuey/state` has the correct
 * tsconfig but no equivalent guard, and `@guuey/fs` avoids the class only by
 * being a single file — neither would catch a regression. Lifting this into a
 * shared check is worth doing when someone touches that cohort.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(packageRoot, 'dist');

/** The exports a customer is entitled to find. */
const REQUIRED_EXPORTS = [
  'signUserToken',
  'WidgetAuthError',
  'WidgetAuthConfigError',
  'WidgetAuthCredentialError',
  'WidgetAuthAppNotConfiguredError',
  'WidgetAuthRequestError',
  'WidgetAuthServiceError',
  'WidgetAuthNetworkError',
];

/**
 * A relative specifier with no file extension, in either an `import`/`export …
 * from` clause or a dynamic `import()`. Matched on the emitted text because that
 * is the artifact Node reads — checking source would reproduce the original bug,
 * where the source was fine and the emit was not.
 */
const EXTENSIONLESS_RELATIVE = /(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g;

function fail(message) {
  console.error(`\n✗ import smoke FAILED\n\n  ${message}\n`);
  process.exit(1);
}

function listDist(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    fail(`No dist/ at ${dir}. Run \`pnpm build\` first.`);
  }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listDist(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

// ── Check 2 first: it names the offending file, which is a better failure
// message than the resolver's, and it covers the .d.ts the import cannot reach.
const offenders = [];
for (const file of listDist(distDir)) {
  const text = readFileSync(file, 'utf8');
  for (const [, specifier] of text.matchAll(EXTENSIONLESS_RELATIVE)) {
    if (!/\.[cm]?js$/.test(specifier) && !/\.json$/.test(specifier)) {
      offenders.push(`${file.slice(packageRoot.length + 1)} → "${specifier}"`);
    }
  }
}
if (offenders.length > 0) {
  fail(
    `Emitted files carry relative specifiers with no extension, which Node's ESM ` +
      `resolver rejects:\n\n    ${offenders.join('\n    ')}\n\n  ` +
      `Fix: write the extension in source ("./errors.js"), and keep tsconfig on ` +
      `module/moduleResolution NodeNext.`,
  );
}

// ── Check 1: the customer's exact path.
let mod;
try {
  mod = await import(join(distDir, 'index.js'));
} catch (err) {
  fail(
    `The built package could not be imported by Node — this is exactly what a ` +
      `customer would hit:\n\n    ${err.code ?? 'ERROR'}: ${String(err.message).split('\n')[0]}`,
  );
}

const missing = REQUIRED_EXPORTS.filter((name) => mod[name] === undefined);
if (missing.length > 0) {
  fail(`The built package is missing exports: ${missing.join(', ')}`);
}
if (typeof mod.signUserToken !== 'function') {
  fail('The built package exports `signUserToken`, but it is not a function.');
}

console.log(
  `✓ import smoke: dist/index.js imports under Node ${process.version} with all ` +
    `${REQUIRED_EXPORTS.length} exports present, and no extension-less relative specifiers in dist.`,
);
