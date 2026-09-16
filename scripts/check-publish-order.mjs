#!/usr/bin/env node
/**
 * Every publishable package is in the release workflow's publish ORDER.
 *
 * guuey#1383. `packages/` and the ORDER arrays in `.github/workflows/release.yml`
 * were two hand-kept lists with nothing between them. A package added here is
 * installed, built, typechecked and tested by CI, and then simply never
 * published — the cohort verify step checks the versions of the packages it
 * was told about, so it stays green while the new package is absent from npm.
 * The failure is silence, and the only symptom is a consumer's 404 days later.
 *
 * The rule is read off the manifests, not repeated here:
 *
 *   - a package with `"guueyLockstep": false` versions independently and
 *     publishes from its own step (today: `packages/guuey`, the bare-name
 *     forwarder, guuey#449). It must NOT be in ORDER — and this check still
 *     insists the workflow names it somewhere, so "not in ORDER" can never
 *     quietly become "not published at all".
 *   - every other non-private package MUST be in ORDER, exactly once.
 *
 * Both ORDER arrays (publish, then verify) must be identical: a package
 * published but not verified is the guuey#439 partial-cohort failure with the
 * alarm removed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const packagesDir = join(root, "packages");
const workflowPath = join(root, ".github", "workflows", "release.yml");

const workflow = readFileSync(workflowPath, "utf8");

/** Every `ORDER=(a b c)` array in the workflow, in file order. */
const orders = [...workflow.matchAll(/^\s*ORDER=\(([^)]*)\)\s*$/gm)].map((m) =>
  m[1].trim().split(/\s+/)
);
const problems = [];

if (orders.length === 0) {
  problems.push(
    "release.yml declares no ORDER=( … ) array — the publish list this check exists to bind to is gone."
  );
} else {
  for (let i = 1; i < orders.length; i += 1) {
    if (orders[i].join(" ") !== orders[0].join(" ")) {
      problems.push(
        `the ORDER arrays in release.yml disagree: #1 is [${orders[0].join(" ")}], #${i + 1} is [${orders[i].join(" ")}]. ` +
          "A package in one and not the other publishes without being verified, or is verified without being published."
      );
    }
  }
}

const order = orders[0] ?? [];
const seen = new Map();
for (const entry of order) seen.set(entry, (seen.get(entry) ?? 0) + 1);
for (const [entry, count] of seen) {
  if (count > 1) problems.push(`ORDER lists \`${entry}\` ${count} times.`);
}

const dirs = readdirSync(packagesDir).filter((d) => statSync(join(packagesDir, d)).isDirectory());
const expected = [];
for (const dir of dirs) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
  } catch {
    problems.push(
      `packages/${dir} has no readable package.json — it is neither publishable nor a package.`
    );
    continue;
  }
  if (manifest.private === true) continue;
  if (manifest.guueyLockstep === false) {
    if (order.includes(dir)) {
      problems.push(
        `packages/${dir} declares "guueyLockstep": false but appears in ORDER — an independently versioned package ` +
          "published leaf-first with the cohort would be cut to the cohort's version."
      );
    }
    if (!workflow.includes(`packages/${dir}/package.json`)) {
      problems.push(
        `packages/${dir} declares "guueyLockstep": false and is not in ORDER, and no step in release.yml reads ` +
          `packages/${dir}/package.json — so nothing publishes it at all.`
      );
    }
    continue;
  }
  expected.push(dir);
}

for (const dir of expected) {
  if (!order.includes(dir)) {
    problems.push(
      `packages/${dir} (${JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8")).name}) is publishable ` +
        "and missing from the publish ORDER — CI would build and test it on every run and npm would never receive it."
    );
  }
}
for (const entry of order) {
  if (!dirs.includes(entry))
    problems.push(`ORDER names \`${entry}\`, which is not a directory under packages/.`);
}

if (problems.length > 0) {
  console.error("Publish ORDER does not cover packages/:\n");
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    `\nThe ORDER arrays live in oss/.github/workflows/release.yml. Leaf-first: a package publishes after everything it depends on.`
  );
  process.exit(1);
}

console.log(
  `Publish ORDER covers packages/: ${expected.length} lockstep packages, all in ORDER (${orders.length} arrays, identical).`
);
