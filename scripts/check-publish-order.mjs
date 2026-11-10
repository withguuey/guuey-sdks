#!/usr/bin/env node
/**
 * The publish ORDER is written once, covers every publishable package, and is
 * leaf-first by the manifests' own dependencies.
 *
 * The ORDER lives in ONE file, `publish-order.txt` (one package directory per
 * line, leaf-first), which every release.yml step reads with
 * `mapfile -t ORDER < publish-order.txt`. Three hand-kept copies of it had to
 * move together by hand (guuey#2877); a copy is the next miss waiting, so
 * this check refuses any `ORDER=( … )` array written into the workflow.
 *
 * Coverage (guuey#1383). A package added under packages/ is installed, built,
 * typechecked and tested by CI, and then simply never published — the cohort
 * verify step checks the versions of the packages it was told about, so it
 * stays green while the new package is absent from npm. So, read off the
 * manifests:
 *
 *   - a package with `"guueyLockstep": false` versions independently and
 *     publishes from its own step (today: `packages/guuey`, the bare-name
 *     forwarder, guuey#449). It must NOT be in ORDER — and this check still
 *     insists the workflow names it somewhere, so "not in ORDER" can never
 *     quietly become "not published at all".
 *   - every other non-private package MUST be in ORDER, exactly once.
 *
 * Dependency order (guuey#2877). Coverage alone let `threads` publish before
 * `worker` once threads depended on worker: for a window, npm would have
 * served threads@X whose @guuey/worker@X did not exist yet, and a failed
 * worker publish would have left it that way. The constraint is derived from
 * the manifests, never from a second list: every cohort package named in a
 * package's `dependencies`, `peerDependencies` or `optionalDependencies` must
 * sit EARLIER in ORDER. `devDependencies` do not gate an install and are out.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The one line every release.yml step uses to read the ORDER file. */
export const ORDER_READ = "mapfile -t ORDER < publish-order.txt";

const INSTALL_DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/**
 * @param {object} input
 * @param {string | null} input.orderText  publish-order.txt's contents, or null when the file is absent
 * @param {string} input.workflow          release.yml's contents
 * @param {Array<{ dir: string, manifest: object | null }>} input.packages  every directory under packages/; manifest null = unreadable
 * @returns {{ order: string[], expected: string[], problems: string[] }}
 */
export function publishOrderProblems({ orderText, workflow, packages }) {
  const problems = [];

  if (orderText === null) {
    problems.push(
      "publish-order.txt is missing — the one publish list every release.yml step reads is gone."
    );
  }
  const lines = (orderText ?? "").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const order = [];
  lines.forEach((line, i) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(line)) {
      problems.push(
        `publish-order.txt line ${i + 1} is ${JSON.stringify(line)}; every line is one package directory name ` +
          "(a blank or padded line becomes an empty or wrong ORDER entry under mapfile)."
      );
      return;
    }
    order.push(line);
  });
  if (orderText !== null && order.length === 0) {
    problems.push("publish-order.txt lists no package.");
  }

  const inline = [...workflow.matchAll(/^\s*ORDER=\(/gm)].length;
  if (inline > 0) {
    problems.push(
      `release.yml writes ${inline} ORDER=( … ) array(s) of its own; the ORDER lives only in publish-order.txt, ` +
        `read with \`${ORDER_READ}\`. A copy is a second list that one edit will leave behind.`
    );
  }
  if (!workflow.includes(ORDER_READ)) {
    problems.push(
      `no release.yml step reads the ORDER with \`${ORDER_READ}\` — nothing publishes the list.`
    );
  }

  const seen = new Map();
  for (const entry of order) seen.set(entry, (seen.get(entry) ?? 0) + 1);
  for (const [entry, count] of seen) {
    if (count > 1) problems.push(`ORDER lists \`${entry}\` ${count} times.`);
  }

  const dirs = packages.map((p) => p.dir);
  const expected = [];
  /** npm name -> package dir, for every package in the cohort ORDER publishes. */
  const dirByName = new Map();
  for (const { dir, manifest } of packages) {
    if (manifest === null) {
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
    dirByName.set(manifest.name, dir);
    if (!order.includes(dir)) {
      problems.push(
        `packages/${dir} (${manifest.name}) is publishable and missing from the publish ORDER — CI would build ` +
          "and test it on every run and npm would never receive it."
      );
    }
  }
  for (const entry of new Set(order)) {
    if (!dirs.includes(entry))
      problems.push(`ORDER names \`${entry}\`, which is not a directory under packages/.`);
  }

  const position = new Map(order.map((dir, i) => [dir, i]));
  for (const { dir, manifest } of packages) {
    if (manifest === null || !position.has(dir)) continue;
    for (const field of INSTALL_DEP_FIELDS) {
      for (const depName of Object.keys(manifest[field] ?? {})) {
        const depDir = dirByName.get(depName);
        if (depDir === undefined || !position.has(depDir)) continue;
        if (position.get(depDir) > position.get(dir)) {
          problems.push(
            `\`${dir}\` publishes before \`${depDir}\`, but ${manifest.name} has ${depName} in ${field} — ` +
              `npm would serve ${manifest.name} while the ${depName} it needs is not there yet. Move \`${depDir}\` ` +
              `above \`${dir}\` in publish-order.txt.`
          );
        }
      }
    }
  }

  return { order, expected, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = new URL("../", import.meta.url).pathname;
  const packagesDir = join(root, "packages");
  const read = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const packages = readdirSync(packagesDir)
    .filter((d) => statSync(join(packagesDir, d)).isDirectory())
    .map((dir) => {
      const text = read(join(packagesDir, dir, "package.json"));
      return { dir, manifest: text === null ? null : JSON.parse(text) };
    });
  const { expected, problems } = publishOrderProblems({
    orderText: read(join(root, "publish-order.txt")),
    workflow,
    packages,
  });

  if (problems.length > 0) {
    console.error("Publish ORDER check failed:\n");
    for (const p of problems) console.error(`  • ${p}`);
    console.error(
      "\nThe ORDER lives in oss/publish-order.txt. Leaf-first: a package publishes after every cohort package it depends on."
    );
    process.exit(1);
  }
  console.log(
    `Publish ORDER covers packages/: ${expected.length} lockstep packages, all in publish-order.txt, ` +
      "each after every cohort package it depends on."
  );
}
