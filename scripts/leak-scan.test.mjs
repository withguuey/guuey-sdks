/**
 * leak-scan.sh holds its rules and its own failure faces.
 *
 * Each case builds a throwaway git index with the real script at
 * scripts/leak-scan.sh (the path it skips) and the files under test, then runs
 * the script there. A planted value is assembled at run time, so this file
 * never carries a literal the scan itself would flag.
 *
 * Pinned:
 *   - a realistic body after any guuey_<family>_ prefix fails, for every family
 *     the platform issues and for one not invented yet (a digit in the name);
 *   - documentation placeholders, a short fake and an upper-case env name pass;
 *   - a file name with a space is read whole;
 *   - a rule whose pattern grep cannot compile fails the scan, and so does a
 *     tracked file it cannot read (grep's exit 2 is never "no hits");
 *   - a tree with nothing to read fails as NOTHING SCANNED, never as clean.
 *
 * Needs bash and git: `pnpm test:scripts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "leak-scan.sh"), "utf8");

/** A realistic-looking credential body, built here so no literal sits in this file. */
const body = () => "Ab3dE".repeat(5);
const token = (family) => ["guuey", family, body()].join("_");

/**
 * Run the scan in a fresh index holding `files` (path -> content).
 * `script` replaces the real script text; `missing` lists tracked paths removed
 * from disk after they are indexed.
 */
function scan(files, { script = SCRIPT, missing = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "leak-scan-"));
  try {
    const git = (...args) => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    };
    git("init", "-q", ".");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "leak-scan.sh"), script);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git("add", "-A");
    for (const path of missing) rmSync(join(dir, path));
    const r = spawnSync("bash", ["scripts/leak-scan.sh"], { cwd: dir, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FAMILIES = ["user", "wkz", "svc", "agt", "widget", "rt", "rat", "client", "deploy", "thr", "v2"];

for (const family of FAMILIES) {
  test(`a credential body after guuey_${family}_ fails the scan`, () => {
    const r = scan({ "src/config.ts": `export const KEY = "${token(family)}";\n` });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /LEAK \[guuey credential body/);
    assert.match(r.stderr, /src\/config\.ts:1:/);
  });
}

test("placeholders, a short fake and an upper-case env name pass", () => {
  const r = scan({
    "README.md": [
      "Set guuey_user_<key> in your shell.",
      "A key looks like guuey_user_...",
      'const fake = "guuey_thr_test";',
      ["GUUEY", "CLAUDE", "SPARE", "A".repeat(24)].join("_"),
      "",
    ].join("\n"),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^leak-scan: clean \(1 tracked files scanned\)/);
});

test("a file name with a space is read whole", () => {
  const r = scan({ "docs/my notes.md": `${token("thr")}\n` });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /docs\/my notes\.md:1:/);
});

test("a rule grep cannot compile fails the scan, it is not read as no hits", () => {
  const broken = SCRIPT.replace("RULES=(\n", "RULES=(\n  'planted broken rule|(unclosed'\n");
  assert.notEqual(broken, SCRIPT, "the planted rule must land in RULES");
  const r = scan({ "src/ok.ts": "export const ok = 1;\n" }, { script: broken });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /leak-scan ERROR \[planted broken rule\]/);
});

test("a tracked file that cannot be read fails the scan", () => {
  const r = scan({ "src/ok.ts": "export const ok = 1;\n", "src/gone.ts": "x\n" }, { missing: ["src/gone.ts"] });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /leak-scan ERROR/);
});

test("a tree with nothing to read fails as NOTHING SCANNED, never as clean", () => {
  const r = scan({});
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /NOTHING SCANNED/);
  assert.doesNotMatch(r.stdout, /clean/);
});
