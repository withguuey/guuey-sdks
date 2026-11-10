/**
 * guuey#2877 — the publish ORDER guard, red-first. The planted positive
 * control is the exact pre-7e6eefc915db order with the #2877 dependency
 * present (threads before worker, threads depending on @guuey/worker): the
 * check must refuse it and name the pair. The last case reads this tree's own
 * publish-order.txt, release.yml and manifests.
 *
 * Run: node --test 'scripts/*.test.mjs' (pnpm test:scripts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ORDER_READ, publishOrderProblems } from "./check-publish-order.mjs";

const WORKFLOW = `jobs:\n  publish:\n    steps:\n      - run: |\n          ${ORDER_READ}\n`;
const pkg = (dir, extra = {}) => ({
  dir,
  manifest: { name: `@guuey/${dir}`, version: "0.35.0", ...extra },
});

/** The cohort shape #2877 creates: threads and agent-client depend on worker. */
const cohort = () => [
  pkg("mcp-apps-host"),
  pkg("worker"),
  pkg("threads", {
    dependencies: { "@guuey/mcp-apps-host": "workspace:*", "@guuey/worker": "workspace:*" },
  }),
  pkg("agent-client", {
    dependencies: { "@guuey/mcp-apps-host": "workspace:*", "@guuey/worker": "workspace:*" },
  }),
];
const lines = (...dirs) => `${dirs.join("\n")}\n`;

test("leaf-first order with every dependency earlier passes", () => {
  const r = publishOrderProblems({
    orderText: lines("mcp-apps-host", "worker", "threads", "agent-client"),
    workflow: WORKFLOW,
    packages: cohort(),
  });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.order, ["mcp-apps-host", "worker", "threads", "agent-client"]);
});

test("POSITIVE CONTROL: the pre-7e6e order (threads before worker) with the #2877 dependency refuses, naming the pair", () => {
  const r = publishOrderProblems({
    orderText: lines("mcp-apps-host", "threads", "worker", "agent-client"),
    workflow: WORKFLOW,
    packages: cohort(),
  });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /`threads` publishes before `worker`/);
  assert.match(r.problems[0], /@guuey\/threads has @guuey\/worker in dependencies/);
});

test("peerDependencies and optionalDependencies gate the order; devDependencies do not", () => {
  const packages = [
    // agent-client publishes before worker, which it names only in devDependencies: no constraint.
    pkg("agent-client", { devDependencies: { "@guuey/worker": "workspace:*" } }),
    pkg("chat", { peerDependencies: { "@guuey/agent-client": ">=0.35.0" } }),
    pkg("host", { optionalDependencies: { "@guuey/worker": "workspace:*" } }),
    pkg("worker"),
  ];
  const r = publishOrderProblems({
    orderText: lines("chat", "agent-client", "host", "worker"),
    workflow: WORKFLOW,
    packages,
  });
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /`chat` publishes before `agent-client`.*in peerDependencies/);
  assert.match(r.problems[1], /`host` publishes before `worker`.*in optionalDependencies/);
});

test("a dependency outside the cohort (npm, or a private package) is not an ordering constraint", () => {
  const packages = [
    pkg("threads", {
      dependencies: { "@silverprotocol/core": "0.12.11", "@guuey/secret": "workspace:*" },
    }),
    { dir: "secret", manifest: { name: "@guuey/secret", private: true } },
  ];
  assert.deepEqual(
    publishOrderProblems({ orderText: lines("threads"), workflow: WORKFLOW, packages }).problems,
    []
  );
});

test("an ORDER=( … ) copy written back into release.yml refuses, even when it agrees with the file", () => {
  const workflow = `${WORKFLOW}          ORDER=(mcp-apps-host worker threads agent-client)\n`;
  const r = publishOrderProblems({
    orderText: lines("mcp-apps-host", "worker", "threads", "agent-client"),
    workflow,
    packages: cohort(),
  });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /writes 1 ORDER=\( … \) array/);
});

test("a workflow that never reads publish-order.txt refuses", () => {
  const r = publishOrderProblems({
    orderText: lines("worker"),
    workflow: "jobs: {}\n",
    packages: [pkg("worker")],
  });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /no release\.yml step reads the ORDER/);
});

test("a missing file, a blank line, a padded line and a duplicate each refuse", () => {
  assert.match(
    publishOrderProblems({ orderText: null, workflow: WORKFLOW, packages: [] }).problems[0],
    /publish-order\.txt is missing/
  );
  const r = publishOrderProblems({
    orderText: "worker\n\n worker\nworker\n",
    workflow: WORKFLOW,
    packages: [pkg("worker")],
  });
  assert.equal(r.problems.length, 3);
  assert.match(r.problems[0], /line 2 is ""/);
  assert.match(r.problems[1], /line 3 is " worker"/);
  assert.match(r.problems[2], /ORDER lists `worker` 2 times/);
});

test("coverage (guuey#1383) still holds: a publishable package left out, and a name that is not a package, refuse", () => {
  const r = publishOrderProblems({
    orderText: lines("worker", "ghost"),
    workflow: WORKFLOW,
    packages: [pkg("worker"), pkg("fs")],
  });
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /packages\/fs \(@guuey\/fs\) is publishable and missing/);
  assert.match(r.problems[1], /ORDER names `ghost`/);
});

test("a guueyLockstep:false package must stay out of ORDER and still be published by name", () => {
  const fwd = {
    dir: "guuey",
    manifest: {
      name: "guuey",
      guueyLockstep: false,
      dependencies: { "@guuey/cli": "workspace:*" },
    },
  };
  const inOrder = publishOrderProblems({
    orderText: lines("guuey"),
    workflow: WORKFLOW,
    packages: [fwd],
  });
  assert.equal(inOrder.problems.length, 2);
  assert.match(inOrder.problems[0], /declares "guueyLockstep": false but appears in ORDER/);
  assert.match(inOrder.problems[1], /no step in release\.yml reads packages\/guuey\/package\.json/);
});

test("this tree: publish-order.txt, release.yml and the manifests agree", () => {
  const root = new URL("../", import.meta.url).pathname;
  const packagesDir = join(root, "packages");
  const packages = readdirSync(packagesDir)
    .filter((d) => statSync(join(packagesDir, d)).isDirectory())
    .map((dir) => ({
      dir,
      manifest: JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8")),
    }));
  const r = publishOrderProblems({
    orderText: readFileSync(join(root, "publish-order.txt"), "utf8"),
    workflow: readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8"),
    packages,
  });
  assert.deepEqual(r.problems, []);
  assert.ok(
    r.order.indexOf("worker") < r.order.indexOf("threads"),
    "worker publishes before threads (guuey#2877)"
  );
});
