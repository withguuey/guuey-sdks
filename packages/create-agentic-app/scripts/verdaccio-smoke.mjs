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
//   - The scaffolded project gets a project-local `.npmrc` pinning `registry`
//     (a project `.npmrc` beats env vars and is honored by the whole
//     workspace install). pnpm 11+ reads ONLY auth and registry from
//     `.npmrc`, so the hermetic per-run `storeDir`/`cacheDir` go in the
//     scaffold's `pnpm-workspace.yaml` instead (guuey#2880: written to
//     `.npmrc`, they were ignored and every run landed in the machine's
//     shared global store). The run asserts its store path before installing.
//   - Every pnpm call in the scaffold runs the pinned `SCAFFOLD_PNPM` (the one
//     the scaffolder itself falls back to), never corepack's floating default.
//   - Verdaccio is spawned + torn down with process-group discipline: `npx`
//     spawns the actual `verdaccio` server as a CHILD process, so a plain
//     `child.kill()` (which only signals npx) orphans the server and leaks
//     port 4874 to the next run. SIGTERM the whole group; SIGKILL backstop.
//
// Slow + network-touching (npmjs uplink for every non-internal dep) — gated
// on RUN_VERDACCIO_SMOKE=1, NOT part of `make test-fast`.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, accessSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { INTERNAL_COHORT } from "./lib/pack-cohort.mjs";

if (process.env.RUN_VERDACCIO_SMOKE !== "1") {
  console.log(
    "[verdaccio-smoke] skipped (set RUN_VERDACCIO_SMOKE=1 to run — slow, network-touching, not part of make test-fast)",
  );
  process.exit(0);
}

const repoRoot = resolve(import.meta.dirname, "../../../..");
const REGISTRY = "http://localhost:4874";
const PORT = 4874;

// Single-sourced publish cohort (`./lib/pack-cohort.mjs`, shared with
// scaffold-smoke.mjs, the clean-room run-gate.mjs and dev-env-e2e.mjs):
// every internal package a scaffolded app depends on, directly or
// transitively (@guuey/cli depends on the silverprotocol facet packages +
// create-agentic-app itself).
const INTERNAL = INTERNAL_COHORT;
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
  // The work dir holds verdaccio's storage, so it goes after the process does,
  // on every path that reaches cleanup (the end of the run and both signals).
  rmSync(work, { recursive: true, force: true });
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
  // The repo's own steps (this build, the publish below) run plain `pnpm`,
  // which switches itself to the repo's pinned packageManager. Under
  // `corepack pnpm`, turbo's child `pnpm run build` inherits corepack's
  // environment, and a PATH pnpm of another version then refuses to switch
  // and exits 1 on every cache miss (measured 11-12: Homebrew pnpm 11.2.2
  // against the pinned 12.16.0).
  const names = INTERNAL.map(
    (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name,
  );
  console.log(`[verdaccio-smoke] building cohort: ${names.join(", ")}`);
  sh("pnpm", [
    "exec",
    "turbo",
    "run",
    "build",
    ...names.map((n) => `--filter=${n}`),
  ]);

  // The scaffold's pnpm, read from the build just made (src/pnpm.ts is the one
  // place it is written down).
  const { SCAFFOLD_PNPM } = await import(
    pathToFileURL(join(import.meta.dirname, "..", "dist", "index.js")).href
  );
  console.log(`[verdaccio-smoke] scaffold pnpm: ${SCAFFOLD_PNPM}`);

  // 4. Publish the internal cohort for real — `pnpm publish` rewrites every
  // `workspace:*` dependency to the real local version, exactly as a publish
  // to npmjs would.
  for (const dir of INTERNAL) {
    const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
    console.log(`[verdaccio-smoke] publishing ${name} (${dir})`);
    sh("pnpm", ["publish", "--registry", REGISTRY, "--no-git-checks", "--access", "public"], {
      cwd: dir,
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
    // the ggui reference). No auth token needed (verified: `publish: $all`
    // requires none — see above). `.npmrc` carries nothing else: pnpm 11+
    // reads only auth and registry from it.
    writeFileSync(join(appDir, ".npmrc"), `registry=${REGISTRY}/\n`);

    // Per-run store/cache dirs keep the install hermetic. They are pnpm
    // settings, so they go in the scaffold's pnpm-workspace.yaml.
    const storeDir = join(work, `pnpm-store-${framework}`);
    const cacheDir = join(work, `pnpm-cache-${framework}`);
    const workspaceYaml = join(appDir, "pnpm-workspace.yaml");
    if (/^(storeDir|cacheDir):/m.test(readFileSync(workspaceYaml, "utf8"))) {
      throw new Error(`[verdaccio-smoke] ${workspaceYaml} already sets storeDir/cacheDir; the smoke will not override a template's setting`);
    }
    appendFileSync(
      workspaceYaml,
      `\n# verdaccio-smoke: per-run store and cache\nstoreDir: ${JSON.stringify(storeDir)}\ncacheDir: ${JSON.stringify(cacheDir)}\n`,
    );
    const pnpm = (args) => sh("corepack", [SCAFFOLD_PNPM, ...args], { cwd: appDir });
    const storePath = execFileSync("corepack", [SCAFFOLD_PNPM, "store", "path"], {
      cwd: appDir,
      encoding: "utf8",
    }).trim();
    if (!storePath.startsWith(storeDir)) {
      throw new Error(`[verdaccio-smoke] pnpm store path is ${storePath}, not under the per-run ${storeDir}`);
    }
    console.log(`[verdaccio-smoke] ${framework}: pnpm store ${storePath}`);

    // The golden path's bootstrap step — production web builds are gated on it.
    console.log(`[verdaccio-smoke] bootstrap ${framework}`);
    sh("node", ["scripts/bootstrap.mjs", "--yes"], { cwd: appDir });

    console.log(`[verdaccio-smoke] installing ${framework}`);
    pnpm(["install"]);
    console.log(`[verdaccio-smoke] typecheck ${framework}`);
    pnpm(["-r", "typecheck"]); // workspace packages (mcps/*, web)
    pnpm(["typecheck"]); // root worker (not a workspace member of `-r`)
    console.log(`[verdaccio-smoke] build ${framework}`);
    pnpm(["-r", "build"]);
    pnpm(["build"]); // root build → guuey.worker.js
    accessSync(join(appDir, "guuey.worker.js"));
    console.log(`\n✓ ${framework} scaffold (via real Verdaccio npx resolution) builds clean\n`);
  }

  console.log("[verdaccio-smoke] all frameworks green");
} finally {
  await cleanup();
}
