#!/usr/bin/env node
// Shared pack-tarball-cohort helper (silverprotocol `pack-smoke` pattern):
// validates what npm users actually install, before anything is published.
// Extracted from scaffold-smoke.mjs so the stage-3 dev-env e2e script
// (`../../e2e/scripts/dev-env-e2e.mjs`) can reuse the exact same mechanism
// instead of re-deriving it — see the scaffolder-e2e-tiers plan (Task 3,
// Global Constraints: "reuse, not duplicate").
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Every internal package a scaffolded app depends on, including transitive
// internal deps of @guuey/cli. NOTE (2026-07-06): @silverprotocol/* left this
// cohort — published to npm (0.1.0), so scaffolded apps and @guuey/cli resolve
// them from the public registry like any other dep. Only the still-unpublished
// @guuey/* packages need packing.
// Package dirs are resolved as SIBLINGS of create-agentic-app (this script
// lives at <pkg>/scripts/lib/), NOT repo-root-relative: the same tree is
// `oss/packages/*` in the guuey monorepo and `packages/*` in the public
// guuey-sdks mirror — a hardcoded prefix broke the mirror's cold-clone smoke
// (nonexistent cwd surfaces as a misleading `spawnSync corepack ENOENT`).
const PACKAGES_ROOT = resolve(import.meta.dirname, "../../..");
export const INTERNAL_COHORT = ["worker", "config", "create-agentic-app", "cli"].map(
  (name) => join(PACKAGES_ROOT, name),
);

/**
 * `pnpm pack` every {@link INTERNAL_COHORT} package into `destDir`.
 * Returns a `{ [packageName]: tarballPath }` map.
 */
export function packInternalCohort(destDir) {
  const tarballs = {};
  for (const dir of INTERNAL_COHORT) {
    const out = execFileSync("corepack", ["pnpm", "pack", "--pack-destination", destDir], {
      cwd: dir,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .at(-1);
    const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
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
