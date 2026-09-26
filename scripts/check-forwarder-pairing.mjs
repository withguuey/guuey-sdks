#!/usr/bin/env node
/**
 * The bare-name forwarder `guuey` runs the @guuey/cli of the same cut.
 *
 * guuey#1864. `packages/guuey` versions outside the lockstep ORDER, and its
 * release step publishes it only when its committed version is new. So a cut
 * moves it together with the lockstep manifests, and this check holds the
 * two together.
 *
 * The rule, read off the two manifests:
 *
 *   - the forwarder's version is `1.<cli minor>.<cli patch>`, so every cut
 *     moves it and `guuey@1.29.0` runs `@guuey/cli@0.29.0`. A new version per
 *     cut also matters to npx, which reuses a cached install of an unchanged
 *     top-level version with whatever it resolved then.
 *   - its @guuey/cli dependency is `workspace:*`, which `pnpm publish`
 *     rewrites to the exact cli version, so the mapping is true of the
 *     published package, not only of the numbers.
 *   - the mapping is for a 0.x cli. At @guuey/cli 1.0.0 it no longer says
 *     anything, and this check refuses until the pairing is re-ruled.
 *
 * Run: node scripts/check-forwarder-pairing.mjs (pnpm check:forwarder-pairing).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {{ name?: string, version?: string }} cli the packages/cli manifest
 * @param {{ name?: string, version?: string, guueyLockstep?: boolean, dependencies?: Record<string, string> }} forwarder the packages/guuey manifest
 * @returns {{ expected: string | null, problems: string[] }}
 */
export function forwarderPairing(cli, forwarder) {
  const problems = [];
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cli.version ?? "");
  if (cli.name !== "@guuey/cli") problems.push(`packages/cli is named '${cli.name}', not '@guuey/cli'.`);
  if (forwarder.name !== "guuey") problems.push(`packages/guuey is named '${forwarder.name}', not 'guuey'.`);
  if (forwarder.guueyLockstep !== false)
    problems.push(`packages/guuey must declare "guueyLockstep": false — it publishes from its own step, after the cohort.`);
  if (!m) {
    problems.push(`@guuey/cli's version '${cli.version}' is not a plain x.y.z release, so no forwarder version can be derived from it.`);
    return { expected: null, problems };
  }
  const [, major, minor, patch] = m;
  if (major !== "0") {
    problems.push(
      `@guuey/cli is at ${cli.version}. The forwarder's version 1.<cli minor>.<cli patch> was ruled for a 0.x cli ` +
        `(guuey#1864) and says nothing at ${major}.x — re-rule the pairing before this cut.`
    );
    return { expected: null, problems };
  }
  const expected = `1.${minor}.${patch}`;
  if (forwarder.version !== expected)
    problems.push(
      `packages/guuey is at ${forwarder.version}; with @guuey/cli at ${cli.version} it must be ${expected}. ` +
        `A cut moves the forwarder with the cohort, or npx guuey keeps running the previous cli.`
    );
  const dep = forwarder.dependencies?.["@guuey/cli"];
  if (dep !== "workspace:*")
    problems.push(
      `packages/guuey depends on @guuey/cli as '${dep}'; it must be 'workspace:*', which publishes as the exact ` +
        `cli version, so guuey@${expected} runs @guuey/cli@${cli.version} and nothing else.`
    );
  return { expected, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = new URL("../", import.meta.url).pathname;
  const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
  const cli = read("packages/cli/package.json");
  const forwarder = read("packages/guuey/package.json");
  const { expected, problems } = forwarderPairing(cli, forwarder);
  if (problems.length > 0) {
    console.error("The bare-name forwarder is not paired with this cut's @guuey/cli:\n");
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  console.log(`Forwarder paired: guuey@${expected} runs @guuey/cli@${cli.version} (workspace:* → exact at publish).`);
}
