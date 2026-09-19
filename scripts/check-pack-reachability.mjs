#!/usr/bin/env node
/**
 * guuey#1435 — pack reachability: every file a package would ship is
 * reachable from one of its entry points.
 *
 * Two packages shipped test-only trees to every consumer: agent-client's
 * `src/fixtures/*` plus the compiled fixture writer in `dist` (importing
 * `node:fs` inside the browser SDK), and chat's `src/corpus/**` — recorded
 * captures, a snapshot and the harness, 19% of the tarball. Both had a `files`
 * allowlist of `dist` + `src` minus `*.test.ts`, and that rule names a test
 * FILE and nothing else — not a fixture, a capture, a snapshot, a harness.
 * The obvious guard (flag `fixtures/`, `corpus/`, `__snapshots__/`) would not
 * have caught the first (no test file in it) and would one day flag a real
 * module that happens to carry such a name: a name is a proxy for "test-only",
 * and a proxy standing in for the thing is the species this repo keeps
 * chasing (guuey#1335). So the rule is the thing itself:
 *
 *   every file the pack would ship is REACHABLE from an entry point, or is a
 *   file npm always ships, or is a runtime asset declared below with a reason.
 *
 * Reachability, mechanically:
 *   - entry points: every string target under `exports` — every condition,
 *     because a consumer can reach any of them — plus `bin`, `main`, `module`,
 *     `types`. An entry the pack does not ship is a finding of its own.
 *   - a code file reaches what it imports. TypeScript's own scanner
 *     (`ts.preProcessFile`) reads static, dynamic (string-literal),
 *     `export … from`, `require()` and type-only imports alike. Relative
 *     specifiers resolve the NodeNext way (`./x.js` may be `x.ts` or `x.d.ts`
 *     in the tree that ships); bare specifiers are dependencies, out of scope.
 *   - a module reaches its compiler companions — `x.js` → `x.d.ts`, `x.js.map`;
 *     `x.cjs` → `x.d.cts`; `x.d.ts` → `x.d.ts.map` — the same sibling
 *     declaration TypeScript resolves for a consumer.
 *   - a source map reaches its `sources`. The declaration maps this cohort
 *     ships name `../src/<file>.ts`; that, and the `react-native` condition
 *     entering `src/` directly, is why a `src` tree is in a tarball at all.
 *   - the pack listing is npm's own (`npm pack --dry-run --json`), never a
 *     re-implementation of `files`. Scripts are ignored: ten packages' `prepack`
 *     is `rm -rf dist && pnpm build`, which would wipe dist under this guard.
 *
 * Run AFTER `pnpm build` (the publish gate does). Fails closed on what it
 * cannot follow: an `exports` subpath pattern, an entry the pack does not
 * ship, a shipped module importing a file the pack excludes, a declared asset
 * root with nothing under it. A computed specifier (`import('./' + name)`) is
 * printed as not followed so the reader knows the walk's scope.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const PACKAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages');

/**
 * Declarations — the two ways a shipped file is reached other than by an
 * import the scanner can read, each with the reason so the next reader can
 * check it still holds. A declaration nothing shipped answers to is itself a
 * finding: a declaration that names nothing is stale.
 *
 * RUNTIME_ENTRIES: modules a package loads by a path it computes at run time
 * (`await import(registry[name].module)`), invisible to any static scanner.
 * They are walked as entry points, so what THEY import becomes reachable. The
 * computed load itself is printed by the guard as "not followed", so the hole
 * the declaration covers stays visible in the output.
 */
export const RUNTIME_ENTRIES = {
  '@guuey/host': [
    // src/index.ts RUNNERS: `module` is a string in a table, loaded once per pod
    // by `await import(entry.module)` so only the one framework SDK is loaded.
    // A runner added to RUNNERS without a line here is flagged by this guard
    // until declared — or until the table is rewritten as literal
    // `() => import("./frameworks/x.js")` thunks, which need no declaration.
    { file: 'dist/frameworks/claude-runner.js', reason: 'RUNNERS["claude-agent-sdk"].module — loaded by import(entry.module) in src/index.ts' },
    { file: 'dist/frameworks/openai-runner.js', reason: 'RUNNERS["openai-agents-sdk"].module — loaded by import(entry.module) in src/index.ts' },
    { file: 'dist/frameworks/google-adk.js', reason: 'RUNNERS["google-adk"].module — loaded by import(entry.module) in src/index.ts' },
  ],
};

/**
 * RUNTIME_ASSETS: trees a package reads with `fs` at run time. Everything
 * under the prefix is allowed.
 */
