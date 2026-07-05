#!/usr/bin/env node
// Shared pack-tarball-cohort helper (silverprotocol `pack-smoke` pattern):
// validates what npm users actually install, before anything is published.
// Extracted from scaffold-smoke.mjs so the stage-3 dev-env e2e script
// (`../../e2e/scripts/dev-env-e2e.mjs`) can reuse the exact same mechanism
// instead of re-deriving it — see the scaffolder-e2e-tiers plan (Task 3,
// Global Constraints: "reuse, not duplicate").
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Every internal package a scaffolded app depends on — including
// TRANSITIVE internal deps: @guuey/cli itself depends on the silverprotocol
// facet packages (claude-agent-sdk, openai-agents), all unpublished, so
// omitting them makes pnpm fall through to the public registry and 404.
export const INTERNAL_COHORT = [
  "oss/packages/worker",
  "oss/packages/config",
  "oss/packages/create-agentic-app",
  "oss/packages/cli",
  "silverprotocol/sdks/typescript/packages/core",
  "silverprotocol/sdks/typescript/packages/claude-agent-sdk",
  "silverprotocol/sdks/typescript/packages/openai-agents",
];

/**
 * `pnpm pack` every {@link INTERNAL_COHORT} package into `destDir`.
 * Returns a `{ [packageName]: tarballPath }` map.
 */
export function packInternalCohort(repoRoot, destDir) {
  const tarballs = {};
  for (const dir of INTERNAL_COHORT) {
    const out = execFileSync("corepack", ["pnpm", "pack", "--pack-destination", destDir], {
      cwd: join(repoRoot, dir),
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .at(-1);
    const name = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")).name;
    tarballs[name] = out;
  }
  return tarballs;
}

/**
 * Point every internal dep at its packed tarball in a scaffolded app's
 * `pnpm-workspace.yaml` (validates the _packed_ artifacts, not workspace
 * links — pnpm 10+ moved `overrides` out of package.json's "pnpm" field
 * into pnpm-workspace.yaml, a root-of-project-only setting; see
 * https://pnpm.io/settings#overrides).
 */
export function applyPackOverrides(appDir, tarballs) {
  const workspaceYamlPath = join(appDir, "pnpm-workspace.yaml");
  const workspaceYaml = readFileSync(workspaceYamlPath, "utf8");
  const overridesYaml = Object.entries(tarballs)
    .map(([n, t]) => `  "${n}": "file:${t}"`)
    .join("\n");
  writeFileSync(workspaceYamlPath, `${workspaceYaml}\noverrides:\n${overridesYaml}\n`);
}
