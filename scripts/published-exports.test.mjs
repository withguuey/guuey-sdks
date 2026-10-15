/**
 * guuey#2299 — a published package's export map points at compiled output only.
 *
 * Inside this workspace, three packages declare a `react-native` export condition that
 * targets their TypeScript source (`./src/*.ts`), so an app bundling them from the
 * workspace can use the source directly. That source imports its siblings by
 * NodeNext-style `./x.js` specifiers, which a stock Metro resolver does not map to
 * `./x.ts`. An npm consumer must therefore never be sent to `src/`: what reaches npm is
 * `publishConfig.exports`, which `pnpm publish` writes over `exports` in the packed
 * manifest. The rule, per package:
 *
 *   - the PUBLISHED map (`publishConfig.exports` when present, else `exports`) has no
 *     target under `./src/` and no `.ts`/`.tsx` target, in any condition of any subpath;
 *   - when `publishConfig.exports` is present, it equals `exports` with exactly the
 *     source-targeting `react-native` conditions removed — same subpaths, same order,
 *     every other condition byte-equal — so the two maps never drift apart.
 *
 * It reads the committed manifests and needs no build: `pnpm test:scripts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages");

function manifests() {
  return readdirSync(PACKAGES_DIR)
    .map((dir) => join(PACKAGES_DIR, dir, "package.json"))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, manifest: JSON.parse(readFileSync(file, "utf8")) }))
    .filter(({ manifest }) => manifest.private !== true);
}

/** Every [subpath, condition, target] string leaf of an export map. */
function leaves(exportsMap) {
  if (exportsMap === undefined) return [];
  if (typeof exportsMap === "string") return [[".", "default", exportsMap]];
  const out = [];
  for (const [subpath, entry] of Object.entries(exportsMap)) {
    if (typeof entry === "string") {
      out.push([subpath, "default", entry]);
      continue;
    }
    for (const [condition, target] of Object.entries(entry)) {
      assert.equal(typeof target, "string", `${subpath} → ${condition}: nested conditions are not read here`);
      out.push([subpath, condition, target]);
    }
  }
  return out;
}

const isSourceTarget = (target) => target.startsWith("./src/") || (/\.tsx?$/.test(target) && !/\.d\.tsx?$/.test(target));

/** `exports` minus each `react-native` condition that targets source. */
function withoutSourceConditions(exportsMap) {
  const out = {};
  for (const [subpath, entry] of Object.entries(exportsMap)) {
    if (typeof entry === "string") {
      out[subpath] = entry;
      continue;
    }
    out[subpath] = Object.fromEntries(
      Object.entries(entry).filter(([condition, target]) => !(condition === "react-native" && isSourceTarget(target))),
    );
  }
  return out;
}

test("every published export target is compiled output, never TypeScript source", () => {
  const found = [];
  for (const { manifest } of manifests()) {
    const published = manifest.publishConfig?.exports ?? manifest.exports;
    for (const [subpath, condition, target] of leaves(published)) {
      if (isSourceTarget(target)) found.push(`${manifest.name} ${subpath} → ${condition}: ${target}`);
    }
  }
  assert.deepEqual(found, []);
});

test("publishConfig.exports equals exports minus the source-targeting react-native conditions", () => {
  const checked = [];
  for (const { manifest } of manifests()) {
    if (manifest.publishConfig?.exports === undefined) continue;
    assert.deepEqual(
      JSON.stringify(manifest.publishConfig.exports),
      JSON.stringify(withoutSourceConditions(manifest.exports)),
      `${manifest.name}: publishConfig.exports drifted from exports`,
    );
    checked.push(manifest.name);
  }
  // The three packages that carry a workspace source condition today.
  assert.deepEqual(checked.sort(), ["@guuey/agent-client", "@guuey/chat", "@guuey/mcp-apps-host"]);
});

test("controls: a source target is caught, a drifted publish map is caught", () => {
  const exportsMap = {
    ".": { "react-native": "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./styles.css": "./styles.css",
  };
  assert.ok(leaves(exportsMap).some(([, , target]) => isSourceTarget(target)));
  assert.deepEqual(withoutSourceConditions(exportsMap), {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./styles.css": "./styles.css",
  });
  const drifted = { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" }, "./styles.css": "./styles.css" };
  assert.notEqual(JSON.stringify(drifted), JSON.stringify(withoutSourceConditions(exportsMap)));
  assert.ok(!isSourceTarget("./dist/index.d.ts"), "a declaration file is compiled output");
});
