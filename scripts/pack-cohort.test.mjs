// Exit codes: node --test — 0 pass · 1 fail. Reads ONLY inside oss/ (the mirror
// installs oss/ standalone; a guard that reads outside it is fatal there).
//
// The scaffold smoke's pack cohort is DERIVED from the workspace, never listed
// by name (guuey#1528): a by-name list missed @guuey/hooks the day it joined
// as a dependency of @guuey/config, and the release gate's scaffolded-app
// install fetched it from a registry it is not on yet (ERR_PNPM_FETCH_404).
// This pins the derivation to the tree: every publishable @guuey/* (and the
// bare `guuey` forwarder) under packages/ is packed; private manifests are not.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url).pathname;
const packagesDir = join(root, "packages");
const { INTERNAL_COHORT } = await import(
  join(root, "packages", "create-agentic-app", "scripts", "lib", "pack-cohort.mjs")
);

const expected = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(packagesDir, d.name, "package.json")))
  .map((d) => ({ dir: d.name, manifest: JSON.parse(readFileSync(join(packagesDir, d.name, "package.json"), "utf8")) }))
  .filter(({ manifest }) => manifest.private !== true && (manifest.name === "guuey" || manifest.name.startsWith("@guuey/")))
  .map(({ dir }) => dir)
  .sort();

test("the smoke packs every publishable package under packages/ — derived, not listed", () => {
  assert.deepEqual(INTERNAL_COHORT.map((p) => basename(p)).sort(), expected);
});

test("the cohort carries the transitive members a scaffolded app pulls (config and its dependency hooks)", () => {
  const names = INTERNAL_COHORT.map((p) => basename(p));
  assert.ok(names.includes("config"), "config");
  assert.ok(names.includes("hooks"), "hooks — @guuey/config depends on it (guuey#1528)");
});

test("a private manifest is never packed", () => {
  for (const dir of INTERNAL_COHORT) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.notEqual(manifest.private, true, `${basename(dir)} is private`);
  }
});
