#!/usr/bin/env node
// Pack-tarball scaffold smoke (silverprotocol pack-smoke pattern):
// validates what npm users actually install, before anything is published.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const work = mkdtempSync(join(tmpdir(), "caa-smoke-"));
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });

// 1. Pack every internal package a scaffolded app depends on.
const INTERNAL = [
  "oss/packages/worker",
  "oss/packages/config",
  "oss/packages/create-agentic-app",
  "oss/packages/cli",
  "silverprotocol/sdks/typescript/packages/core",
];
const tarballs = {};
for (const dir of INTERNAL) {
  const out = execFileSync("corepack", ["pnpm", "pack", "--pack-destination", work], {
    cwd: join(repoRoot, dir),
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .at(-1);
  const name = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")).name;
  tarballs[name] = out;
}

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
  // pnpm 10+ moved `overrides` out of package.json's "pnpm" field into pnpm-workspace.yaml
  // (root-of-project-only setting) — see https://pnpm.io/settings#overrides.
  const workspaceYamlPath = join(appDir, "pnpm-workspace.yaml");
  const workspaceYaml = readFileSync(workspaceYamlPath, "utf8");
  const overridesYaml = Object.entries(tarballs)
    .map(([n, t]) => `  "${n}": "file:${t}"`)
    .join("\n");
  writeFileSync(workspaceYamlPath, `${workspaceYaml}\noverrides:\n${overridesYaml}\n`);

  // 4. Install + typecheck + build (recursive: root worker, todo MCP, web).
  sh("corepack", ["pnpm", "install", "--no-frozen-lockfile"], { cwd: appDir });
  sh("corepack", ["pnpm", "-r", "typecheck"], { cwd: appDir });
  sh("corepack", ["pnpm", "-r", "build"], { cwd: appDir });
  sh("corepack", ["pnpm", "build"], { cwd: appDir }); // root build → guuey.worker.js
  sh("node", ["-e", "require('fs').accessSync('guuey.worker.js')"], { cwd: appDir });
  console.log(`\n✓ ${framework} scaffold builds clean\n`);
}
