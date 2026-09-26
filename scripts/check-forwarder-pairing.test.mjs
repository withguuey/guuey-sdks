/**
 * guuey#1864 — the forwarder pairing guard, red-first against an unmoved
 * forwarder version and a caret dependency, with the controls that prove it
 * derives the version rather than matching one string. The last case reads
 * this tree's own manifests, so a cut that moves the cohort and not the
 * forwarder fails here before it lands.
 *
 * Run: node --test 'scripts/*.test.mjs' (pnpm test:scripts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forwarderPairing } from "./check-forwarder-pairing.mjs";

const cli = (version) => ({ name: "@guuey/cli", version });
const fwd = (version, dep = "workspace:*", extra = {}) => ({
  name: "guuey",
  version,
  guueyLockstep: false,
  dependencies: { "@guuey/cli": dep },
  ...extra,
});

test("paired: cli 0.29.0 with guuey 1.29.0 on workspace:* passes", () => {
  const r = forwarderPairing(cli("0.29.0"), fwd("1.29.0"));
  assert.deepEqual(r.problems, []);
  assert.equal(r.expected, "1.29.0");
});

test("the patch carries: cli 0.29.3 needs guuey 1.29.3", () => {
  assert.deepEqual(forwarderPairing(cli("0.29.3"), fwd("1.29.3")).problems, []);
  const r = forwarderPairing(cli("0.29.3"), fwd("1.29.0"));
  assert.equal(r.expected, "1.29.3");
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /must be 1\.29\.3/);
});

test("an unmoved version and a workspace:^ dependency refuse on both counts", () => {
  const r = forwarderPairing(cli("0.29.0"), fwd("1.28.0", "workspace:^"));
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /is at 1\.28\.0; with @guuey\/cli at 0\.29\.0 it must be 1\.29\.0/);
  assert.match(r.problems[1], /as 'workspace:\^'; it must be 'workspace:\*'/);
});

test("a cut that moved the cohort and not the forwarder refuses", () => {
  const r = forwarderPairing(cli("0.30.0"), fwd("1.29.0"));
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /must be 1\.30\.0/);
});

test("a plain range instead of the workspace protocol refuses (it would not publish as the exact version)", () => {
  assert.match(forwarderPairing(cli("0.29.0"), fwd("1.29.0", "^0.29.0")).problems[0], /as '\^0\.29\.0'/);
  // a missing dependency is built explicitly: passing `undefined` to fwd() would take its default
  assert.match(forwarderPairing(cli("0.29.0"), { ...fwd("1.29.0"), dependencies: {} }).problems[0], /as 'undefined'/);
});

test("cli 1.0.0 refuses until the pairing is re-ruled — the mapping is for a 0.x cli", () => {
  const r = forwarderPairing(cli("1.0.0"), fwd("1.0.0"));
  assert.equal(r.expected, null);
  assert.match(r.problems.join("\n"), /re-rule the pairing/);
});

test("a prerelease cli version derives nothing and refuses", () => {
  const r = forwarderPairing(cli("0.30.0-rc.1"), fwd("1.30.0"));
  assert.equal(r.expected, null);
  assert.match(r.problems.join("\n"), /not a plain x\.y\.z release/);
});

test("the forwarder must stay outside the lockstep ORDER", () => {
  const r = forwarderPairing(cli("0.29.0"), fwd("1.29.0", "workspace:*", { guueyLockstep: undefined }));
  assert.match(r.problems.join("\n"), /"guueyLockstep": false/);
});

test("this tree: packages/guuey is paired with packages/cli", () => {
  const root = new URL("../", import.meta.url).pathname;
  const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
  const r = forwarderPairing(read("packages/cli/package.json"), read("packages/guuey/package.json"));
  assert.deepEqual(r.problems, []);
});
