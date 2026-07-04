#!/usr/bin/env node
// Verdaccio cold-path smoke — the higher-fidelity cousin of scaffold-smoke.mjs
// (which pnpm-packs + workspace-overrides, never touching a real registry).
// This one boots a throwaway Verdaccio, PUBLISHES the internal cohort for
// real, then drives the SAME `npx <pkg>` resolution path an end user hits:
// registry-hosted metadata, real semver ranges, real tarball fetches.
//
// Modeled on ggui's proven scaffold-render harness
// (`ggui/oss/e2e/scaffold-render/scripts/scaffold-and-boot.sh` +
// `tests/scaffold-app-harness.ts`):
//   - npx resolves the scaffolder itself FROM THE REGISTRY, so the registry
//     pin must reach npx's own resolution, not just the scaffolded app's
//     installs — hence `npm_config_registry` (npx honors config env vars).
//   - pnpm 11 silently IGNORES an env-var `cache-dir`/`store-dir` override
//     (proven in that harness), so the scaffolded project also gets a
//     project-local `.npmrc` pinning `registry` (+ hermetic cache/store dirs)
//     — a project `.npmrc` beats env vars and is honored by the whole
//     workspace install.
//   - Verdaccio is spawned + torn down with process-group discipline: `npx`
//     spawns the actual `verdaccio` server as a CHILD process, so a plain
//     `child.kill()` (which only signals npx) orphans the server and leaks
//     port 4874 to the next run. SIGTERM the whole group; SIGKILL backstop.
//
// Slow + network-touching (npmjs uplink for every non-internal dep) — gated
// on RUN_VERDACCIO_SMOKE=1, NOT part of `make test-fast`.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, accessSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.env.RUN_VERDACCIO_SMOKE !== "1") {
  console.log(
    "[verdaccio-smoke] skipped (set RUN_VERDACCIO_SMOKE=1 to run — slow, network-touching, not part of make test-fast)",
  );
  process.exit(0);
}

const repoRoot = resolve(import.meta.dirname, "../../../..");
const REGISTRY = "http://localhost:4874";
const PORT = 4874;

// Same cohort + order as scaffold-smoke.mjs's INTERNAL: every internal
// package a scaffolded app depends on, directly or transitively (@guuey/cli
// depends on the silverprotocol facet packages + create-agentic-app itself).
const INTERNAL = [
  "oss/packages/worker",
  "oss/packages/config",
  "oss/packages/create-agentic-app",
  "oss/packages/cli",
  "silverprotocol/sdks/typescript/packages/core",
  "silverprotocol/sdks/typescript/packages/claude-agent-sdk",
  "silverprotocol/sdks/typescript/packages/openai-agents",
];
const FRAMEWORKS = ["claude-agent-sdk", "openai-agents-sdk"];

const work = mkdtempSync(join(tmpdir(), "caa-verdaccio-"));
console.log(`[verdaccio-smoke] work dir: ${work}`);

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });

/** Signal a process group. ESRCH (already gone) is benign; anything else is
 * a genuine teardown failure — surface it, but never throw from cleanup. */
function signalGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch (e) {
    if (e.code !== "ESRCH") {
      console.warn(`[verdaccio-smoke] failed to ${sig} process group ${pid}: ${e.code ?? e}`);
    }
  }
}

async function killGroup(child) {
  if (!child.pid || child.exitCode !== null) return;
  const pid = child.pid;
  signalGroup(pid, "SIGTERM");
  await new Promise((done) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
    };
    child.once("exit", finish);
    setTimeout(() => {
      if (child.exitCode === null) signalGroup(pid, "SIGKILL");
      finish();
    }, 8_000).unref();
  });
}

async function isAnswering(url) {
  try {
    const res = await fetch(url);
    await res.body?.cancel?.();
    return true;
  } catch {
    return false;
  }
}

async function waitForReady(url, deadlineMs, child, dump) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`verdaccio exited early (code ${child.exitCode}). Output:\n${dump().slice(-3000)}`);
    }
    if (await isAnswering(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`verdaccio never became ready at ${url}. Output:\n${dump().slice(-3000)}`);
}

// 1. Temp verdaccio config: `@guuey/*` + `@silverprotocol/*` are LOCAL-only
// publish/access (no uplink fallthrough — a fallthrough to the real npmjs
// prerelease of these names, if one ever exists, would silently false-pass
// the gate), no auth required (verified empirically: `publish: $all` lets
// pnpm publish through with zero auth config — no htpasswd/token dance
// needed for a throwaway smoke registry). Everything else proxies to npmjs.
const storageDir = join(work, "storage");
mkdirSync(storageDir, { recursive: true });
const configPath = join(work, "config.yaml");
writeFileSync(
  configPath,
  `storage: ${storageDir}
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@guuey/*':
    access: $all
    publish: $all
  '@silverprotocol/*':
    access: $all
    publish: $all
  '**':
    access: $all
    proxy: npmjs
server:
  keepAliveTimeout: 60
max_body_size: 50mb
listen: 0.0.0.0:${PORT}
log:
  type: stdout
  format: pretty
  level: warn
`,
);

