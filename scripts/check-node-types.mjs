#!/usr/bin/env node
/**
 * Every package that imports a `node:` builtin must DECLARE `@types/node`.
 *
 * guuey#1406. The mirror publishes `oss/` as a standalone workspace, so a
 * package there sees only what it declares. `@guuey/agent-client` imported
 * `node:fs` / `node:path` / `node:url` in a test without declaring the types:
 * under vitest 3 they arrived transitively, under vitest 4 they did not, and
 * the mirror gate went red (guuey#1389) while the monorepo stayed green —
 * the root hoists the types for other packages.
 *
 * The isolated extract gate did NOT catch it: pnpm's hoisted fallback
 * directory on a developer machine exposes `@types/node` where a strict CI
 * install does not, and TypeScript's NodeNext resolution walks up into it.
 * That gate's verdict therefore depended on the machine it ran on rather
 * than the tree it judged.
 *
 * This check does not depend on resolution at all: it reads the source for
 * `node:` imports and the manifest for the declaration, so it returns the
 * same answer on any machine, warm store or cold.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const packagesDir = new URL("../packages/", import.meta.url).pathname;
const NODE_IMPORT = /(?:from|import|require\()\s*["']node:[a-z/]+["']/;
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/** Every source file under a directory, skipping build output and deps. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (SOURCE.test(entry.name)) out.push(path);
  }
  return out;
}

let violations = 0;
let scanned = 0;
const importers = [];

for (const name of readdirSync(packagesDir)) {
  const root = join(packagesDir, name);
  if (!statSync(root).isDirectory()) continue;
  const manifestPath = join(root, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    continue;
  }
  scanned += 1;

  const srcDir = join(root, "src");
  let files;
  try {
    files = sourceFiles(srcDir);
  } catch {
    continue; // no src/ — nothing to import from
  }

  const hits = files.filter((f) => NODE_IMPORT.test(readFileSync(f, "utf8")));
  if (hits.length === 0) continue;

  const declared =
    manifest.devDependencies?.["@types/node"] ?? manifest.dependencies?.["@types/node"] ?? null;
  importers.push({ name: manifest.name ?? name, count: hits.length, declared });

  if (declared === null) {
    violations += 1;
    console.error(
      `✗ ${manifest.name ?? name} imports node: builtins in ${hits.length} file(s) but declares no @types/node`,
    );
    for (const f of hits.slice(0, 5)) console.error(`    ${f.slice(root.length + 1)}`);
  }
}

for (const i of importers.filter((i) => i.declared !== null)) {
  console.log(`✓ ${i.name} — ${i.count} node: importer(s), @types/node ${i.declared}`);
}

if (violations > 0) {
  console.error(
    `\n${violations} package(s) import node: builtins without declaring @types/node. The mirror installs oss/ standalone, so an undeclared type is a red there even when the monorepo is green (guuey#1389, guuey#1406).`,
  );
  process.exit(1);
}
console.log(
  `\ncheck-node-types: ${importers.length} of ${scanned} packages import node: builtins; every one declares @types/node.`,
);
