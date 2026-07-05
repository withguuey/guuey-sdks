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

const repoRoot = resolve(import.meta.dirname, "../../../..");
const work = mkdtempSync(join(tmpdir(), "caa-smoke-"));
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });

// 1. Pack every internal package a scaffolded app depends on.
const tarballs = packInternalCohort(repoRoot, work);

// 2. Scaffold both frameworks from the built CLI.
for (const framework of ["claude-agent-sdk", "openai-agents-sdk"]) {
  const appDir = join(work, `app-${framework}`);
  sh("node", [
    join(repoRoot, "oss/packages/create-agentic-app/dist/cli.js"),
    appDir,
    "--framework",
    framework,
    "--name",
    "smoke-app",
    "--no-git",
  ]);

  // 3. Point internal deps at the packed tarballs (validates packed artifacts, not workspace links).
  applyPackOverrides(appDir, tarballs);

  // 4. Install + typecheck + build (recursive: root worker, todo MCP, web).
  sh("corepack", ["pnpm", "install", "--no-frozen-lockfile"], { cwd: appDir });
  sh("corepack", ["pnpm", "-r", "typecheck"], { cwd: appDir }); // workspace packages (mcps/*, web)
  sh("corepack", ["pnpm", "typecheck"], { cwd: appDir }); // root worker (not a workspace member of `-r`)
  sh("corepack", ["pnpm", "-r", "build"], { cwd: appDir });
  sh("corepack", ["pnpm", "build"], { cwd: appDir }); // root build → guuey.worker.js
  sh("node", ["-e", "require('fs').accessSync('guuey.worker.js')"], { cwd: appDir });
  console.log(`\n✓ ${framework} scaffold builds clean\n`);
}
