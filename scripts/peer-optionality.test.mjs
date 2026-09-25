/**
 * guuey#1685 — a published package's peer is REQUIRED exactly when its root entry needs it.
 *
 * npm installs a required peer for every consumer. `@guuey/agent-client` declared `react`
 * required while only its `./react` subpath imports React, so `npm install @guuey/cli`
 * installed React for users who never load it (measured on 0.27.0: react 19.3.0 in the
 * CLI's tree, agent-client its only required declarer). The rule, both ways:
 *
 *   - a REQUIRED peer must be reached STATICALLY by the root entry — else nobody who uses
 *     only the root needs it, and it belongs in peerDependenciesMeta as optional;
 *   - an OPTIONAL peer must NOT be reached statically by the root entry — else a consumer
 *     who does not install it crashes on `import`. A peer reached only through a dynamic
 *     `import()` (host's per-framework runners, loaded when that framework is chosen) is
 *     legitimately optional.
 *
 * It reads what SHIPS: the root entry's compiled `dist/` file (the `.` export), parsed with
 * TypeScript's own parser — never source text. In emitted JS a type-only import is gone
 * and JSX's automatic runtime (`react/jsx-runtime`) is present, so neither can mislead it,
 * and a string or comment that looks like an import is not an import. A text scan of
 * source misjudges all three; the fixture control below pins each.
 *
 * Its reach, stated so the claim stays equal to it:
 *   - STATIC only. A peer the root needs at runtime but loads only through `import()` would
 *     read as unreached and be pushed to optional. No published package has one; if one
 *     appears it needs a named exception here, not a looser walk.
 *   - ESM only. It sees `import`, `export … from` and `import()`, never what `require()`
 *     loads. So it REFUSES what it cannot read instead of passing it: a `require` condition
 *     on the root export (a CJS root it does not walk), and a `require(…)` call or a
 *     `createRequire` import anywhere in the root's static closure. Without that refusal an
 *     optional peer loaded through `require()` would read as unreached — a false pass.
 *     Require-capable code reached only behind `import()` (host's per-framework runners)
 *     is outside the static rule and is not refused.
 *
 * Runs after the build: `pnpm test:scripts`, a publish-gate leg in release.yml (build runs
 * before it), in the mirror's CI, and in the monorepo's extract gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const OSS = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(OSS, "packages");

/** A bare specifier's package name: `react/jsx-runtime` → `react`, `@x/y/z` → `@x/y`. */
const pkgOf = (spec) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

/** The module specifiers one emitted JS file imports, split by kind — from the AST, not text. */
function specifiersOf(file) {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );
  const statics = [];
  const dynamics = [];
  const cjs = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      statics.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = node.arguments[0];
      if (a && ts.isStringLiteralLike(a)) dynamics.push(a.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      cjs.push(
        `require(…) at line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`
      );
    }
    // A `createRequire` binding loads modules the walker cannot see, whatever it is named.
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(node:)?module$/.test(node.moduleSpecifier.text) &&
      /\bcreateRequire\b/.test(node.importClause?.getText(sf) ?? "")
    ) {
      cjs.push(
        `createRequire imported at line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { statics, dynamics, cjs };
}

/**
 * From one emitted entry file: the bare packages its STATIC closure imports (following
 * relative static imports), and those reached only behind a dynamic `import()` boundary.
 */
export function reach(entry) {
  const staticBare = new Set();
  const dynamicBare = new Set();
  const seen = new Set();
  const unresolved = [];
  const cjsHoles = [];
  const walk = (file, dynamic, from) => {
    const key = `${dynamic}:${file}`;
    if (seen.has(key)) return;
    // A relative import the walker cannot open is a hole in the graph, never a skip — an
    // unread file could import anything (fail closed).
    if (!existsSync(file)) return void unresolved.push(`${from} → ${file}`);
    seen.add(key);
    const { statics, dynamics, cjs } = specifiersOf(file);
    if (!dynamic) for (const c of cjs) cjsHoles.push(`${file}: ${c}`);
    for (const s of statics) {
      if (s.startsWith(".")) walk(resolve(dirname(file), s), dynamic, file);
      else (dynamic ? dynamicBare : staticBare).add(pkgOf(s));
    }
    for (const s of dynamics) {
      if (s.startsWith(".")) walk(resolve(dirname(file), s), true, file);
      else dynamicBare.add(pkgOf(s));
    }
  };
  walk(entry, false, "(entry)");
  for (const p of staticBare) dynamicBare.delete(p);
  return {
    files: [...seen].filter((k) => k.startsWith("false:")).length,
    staticBare,
    dynamicBare,
    unresolved,
    cjsHoles,
  };
}

/** The `.` export's emitted file for a manifest (string, or the import/default condition). */
function rootEntry(dir, pkg) {
  const e = pkg.exports?.["."];
  const rel = typeof e === "string" ? e : (e?.import ?? e?.default);
  return rel ? join(dir, rel) : null;
}

const published = readdirSync(PACKAGES)
  .map((d) => join(PACKAGES, d, "package.json"))
  .filter((f) => existsSync(f))
  .map((f) => ({ dir: dirname(f), pkg: JSON.parse(readFileSync(f, "utf8")) }))
  .filter(({ pkg }) => !pkg.private && pkg.peerDependencies);

test("the check has built packages with peers to judge (not measured otherwise)", () => {
  assert.ok(published.length > 0, "found 0 published packages declaring peers");
  const unbuilt = published
    .filter(({ dir, pkg }) => !existsSync(rootEntry(dir, pkg) ?? ""))
    .map(({ pkg }) => pkg.name);
  assert.deepEqual(
    unbuilt,
    [],
    "root entries not built — run `pnpm build` first; this guard reads what ships"
  );
});

for (const { dir, pkg } of published) {
  test(`${pkg.name}: required peers are reached by the root entry; optional ones are not`, () => {
    const entry = rootEntry(dir, pkg);
    assert.ok(entry && existsSync(entry), `${pkg.name}: no built root entry (${entry})`);
    const rootCond = pkg.exports?.["."];
    assert.ok(
      !(rootCond && typeof rootCond === "object" && "require" in rootCond),
      `${pkg.name}: the root export has a \`require\` condition — a CJS entry this guard does not walk; walk it before adding one`
    );
    const { files, staticBare, unresolved, cjsHoles } = reach(entry);
    assert.deepEqual(
      cjsHoles,
      [],
      `${pkg.name}: the root's static closure loads through require — the walker cannot see what that reaches, so an optional peer there would read as unreached`
    );
    assert.deepEqual(
      unresolved,
      [],
      `${pkg.name}: relative imports the walker could not open — the verdict would be partial`
    );
    assert.ok(files > 0, `${pkg.name}: the root entry's static graph read 0 files`);
    const meta = pkg.peerDependenciesMeta ?? {};
    const peers = Object.keys(pkg.peerDependencies);
    const requiredUnreached = peers.filter((p) => !meta[p]?.optional && !staticBare.has(p));
    const optionalReached = peers.filter((p) => meta[p]?.optional && staticBare.has(p));
    assert.deepEqual(
      requiredUnreached,
      [],
      `${pkg.name}: REQUIRED peer(s) the root entry never imports — mark them optional (a subpath's users bring them)`
    );
    assert.deepEqual(
      optionalReached,
      [],
      `${pkg.name}: OPTIONAL peer(s) the root entry imports statically — a consumer without them crashes on import; make them required`
    );
  });
}