export const RUNTIME_ASSETS = {
  '@guuey/create-agentic-app': [
    {
      prefix: 'dist/templates/',
      reason:
        'the scaffold templates: assembled by scripts/build-templates.mjs, copied at run time from join(packageRoot, "dist", "templates") (src/scaffold.ts, src/scaffold-mcp.ts)',
    },
  ],
};

/** What npm ships regardless of `files` — npm-packlist's own list, nothing more. */
const ALWAYS_SHIPPED = /^(?:package\.json|readme(?:\.[^/]*)?|licen[cs]e(?:\.[^/]*)?)$/i;

const CODE = /\.(?:[cm]?jsx?|[cm]?tsx?)$/;
const MAP = /\.map$/;

/** The tarball's file list, as npm computes it — relative posix paths. */
export function packList(dir) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [pack] = JSON.parse(out);
  return new Set(pack.files.map((f) => f.path));
}

function stringLeaves(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, out);
  return out;
}

/** Every file a consumer can name through the manifest, normalised to pack paths. */
export function entryPoints(manifest) {
  const raw = [];
  if (manifest.exports !== undefined) {
    const ex = manifest.exports;
    if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
      for (const key of Object.keys(ex)) {
        if (key.includes('*')) {
          throw new Error(
            `${manifest.name}: exports subpath pattern "${key}" — this guard does not expand patterns; teach it before shipping one`
          );
        }
      }
    }
    for (const target of stringLeaves(ex)) {
      if (target.includes('*')) throw new Error(`${manifest.name}: exports target pattern "${target}" is not supported by this guard`);
      raw.push(target);
    }
  }
  for (const key of ['main', 'module', 'types', 'typings']) if (typeof manifest[key] === 'string') raw.push(manifest[key]);
  if (typeof manifest.bin === 'string') raw.push(manifest.bin);
  else if (manifest.bin && typeof manifest.bin === 'object') raw.push(...Object.values(manifest.bin));
  return [...new Set(raw.map((p) => posix.normalize(p).replace(/^\.\//, '')))];
}

/**
 * Where a relative specifier may land, NodeNext-style: the path as written,
 * the source twins of an emitted extension (`./x.js` → `x.ts`, `x.tsx`,
 * `x.d.ts`), an added extension, or a directory index.
 */
const SOURCE_TWINS = { '.js': ['.ts', '.tsx', '.d.ts'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts'] };
const EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.d.ts', '.json'];
function candidates(base) {
  const list = [base];
  for (const [ext, twins] of Object.entries(SOURCE_TWINS)) {
    if (base.endsWith(ext)) for (const twin of twins) list.push(base.slice(0, -ext.length) + twin);
  }
  for (const ext of EXTENSIONS) list.push(base + ext);
  for (const ext of EXTENSIONS) list.push(posix.join(base, 'index' + ext));
  return list;
}

/** The compiler artifacts that belong to a module: its declaration and its maps. */
function companions(file) {
  if (file.endsWith('.d.ts') || file.endsWith('.d.cts') || file.endsWith('.d.mts')) return [`${file}.map`];
  if (file.endsWith('.js')) return [`${file.slice(0, -3)}.d.ts`, `${file}.map`];
  if (file.endsWith('.cjs')) return [`${file.slice(0, -4)}.d.cts`, `${file}.map`];
  if (file.endsWith('.mjs')) return [`${file.slice(0, -4)}.d.mts`, `${file}.map`];
  return [];
}

/**
 * Line numbers of `import(expr)` / `require(expr)` calls whose argument is not
 * a string literal — loads no scanner can follow, which `ts.preProcessFile`
 * silently omits. Printed so the walk's scope is visible; covered, where they
 * are real, by a RUNTIME_ENTRIES declaration.
 */
function computedLoads(file, text) {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : undefined;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const lines = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const arg = node.arguments[0];
      if (arg && !ts.isStringLiteralLike(arg)) lines.push(sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

/**
 * Walk one package. `list` lets a caller supply the pack listing; by default
 * it is read from npm. Returns every finding with the reason, and the
 * computed loads the walk could not follow.
 */
export function analyzePackage(dir, { runtimeAssets = RUNTIME_ASSETS, runtimeEntries = RUNTIME_ENTRIES, list } = {}) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const shipped = list ?? packList(dir);
  const findings = [];
  const unfollowed = [];
  const entries = entryPoints(manifest);
  const queue = [];
  for (const entry of entries) {
    if (shipped.has(entry)) queue.push(entry);
    else findings.push({ file: entry, why: 'named as an entry point (exports / bin / main / types) but not in the pack' });
  }
  const declaredEntries = runtimeEntries[manifest.name] ?? [];
  for (const { file } of declaredEntries) {
    if (shipped.has(file)) queue.push(file);
    else findings.push({ file, why: 'declared as a runtime entry, but the pack does not ship it — a stale declaration' });
  }

  const reachable = new Set();
  const isFile = (p) => existsSync(join(dir, p)) && statSync(join(dir, p)).isFile();
  while (queue.length > 0) {
    const file = queue.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const c of companions(file)) if (shipped.has(c)) queue.push(c);

    if (MAP.test(file)) {
      let sources;
      try {
        sources = JSON.parse(readFileSync(join(dir, file), 'utf8')).sources ?? [];
      } catch {
        findings.push({ file, why: 'source map is not JSON' });
        continue;
      }
      for (const source of sources) {
        const target = posix.normalize(posix.join(posix.dirname(file), source));
        if (shipped.has(target)) queue.push(target);
      }
      continue;
    }
    if (!CODE.test(file)) continue;

    const text = readFileSync(join(dir, file), 'utf8');
    for (const line of computedLoads(file, text)) unfollowed.push({ file, spec: `<computed> line ${line}` });
    const info = ts.preProcessFile(text, true, true);
    const specifiers = [
      ...info.importedFiles.map((f) => f.fileName).filter((s) => s.startsWith('./') || s.startsWith('../')),
      // `/// <reference path="…">` is always relative to the referencing file.
      ...info.referencedFiles.map((f) => f.fileName),
    ];
    for (const spec of specifiers) {
      // What the scanner leaves of `import('./' + name)` — already reported by
      // computedLoads above; ESM has no directory imports, so nothing to resolve.
      if (spec.endsWith('/')) continue;
      const base = posix.normalize(posix.join(posix.dirname(file), spec));
      const options = candidates(base);
      const hit = options.find((c) => shipped.has(c));
      if (hit) {
        queue.push(hit);
        continue;
      }
      const onDisk = options.find(isFile);
      if (onDisk) findings.push({ file, why: `imports "${spec}" → ${onDisk}, which the pack does not ship` });
      else unfollowed.push({ file, spec });
    }
  }

  const declared = runtimeAssets[manifest.name] ?? [];
  for (const asset of declared) {
    if (![...shipped].some((p) => p.startsWith(asset.prefix))) {
      findings.push({ file: asset.prefix, why: 'declared as a runtime asset root, but nothing shipped is under it — a stale declaration' });
    }
  }
  const unreachable = [...shipped]
    .filter((p) => !reachable.has(p) && !ALWAYS_SHIPPED.test(p) && !declared.some((a) => p.startsWith(a.prefix)))
    .sort();
  for (const file of unreachable) {
    findings.push({ file, why: 'shipped, but no entry point reaches it (not imported, not a companion, not in a source map, not a declared runtime asset)' });
  }

  return {
    name: manifest.name,
    shipped: shipped.size,
    reachable: reachable.size,
    entries,
    declared: declared.length + declaredEntries.length,
    findings,
    unfollowed,
  };
}

export function main(packagesDir = PACKAGES_DIR) {
  let red = 0;
  let scanned = 0;
  for (const name of readdirSync(packagesDir).sort()) {
    const dir = join(packagesDir, name);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'package.json'))) continue;
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (manifest.private) continue;
    scanned += 1;
    const r = analyzePackage(dir);
    if (r.findings.length === 0) {
      const extras = [r.declared ? `${r.declared} declaration(s)` : '', r.unfollowed.length ? `${r.unfollowed.length} computed load(s) not followed` : '']
        .filter(Boolean)
        .join(', ');
      console.log(`✓ ${r.name} — ${r.shipped} shipped, ${r.reachable} reachable from ${r.entries.length} entry point(s)${extras ? `; ${extras}` : ''}`);
    } else {
      red += 1;
      console.error(`✗ ${r.name} — ${r.findings.length} finding(s) over ${r.shipped} shipped files:`);
      for (const f of r.findings) console.error(`    ${f.file}: ${f.why}`);
    }
    for (const u of r.unfollowed) console.log(`    · not followed: ${u.file} ${u.spec} — a load by computed path, not a file the scanner can name`);
  }
  if (red > 0) {
    console.error(
      `\n${red} package(s) would ship files no entry point reaches. Exclude them from \`files\` (or from the build), or, for a tree the package reads with fs at run time, declare it in RUNTIME_ASSETS with the reason (guuey#1435).`
    );
    process.exit(1);
  }
  console.log(`\ncheck-pack-reachability: ${scanned} packages — every shipped file is reachable from an entry point, npm-always-shipped, or a declared runtime asset.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
