#!/usr/bin/env node
// Shared pack-tarball-cohort helper (silverprotocol `pack-smoke` pattern):
// validates what npm users actually install, before anything is published.
// Extracted from scaffold-smoke.mjs so the stage-3 dev-env e2e script
// (`e2e/scaffolder/scripts/dev-env-e2e.mjs`) can reuse the exact same mechanism
// instead of re-deriving it — see the scaffolder-e2e-tiers plan (Task 3,
// Global Constraints: "reuse, not duplicate").
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Every publishable package in the workspace tree — DERIVED from the
// sibling package manifests, never listed by name. The release gate runs the
// smoke BEFORE the npm publish, so any @guuey/* package a scaffolded app pulls
// (directly, or transitively through another cohort member) must be packed
// here or the gate's install fetches it from a registry it is not on yet.
// A by-name list missed exactly that: @guuey/hooks joined the cohort as a
// dependency of @guuey/config and the scaffolded app's install died with
// ERR_PNPM_FETCH_404 (guuey#1528). Packing the whole tree is a few extra
// `pnpm pack` seconds and no fourth list to keep in step with ORDER and the
// Unit matrix. @silverprotocol/* stays off — external npm deps at an
// already-published pin; `private: true` manifests are skipped.
// Package dirs are resolved as SIBLINGS of create-agentic-app (this script
// lives at <pkg>/scripts/lib/), NOT repo-root-relative: the same tree is
// `oss/packages/*` in the guuey monorepo and `packages/*` in the public
// guuey-sdks mirror — a hardcoded prefix broke the mirror's cold-clone smoke
// (nonexistent cwd surfaces as a misleading `spawnSync corepack ENOENT`).
const PACKAGES_ROOT = resolve(import.meta.dirname, "../../..");

/** Is this sibling directory a publishable guuey package (`@guuey/*` or the bare `guuey` forwarder)? */
function isCohortPackage(dir) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return false;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private === true) return false;
  return manifest.name === "guuey" || String(manifest.name).startsWith("@guuey/");
}

export const INTERNAL_COHORT = readdirSync(PACKAGES_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(PACKAGES_ROOT, entry.name))
  .filter(isCohortPackage)
  .sort();

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
