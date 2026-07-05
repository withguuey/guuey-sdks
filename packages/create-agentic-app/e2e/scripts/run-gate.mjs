#!/usr/bin/env node
// Clean-room gate-runner — the containerized, hermetic form of
// ../../scripts/verdaccio-smoke.mjs (see that file for the full design
// rationale: npx's OWN resolution needs npm_config_registry; pnpm 11
// silently ignores an env-var cache-dir/store-dir override, proven in
// ggui's scaffold-render harness, so the scaffolded app also gets a project
// .npmrc). Ported to run as the ENTRYPOINT inside the gate-runner container
// (see ../docker-compose.yml) against a compose-managed Verdaccio.
//
// No gating env var here, unlike the host script: the
// `docker compose up --exit-code-from gate-runner` invocation IS the gate
// (see the root Makefile's `test-scaffold-clean-room` target).
//
// Sequence: wait for Verdaccio (belt-and-braces — compose's
// `depends_on: condition: service_healthy` already gates our start) →
// pnpm install --frozen-lockfile (whole workspace — see Dockerfile for why)
// → build the internal cohort (turbo) → publish the cohort to Verdaccio →
// per framework: npx-scaffold from the registry → project .npmrc pinning
// the registry → install → `-r typecheck` → `-r build` → root
// typecheck+build → assert `guuey.worker.js`. Any failing step throws,
// which — uncaught — exits the process non-zero, so any failure blocks the
// gate (`--exit-code-from gate-runner`).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, accessSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = "/build";
const REGISTRY = process.env.VERDACCIO_URL ?? "http://verdaccio:4873";

// The publish cohort is single-sourced in the scaffolder package's
// pack-cohort module (shared with scaffold-smoke.mjs, verdaccio-smoke.mjs
// and dev-env-e2e.mjs): every internal package a scaffolded app depends on,
// directly or transitively. This script is bind-mounted at /gate/scripts —
// OUTSIDE the COPY'd repo tree — so a relative import can't reach the
// module; dynamic-import it from the baked repo copy instead.
const { INTERNAL_COHORT: INTERNAL } = await import(
  pathToFileURL(join(REPO_ROOT, "oss/packages/create-agentic-app/scripts/lib/pack-cohort.mjs"))
    .href
);
const FRAMEWORKS = ["claude-agent-sdk", "openai-agents-sdk"];

const work = mkdtempSync(join(tmpdir(), "caa-gate-"));
console.log(`[run-gate] work dir: ${work}`);

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: REPO_ROOT, ...opts });

async function waitForVerdaccio(url, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/-/ping`);
      await res.body?.cancel?.();
      if (res.ok) return;
    } catch {
      // Not up yet — retry until the deadline.
    }
    if (Date.now() >= deadline) {
      throw new Error(`Verdaccio never became ready at ${url}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

console.log(`[run-gate] [1/5] waiting for Verdaccio at ${REGISTRY}`);
await waitForVerdaccio(REGISTRY, 30_000);
console.log("[run-gate]   Verdaccio is up");

console.log("[run-gate] [2/5] pnpm install --frozen-lockfile (whole workspace)");
sh("corepack", ["pnpm", "install", "--frozen-lockfile"]);

console.log("[run-gate] [3/5] building the internal cohort");
const cohortNames = INTERNAL.map(
  (dir) => JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")).name,
);
console.log(`[run-gate]   cohort: ${cohortNames.join(", ")}`);
sh("corepack", [
  "pnpm",
  "exec",
  "turbo",
  "run",
  "build",
  ...cohortNames.map((n) => `--filter=${n}`),
]);

console.log("[run-gate] [4/5] publishing the internal cohort to Verdaccio");
for (const dir of INTERNAL) {
  const name = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")).name;
  console.log(`[run-gate]   publishing ${name} (${dir})`);
  sh(
    "corepack",
    ["pnpm", "publish", "--registry", REGISTRY, "--no-git-checks", "--access", "public"],
    { cwd: join(REPO_ROOT, dir) },
  );
}

console.log("[run-gate] [5/5] per-framework scaffold → install → typecheck → build");
for (const framework of FRAMEWORKS) {
  const appDir = join(work, `app-${framework}`);
  const npmCache = join(work, `npm-cache-${framework}`);
  console.log(`[run-gate]   scaffolding ${framework} → ${appDir}`);
  sh(
    "npx",
    [
      "-y",
      "--registry",
      REGISTRY,
      "@guuey/create-agentic-app",
      appDir,
      "--framework",
      framework,
      "--name",
      "gate-app",
      "--no-git",
    ],
    {
      cwd: work,
      env: {
        ...process.env,
        npm_config_registry: `${REGISTRY}/`,
        npm_config_cache: npmCache,
      },
    },
  );

  // Project .npmrc pins the whole workspace install to Verdaccio — a
  // project .npmrc beats env vars and is honored by pnpm's nested
  // resolution across the whole workspace, unlike an env-var
  // cache-dir/store-dir override, which pnpm 11 silently ignores (proven in
  // ggui's scaffold-render harness). Per-framework cache/store dirs keep
  // this hermetic across the two scaffolds in the same run.
  writeFileSync(
    join(appDir, ".npmrc"),
    `registry=${REGISTRY}/
cache-dir=${join(work, `pnpm-cache-${framework}`)}
store-dir=${join(work, `pnpm-store-${framework}`)}
`,
  );

  console.log(`[run-gate]   installing ${framework}`);
  sh("corepack", ["pnpm", "install"], { cwd: appDir });
  console.log(`[run-gate]   typecheck ${framework}`);
  sh("corepack", ["pnpm", "-r", "typecheck"], { cwd: appDir }); // workspace packages (mcps/*, web)
  sh("corepack", ["pnpm", "typecheck"], { cwd: appDir }); // root worker (not a workspace member of `-r`)
  console.log(`[run-gate]   build ${framework}`);
  sh("corepack", ["pnpm", "-r", "build"], { cwd: appDir });
  sh("corepack", ["pnpm", "build"], { cwd: appDir }); // root build → guuey.worker.js
  accessSync(join(appDir, "guuey.worker.js"));
  console.log(`[run-gate]   ✓ ${framework} scaffold (real Verdaccio npx resolution) builds clean`);
}

console.log("[run-gate] all frameworks green — CLEAN-ROOM GATE PASSED");
