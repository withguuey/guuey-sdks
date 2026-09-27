/**
 * The engines-floor guard, red-first: the range forms npm publishes, the walk
 * over a pnpm-list-shaped tree (links, deduped occurrences, absent optionals),
 * and the rule, including the shape that shipped: a package stating no floor
 * under a dependency that declares one.
 *
 * Run: node --test 'scripts/*.test.mjs' (pnpm test:scripts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lowerBound, compareVersions, closureManifests, judgeEnginesFloor } from "./check-engines-floor.mjs";

const lb = (r) => {
  const x = lowerBound(r);
  return x.kind === "floor" ? x.floor.join(".") : x.kind;
};

test("range forms: comparators, spaced operators, x-ranges, bare majors", () => {
  assert.equal(lb(">=22.12.0"), "22.12.0");
  assert.equal(lb(">= 22.12.0"), "22.12.0");
  assert.equal(lb(">=18"), "18.0.0");
  assert.equal(lb("22.x"), "22.0.0");
  assert.equal(lb("22"), "22.0.0");
  assert.equal(lb("^20.19.0"), "20.19.0");
  assert.equal(lb("~18.17"), "18.17.0");
  assert.equal(lb("v20.3.1"), "20.3.1");
});

test("range forms: a set with an upper bound, a hyphen range, alternatives", () => {
  assert.equal(lb(">=18 <21"), "18.0.0");
  assert.equal(lb("18 - 22"), "18.0.0");
  assert.equal(lb("^18.19.0 || >=20.6.0"), "18.19.0");
  assert.equal(lb(">=20 || ^18.17"), "18.17.0");
  assert.equal(lb("<22"), "none");
});

test("range forms: missing, empty and * are no floor", () => {
  assert.equal(lb(undefined), "none");
  assert.equal(lb(""), "none");
  assert.equal(lb("*"), "none");
  assert.equal(lb("x"), "none");
});

test("range forms: an unreadable range is unparsed, never a floor or none", () => {
  assert.equal(lb("latest"), "unparsed");
  assert.equal(lb(">=node22"), "unparsed");
});

test("compareVersions orders by major, minor, patch", () => {
  assert.ok(compareVersions([22, 12, 0], [22, 0, 0]) > 0);
  assert.ok(compareVersions([20, 19, 0], [22, 0, 0]) < 0);
  assert.equal(compareVersions([18, 0, 0], [18, 0, 0]), 0);
});

// a pnpm-list-shaped tree; manifests are looked up by path (null = not installed here)
const MANIFESTS = {
  "/p/core": { name: "@x/core", version: "0.12.0", engines: { node: ">=22.12.0" } },
  "/p/proto": { name: "@x/proto", version: "0.24.0", engines: { node: ">=22.0.0" } },
  "/p/zod": { name: "zod", version: "3.25.0" },
  "/p/tar": { name: "tar", version: "7.4.3", engines: { node: ">=18" } },
  "/p/weird": { name: "weird", version: "1.0.0", engines: { node: "latest" } },
  "/p/esbuild": { name: "esbuild", version: "0.25.12", engines: { node: ">=18" }, optionalDependencies: { "@esbuild/aix-ppc64": "0.25.12" } },
};
const read = (p) => MANIFESTS[p] ?? null;
const tree = (paths) => ({
  dependencies: Object.fromEntries(paths.map((p) => [MANIFESTS[p].name, { path: p, dependencies: p === "/p/proto" ? { zod: { path: "/p/zod" } } : {} }])),
});
const cm = (...args) => closureManifests(...args).manifests;

test("closure: every dependency is read once, nested ones included", () => {
  const c = cm({ dependencies: { a: { path: "/p/proto", dependencies: { z: { path: "/p/zod" } } }, b: { path: "/p/zod" } } }, read);
  assert.deepEqual(c.map((m) => m.name).sort(), ["@x/proto", "zod"]);
});

test("a workspace dependency listed as a bare link is walked through its own listed node", () => {
  // `pnpm -r list` shows @guuey/mcp-apps-host inside @guuey/threads as a link with no subtree
  const threadsNode = { dependencies: { "@guuey/mcp-apps-host": { path: "/ws/mcp-apps-host" } } };
  const workspace = { "/ws/mcp-apps-host": { dependencies: { "@x/proto": { path: "/p/proto" } } } };
  const readWs = (p) => (p === "/ws/mcp-apps-host" ? { name: "@guuey/mcp-apps-host", version: "0.30.0" } : read(p));
  const without = judgeEnginesFloor({ name: "@guuey/threads" }, cm(threadsNode, readWs));
  assert.deepEqual(without.problems, [], "without the lookup the link hides the floor (the false negative this guards)");
  const withLookup = judgeEnginesFloor({ name: "@guuey/threads" }, cm(threadsNode, readWs, (p) => workspace[p]));
  assert.equal(withLookup.problems.length, 1);
  assert.match(withLookup.problems[0], /imposes 22\.0\.0, set by @x\/proto@0\.24\.0/);
});

test("a deduped first occurrence does not hide the subtree printed later", () => {
  // pnpm prints a repeated subtree once; the stub (no dependencies) can come first in the walk
  const node = {
    dependencies: {
      a: { path: "/p/zod", deduped: true },
      b: { path: "/p/zod", dependencies: { core: { path: "/p/core" } } },
    },
  };
  const r = judgeEnginesFloor({ name: "p" }, cm(node, read));
  assert.match(r.problems.join("\n"), /imposes 22\.12\.0, set by @x\/core@0\.12\.0/);
});

test("an optional dependency absent on this platform is skipped; an absent required one is missing", () => {
  const optionalAbsent = { dependencies: { esbuild: { path: "/p/esbuild", dependencies: { "@esbuild/aix-ppc64": { path: "/p/absent-platform" } } } } };
  const r1 = closureManifests(optionalAbsent, read);
  assert.deepEqual(r1.missing, []);
  assert.deepEqual(r1.manifests.map((m) => m.name), ["esbuild"], "the installed parent (an optional-bearing dep) still counts");
  const requiredAbsent = { dependencies: { gone: { path: "/p/not-installed" } } };
  const r2 = closureManifests(requiredAbsent, read);
  assert.deepEqual(r2.missing, ["gone (/p/not-installed)"]);
  const rootOptional = closureManifests(requiredAbsent, read, undefined, { optionalDependencies: { gone: "1.0.0" } });
  assert.deepEqual(rootOptional.missing, [], "the listed package's own optionalDependencies count too");
});

test("only required edges bind: an installed optional or an optional peer chain sets no floor; a required peer does", () => {
  // the real shape: @silverprotocol/google-adk → @google/adk (an OPTIONAL peer) → @mikro-orm/core (>= 22.17.0)
  const M = {
    "/f/opt": { name: "facet", version: "1.0.0", optionalDependencies: { "opt-high": "1.0.0" }, peerDependencies: { "@x/adk": ">=1 <3" }, peerDependenciesMeta: { "@x/adk": { optional: true } } },
    "/f/req": { name: "facet-req", version: "1.0.0", peerDependencies: { "@x/adk": ">=1 <3" } },
    "/p/opt-high": { name: "opt-high", version: "1.0.0", engines: { node: ">=24" } },
    "/p/adk": { name: "@x/adk", version: "2.1.0", dependencies: { "@x/orm": "^7.2.0" } },
    "/p/orm": { name: "@x/orm", version: "7.2.1", engines: { node: ">= 22.17.0" } },
  };
  const readM = (p) => M[p] ?? null;
  const adk = { path: "/p/adk", dependencies: { "@x/orm": { path: "/p/orm" } } };
  const viaOptional = { dependencies: { facet: { path: "/f/opt", dependencies: { "opt-high": { path: "/p/opt-high" }, "@x/adk": adk } } } };
  const r1 = judgeEnginesFloor({ name: "@guuey/cli" }, cm(viaOptional, readM));
  assert.deepEqual(r1.problems, [], "an installed optional (>=24) and an optional peer chain (>= 22.17.0) bind nothing");
  const viaRequired = { dependencies: { "facet-req": { path: "/f/req", dependencies: { "@x/adk": adk } } } };
  const r2 = judgeEnginesFloor({ name: "@guuey/cli" }, cm(viaRequired, readM));
  assert.match(r2.problems.join("\n"), /imposes 22\.17\.0, set by @x\/orm@7\.2\.1/, "a required peer is installed by npm, so its closure binds");
});

test("the shipped shape refuses: no floor stated under a dependency that declares one, naming it", () => {
  const r = judgeEnginesFloor({ name: "@guuey/cli" }, cm(tree(["/p/core", "/p/proto"]), read));
  assert.equal(r.floor.join("."), "22.12.0");
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /states no Node floor, but its production closure imposes 22\.12\.0, set by @x\/core@0\.12\.0/);
});

test("a stated floor below the closure's refuses; at or above it passes", () => {
  const closure = cm(tree(["/p/core"]), read);
  assert.match(judgeEnginesFloor({ name: "p", engines: { node: ">=22.0.0" } }, closure).problems[0], /a Node floor of 22\.0\.0/);
  assert.deepEqual(judgeEnginesFloor({ name: "p", engines: { node: ">=22.12.0" } }, closure).problems, []);
  assert.deepEqual(judgeEnginesFloor({ name: "p", engines: { node: ">=24" } }, closure).problems, []);
});

test("a closure with no floor asks nothing of the package", () => {
  assert.deepEqual(judgeEnginesFloor({ name: "p" }, cm(tree(["/p/zod"]), read)).problems, []);
});

test("an unreadable dependency range fails closed, naming the dependency", () => {
  const r = judgeEnginesFloor({ name: "p", engines: { node: ">=24" } }, cm(tree(["/p/weird"]), read));
  assert.match(r.problems.join("\n"), /weird@1\.0\.0 declares engines\.node 'latest', which this check cannot read/);
});

test("a package's own range with an upper bound is judged by its lower bound", () => {
  const closure = cm(tree(["/p/tar"]), read);
  assert.deepEqual(judgeEnginesFloor({ name: "create", engines: { node: ">=20 <30" } }, closure).problems, []);
});
