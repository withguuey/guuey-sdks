#!/usr/bin/env node
// Pack-tarball scaffold smoke (silverprotocol pack-smoke pattern):
// validates what npm users actually install, before anything is published.
// The pack/override mechanism itself lives in `./lib/pack-cohort.mjs`
// (shared with `../e2e/scripts/dev-env-e2e.mjs` — stage-3 real-infra e2e
// reuses the exact same tarball-override scaffold, since npm publishes may
// not exist yet either).
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packInternalCohort, applyPackOverrides } from "./lib/pack-cohort.mjs";

// Layout-agnostic: everything resolves from THIS package's root — the tree
// is oss/packages/* in the monorepo and packages/* in the guuey-sdks mirror.
const pkgRoot = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "caa-smoke-"));
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: pkgRoot, ...opts });

// 1. Pack every internal package a scaffolded app depends on.
const tarballs = packInternalCohort(work);

// 2. Scaffold the full template × framework matrix from the built CLI.
const MATRIX = [];
for (const framework of ["claude-agent-sdk", "openai-agents-sdk", "google-adk"]) {
  for (const template of ["base", "agentic-app"]) {
    MATRIX.push({ framework, template });
  }
}
for (const { framework, template } of MATRIX) {
  const appDir = join(work, `app-${template}-${framework}`);
  sh("node", [
    join(pkgRoot, "dist/cli.js"),
    appDir,
    "--template",
    template,
    "--framework",
    framework,
    "--name",
    "smoke-app",
    "--no-git",
  ]);

  // 3. The golden path's next step: bootstrap (local phase, no account, no
  // deps — plain node). Production web builds are gated on this by design.
  sh("node", ["scripts/bootstrap.mjs", "--yes"], { cwd: appDir });

  // 4. Point internal deps at the packed tarballs (validates packed artifacts, not workspace links).
  applyPackOverrides(appDir, tarballs);

  // 4. Install + typecheck + build (recursive: root worker, todo MCP, web).
  sh("corepack", ["pnpm", "install", "--no-frozen-lockfile"], { cwd: appDir });
  sh("corepack", ["pnpm", "-r", "typecheck"], { cwd: appDir }); // workspace packages (mcps/*, web)
  sh("corepack", ["pnpm", "typecheck"], { cwd: appDir }); // root worker (not a workspace member of `-r`)
  sh("corepack", ["pnpm", "-r", "build"], { cwd: appDir });
  // Root build output: claude bundles self-contained guuey.worker.js; openai
  // emits worker.js (external deps, guuey.json#worker — the guuey.worker.js
  // name means skip-install to the image build); google-adk emits the
  // graceful agent module (guuey.json#agent.entry).
  const expectedOut =
    framework === "google-adk" ? "agent.js" : framework === "openai-agents-sdk" ? "worker.js" : "guuey.worker.js";
  sh("corepack", ["pnpm", "build"], { cwd: appDir });
  sh("node", ["-e", `require('fs').accessSync('${expectedOut}')`], { cwd: appDir });
  console.log(`\n✓ ${template}/${framework} scaffold builds clean\n`);
}