// 2. Spawn verdaccio detached (own process group — npx's real verdaccio
// server child inherits it) so teardown can SIGTERM the whole tree.
console.log(`[verdaccio-smoke] booting verdaccio on :${PORT}`);
let verdaccioLog = "";
const verdaccio = spawn("npx", ["-y", "verdaccio@6", "--config", configPath, "--listen", String(PORT)], {
  cwd: work,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
verdaccio.stdout?.on("data", (d) => {
  verdaccioLog += d.toString();
});
verdaccio.stderr?.on("data", (d) => {
  verdaccioLog += d.toString();
});

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  console.log("[verdaccio-smoke] tearing down verdaccio");
  await killGroup(verdaccio);
}
process.on("SIGINT", () => {
  cleanup().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  cleanup().finally(() => process.exit(143));
});

try {
  await waitForReady(`${REGISTRY}/-/ping`, 60_000, verdaccio, () => verdaccioLog);
  console.log("[verdaccio-smoke] verdaccio is up");

  // 3. Build the cohort so `dist/` is fresh before packing (turbo's
  // dependsOn:['^build'] pulls in the transitive internal deps too).
  const names = INTERNAL.map(
    (dir) => JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")).name,
  );
  console.log(`[verdaccio-smoke] building cohort: ${names.join(", ")}`);
  sh("corepack", [
    "pnpm",
    "exec",
    "turbo",
    "run",
    "build",
    ...names.map((n) => `--filter=${n}`),
  ]);

  // 4. Publish the internal cohort for real — `pnpm publish` rewrites every
  // `workspace:*` dependency to the real local version, exactly as a publish
  // to npmjs would.
  for (const dir of INTERNAL) {
    const name = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")).name;
    console.log(`[verdaccio-smoke] publishing ${name} (${dir})`);
    sh("corepack", ["pnpm", "publish", "--registry", REGISTRY, "--no-git-checks", "--access", "public"], {
      cwd: join(repoRoot, dir),
    });
  }

  // 5. Scaffold + install + build each framework via the REAL npx-resolution
  // path (npx fetches `@guuey/create-agentic-app` itself from the registry).
  for (const framework of FRAMEWORKS) {
    const appDir = join(work, `app-${framework}`);
    const npmCache = join(work, `npm-cache-${framework}`);
    console.log(`[verdaccio-smoke] scaffolding ${framework} → ${appDir}`);
    sh(
      "npx",
      ["-y", "--registry", REGISTRY, "@guuey/create-agentic-app", appDir, "--framework", framework, "--name", "smoke-app", "--no-git"],
      {
        env: {
          ...process.env,
          npm_config_registry: `${REGISTRY}/`,
          npm_config_cache: npmCache,
        },
      },
    );

    // Project `.npmrc` pins the whole workspace install to Verdaccio (env
    // vars alone are NOT honored by pnpm 11's nested resolution — proven in
    // the ggui reference). Per-run cache/store dirs keep it hermetic. No auth
    // token needed (verified: `publish: $all` requires none — see above).
    writeFileSync(
      join(appDir, ".npmrc"),
      `registry=${REGISTRY}/
cache-dir=${join(work, `pnpm-cache-${framework}`)}
store-dir=${join(work, `pnpm-store-${framework}`)}
`,
    );

    console.log(`[verdaccio-smoke] installing ${framework}`);
    sh("corepack", ["pnpm", "install"], { cwd: appDir });
    console.log(`[verdaccio-smoke] typecheck ${framework}`);
    sh("corepack", ["pnpm", "-r", "typecheck"], { cwd: appDir }); // workspace packages (mcps/*, web)
    sh("corepack", ["pnpm", "typecheck"], { cwd: appDir }); // root worker (not a workspace member of `-r`)
    console.log(`[verdaccio-smoke] build ${framework}`);
    sh("corepack", ["pnpm", "-r", "build"], { cwd: appDir });
    sh("corepack", ["pnpm", "build"], { cwd: appDir }); // root build → guuey.worker.js
    accessSync(join(appDir, "guuey.worker.js"));
    console.log(`\n✓ ${framework} scaffold (via real Verdaccio npx resolution) builds clean\n`);
  }

  console.log("[verdaccio-smoke] all frameworks green");
} finally {
  await cleanup();
}