// ── the walker's own controls — each misjudgment a text scan makes, and each refusal ──────────
test("walker: reads the AST, not text — comments, strings, dynamic boundaries, the JSX runtime", () => {
  const d = mkdtempSync(join(tmpdir(), "peer-optionality-"));
  try {
    writeFileSync(
      join(d, "index.js"),
      [
        '// import x from "in-a-comment";',
        'const s = "import y from \\"in-a-string\\""; export const t = `import(\'in-a-template\')`;',
        'export * from "./sub.js";',
        'import { jsx as _jsx } from "react/jsx-runtime";',
        'export const lazy = () => import("./runner.js");',
        'export const v = _jsx("div", {});',
        "",
      ].join("\n")
    );
    writeFileSync(join(d, "sub.js"), 'import { z } from "zod";\nexport const Z = z;\n');
    writeFileSync(
      join(d, "runner.js"),
      'import { query } from "@anthropic-ai/claude-agent-sdk";\nexport const q = query;\n'
    );
    const r = reach(join(d, "index.js"));
    assert.deepEqual(
      [...r.staticBare].sort(),
      ["react", "zod"],
      "static reach: the JSX runtime and the re-exported sub-module, nothing from comments or strings"
    );
    assert.deepEqual(
      [...r.dynamicBare],
      ["@anthropic-ai/claude-agent-sdk"],
      "reached only behind a dynamic import()"
    );
    assert.deepEqual(r.unresolved, []);
    writeFileSync(join(d, "holed.js"), 'export * from "./gone.js";\n');
    assert.equal(
      reach(join(d, "holed.js")).unresolved.length,
      1,
      "an unopenable relative import must surface, not be skipped"
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("walker: require() or createRequire in the static closure is refused; behind import() it is not", () => {
  const d = mkdtempSync(join(tmpdir(), "peer-optionality-cjs-"));
  try {
    writeFileSync(
      join(d, "index.js"),
      'export * from "./cjs.js";\nexport const lazy = () => import("./lazy.js");\n'
    );
    writeFileSync(join(d, "cjs.js"), 'const r = require("react");\nexport { r };\n');
    writeFileSync(
      join(d, "lazy.js"),
      'import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nexport const v = req("zod");\n'
    );
    const r = reach(join(d, "index.js"));
    assert.equal(r.cjsHoles.length, 1, `one hole expected, got ${JSON.stringify(r.cjsHoles)}`);
    assert.match(r.cjsHoles[0], /cjs\.js: require\(…\) at line 1$/);
    assert.equal(
      r.staticBare.has("react"),
      false,
      "the walker cannot see what require() loads — which is why it refuses it rather than passing it"
    );
    writeFileSync(
      join(d, "aliased.js"),
      'import { createRequire as cr } from "module";\nexport const x = cr;\n'
    );
    assert.equal(
      reach(join(d, "aliased.js")).cjsHoles.length,
      1,
      'an aliased createRequire from "module" is refused too'
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("walker on the real tree: agent-client root reaches no react, its ./react entry does", () => {
  const ac = join(PACKAGES, "agent-client", "dist");
  assert.equal(
    reach(join(ac, "index.js")).staticBare.has("react"),
    false,
    "agent-client root entry reaches react"
  );
  assert.equal(
    reach(join(ac, "react.js")).staticBare.has("react"),
    true,
    "the walker cannot see react through ./react — it would pass anything"
  );
});
