#!/usr/bin/env node
// Stage 3 — real-infra e2e against the DEV ENV (per the 2026-07-04 amendment
// to `docs/superpowers/specs/2026-07-03-guuey-create-agentic-app-design.md`
// §11 and the scaffolder-e2e-tiers plan, Task 3). Operator/CI-with-secrets
// triggered — NEVER wired into keyless CI.
//
// Flow: scaffold (claude framework, pack-tarball overrides — reuses
// `../../scripts/lib/pack-cohort.mjs`, the exact mechanism
// `scripts/scaffold-smoke.mjs` uses, since npm publishes of the internal
// cohort may not exist yet) → `guuey login --token` → `guuey apps create`
// (throwaway, timestamped) → fix the todo MCP's hosted name → `guuey
// deploy` → assert every leg → curl (well, `fetch`) the deployed
// `/agent/invoke` → teardown, always, in a `finally`.
//
// Gated on GUUEY_E2E_PAT + GUUEY_E2E_API_URL + GUUEY_E2E_HOST +
// GUUEY_E2E_WORKSPACE (see the REQUIRED_ENV comment below for why the
// 4th var exists beyond the plan's original three) — exits 0 with a skip
// note if any are missing, so this never blocks keyless CI.
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packInternalCohort, applyPackOverrides } from "../../scripts/lib/pack-cohort.mjs";
import { collectSecretsFromEnv, redactSecrets } from "./lib/redact.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const CAA_ROOT = join(REPO_ROOT, "oss/packages/create-agentic-app");
const CLI_ROOT = join(REPO_ROOT, "oss/packages/cli");
const CAA_BIN = join(CAA_ROOT, "dist/cli.js");
const CLI_BIN = join(CLI_ROOT, "dist/cli.js");

const FRAMEWORK = "claude-agent-sdk";
// Fixed hosted-MCP name (per the plan: "reuse-by-name bounds residue").
// IMPORTANT — verified against source, NOT set via a guuey.json edit as
// originally sketched: the deploy orchestrator's MCP leg resolves the
// deployed server's NAME from the local package's `package.json#name`
// (scope-stripped), not from `guuey.json#agent.mcpServers.todo` (that key
// is only the internal leg identifier used for the `server` write-back —
// see `oss/packages/cli/src/commands/deploy.ts` around `planMcpLegs`:
// `const name = resolveServerName(undefined, readPackageName(dir)) ?? leg.name`,
// and `resolveServerName` in `oss/packages/cli/src/commands/mcp.ts`). So the
// fixed name is applied by editing `mcps/todo/package.json#name` below.
const FIXED_MCP_NAME = "e2e-todo";

const KEEP = process.argv.includes("--keep");

// ─── 0. Gate ───────────────────────────────────────────────────────────
// The plan names three gating vars (PAT, API_URL, HOST). A fourth,
// GUUEY_E2E_WORKSPACE, is required in practice: `guuey deploy`'s MCP leg
// refuses to run without a workspace (`doc.workspaceId ?? resolveWorkspaceId
// (flags, process.env)` in deploy.ts) and a freshly scaffolded guuey.json
// has no `workspaceId` (that's only stamped by `guuey pull` against an
// existing linked app). Gating on it too keeps this script from limping
// halfway through a real deploy before failing — see the Task 3 report for
// the full verification trail.
const REQUIRED_ENV = [
  "GUUEY_E2E_PAT",
  "GUUEY_E2E_API_URL",
  "GUUEY_E2E_HOST",
  "GUUEY_E2E_WORKSPACE",
];

function checkGate() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.log(`[dev-env-e2e] SKIPPED — missing required env: ${missing.join(", ")}`);
    console.log("[dev-env-e2e] This stage targets a REAL dev-env deployment. Set:");
    console.log("  GUUEY_E2E_PAT       — a dev-env Personal Access Token (ggui_pat_...)");
    console.log("  GUUEY_E2E_API_URL   — dev's amplify_outputs.json#custom.cliApiUrl");
    console.log("  GUUEY_E2E_HOST      — dev's platform host (e.g. https://<dev-domain>)");
    console.log("  GUUEY_E2E_WORKSPACE — a workspace id the PAT's user can deploy into");
    console.log("[dev-env-e2e] See smoke/live_e2e_scaffold_deploy.md Part B for how to obtain these.");
    process.exit(0);
  }
}

// ─── 1. Dev-env guard ────────────────────────────────────────────────
// Per Global Constraints: refuse to run against anything that looks like
// main/staging/prod. `GUUEY_E2E_I_KNOW_WHAT_IM_DOING=1` overrides.
const PROD_DEFAULT_HOST = "platform.guuey.com"; // DEFAULT_ENDPOINT's host (config.ts)
const PROD_GGUI_HOST = "mcp.ggui.ai";
const NON_DEV_MARKERS = ["staging", "release", "main."];

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

function assertDevEnv(apiUrl, host) {
  if (process.env.GUUEY_E2E_I_KNOW_WHAT_IM_DOING === "1") {
    console.log("[dev-env-e2e] GUUEY_E2E_I_KNOW_WHAT_IM_DOING=1 set — skipping the dev-env guard.");
    return;
  }

  const apiHost = hostnameOf(apiUrl);
  const platformHost = hostnameOf(host);
  const reasons = [];

  if (platformHost === PROD_DEFAULT_HOST) {
    reasons.push(`GUUEY_E2E_HOST resolves to the prod default host (${PROD_DEFAULT_HOST})`);
  }
  for (const marker of NON_DEV_MARKERS) {
    if (platformHost.includes(marker)) {
      reasons.push(`GUUEY_E2E_HOST (${platformHost}) contains non-dev marker "${marker}"`);
    }
    if (apiHost.includes(marker)) {
      reasons.push(`GUUEY_E2E_API_URL (${apiHost}) contains non-dev marker "${marker}"`);
    }
  }
  if (apiUrl.includes(PROD_GGUI_HOST) || host.includes(PROD_GGUI_HOST)) {
    reasons.push(`references the PROD ggui host (${PROD_GGUI_HOST})`);
  }
  // Positive signal: expect a "dev" label on the friendly platform host.
  // (`apiUrl` is typically an opaque API-Gateway-generated hostname across
  // every env, so it carries no reliable env marker — see the Task 3
  // report for why the guard leans on `host`, not `apiUrl`, for this check.)
  if (!platformHost.includes("dev")) {
    reasons.push(
      `GUUEY_E2E_HOST (${platformHost}) doesn't look like a dev-env host (expected a "dev" label)`,
    );
  }

  if (reasons.length > 0) {
    console.error("[dev-env-e2e] REFUSING to run — this does not look like the dev env:");
    for (const r of reasons) console.error(`  - ${r}`);
    console.error(
      "[dev-env-e2e] Set GUUEY_E2E_I_KNOW_WHAT_IM_DOING=1 to override (danger: this " +
        "script deletes the target app + hosted MCP server).",
    );
    process.exit(1);
  }
}

// Derive the expected ggui-dev federation substring from the resolved dev
// host at runtime (never hardcoded) — per the memory note on issuer naming
// (`<env>.id.sandbox.guuey.com`), the env label is the host's first
// subdomain component.
function deriveExpectedGguiDevSubstring(host) {
  const label = hostnameOf(host).split(".")[0];
  return `${label}.sandbox.guuey.com`;
}

// ─── Process helpers ───────────────────────────────────────────────────

// Central secret registry (populated in main(), once the gate passes):
// every value from *_PAT/*_TOKEN/*_KEY/*_SECRET/*_PASSWORD env vars. run()
// scrubs these from BOTH its echoed output chunks and every constructed
// error message (which embeds argv — the login step passes the PAT as a
// literal arg), so no call site — present or future — can leak a secret
// into logs. See ./lib/redact.mjs for the rationale + unit tests.
let SECRETS = [];

/** Run a command, streaming its (redacted) output live while also
 * capturing it. Error messages embed argv, so they are redacted too.
 *
 * `opts.bufferOutput: true` suppresses the live echo and ONLY accumulates —
 * for calls whose output CONTAINS a secret not yet in SECRETS (e.g. `apps
 * create --json` prints the app's apiKey). Live streaming would leak the
 * secret DURING the call, before any post-hoc SECRETS.push could apply; the
 * caller extracts + registers the secret, then echoes the buffered output
 * through `redactSecrets` itself. */
function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      if (!opts.bufferOutput) process.stdout.write(redactSecrets(String(d), SECRETS));
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (!opts.bufferOutput) process.stderr.write(redactSecrets(String(d), SECRETS));
    });
    child.on("error", (err) =>
      reject(new Error(redactSecrets(err instanceof Error ? err.message : String(err), SECRETS))),
    );
    child.on("close", (code) => {
      if (code !== 0 && !opts.allowFailure) {
        reject(new Error(redactSecrets(`${cmd} ${args.join(" ")} exited ${code}`, SECRETS)));
      } else {
        resolvePromise({ code, stdout, stderr });
      }
    });
  });
}

/** Extract the first balanced JSON value (object OR array — `--json`
 * commands print either) from noisy CLI stdout: a possible trailing async
 * update-check notice gets printed after `main()` resolves, and status
 * payloads can carry free-text (`errorMessage`) that itself contains
 * braces, so this is string-literal-aware, not a naive brace count. */
function extractFirstJson(text) {
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      start = i;
      break;
    }
  }
  if (start === -1) throw new Error(`No JSON found in output:\n${text}`);
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`Unbalanced JSON in output:\n${text}`);
}

function step(n, total, msg) {
  console.log(`\n[dev-env-e2e] [${n}/${total}] ${msg}`);
}

/** POST one turn to a deployed `/agent/invoke` and assert SSE framing:
 * `event: session` → ≥1 `event: message` → `event: done`. */
async function assertAgentInvokeStreams(url, timeoutMs = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "create a todo: buy milk" }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`POST ${url} failed: HTTP ${res.status}`);
    }

    const events = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = frame.match(/^event: (.+)$/m);
        if (m) {
          const name = m[1].trim();
          events.push(name);
          if (name === "done") {
            await reader.cancel().catch(() => {});
            return events;
          }
        }
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  checkGate();

  const pat = process.env.GUUEY_E2E_PAT;
  const apiUrl = process.env.GUUEY_E2E_API_URL;
  const host = process.env.GUUEY_E2E_HOST;
  const workspace = process.env.GUUEY_E2E_WORKSPACE;

  assertDevEnv(apiUrl, host);
  const expectedGguiSubstring = deriveExpectedGguiDevSubstring(host);

  // Register every secret in play BEFORE any child process runs, so run()'s
  // echoed output and error messages are scrubbed from the very first call.
  SECRETS = collectSecretsFromEnv(process.env, [pat]);

  const TOTAL = 13;
  const work = mkdtempSync(join(tmpdir(), "caa-dev-e2e-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "caa-dev-e2e-home-"));
  const appDir = join(work, "app");
  const appName = `e2e-caa-${Math.floor(Date.now() / 1000)}`;

  console.log(`[dev-env-e2e] work dir:  ${work}`);
  console.log(`[dev-env-e2e] fake HOME: ${fakeHome} (real ~/.guuey is never touched)`);
  console.log(`[dev-env-e2e] app name:  ${appName}`);
  console.log(`[dev-env-e2e] framework: ${FRAMEWORK}`);

  // Every guuey CLI invocation gets these — the isolated HOME keeps
  // `~/.guuey/config.json` / `~/.guuey/auth.json` scoped to this run.
  const cliEnv = {
    ...process.env,
    HOME: fakeHome,
    GUUEY_API_URL: apiUrl,
    GUUEY_HOST: host,
    GUUEY_WORKSPACE: workspace,
  };
  delete cliEnv.GGUI_APP_ID;
  const guuey = (args, opts = {}) =>
    run("node", [CLI_BIN, ...args], { cwd: appDir, env: cliEnv, ...opts });

  let appId;
  let serverId;
  const residue = [];

  try {
    step(1, TOTAL, "building @guuey/create-agentic-app + @guuey/cli (+ deps, via turbo)");
    await run(
      "corepack",
      [
        "pnpm",
        "exec",
        "turbo",
        "run",
        "build",
        "--filter=@guuey/create-agentic-app",
        "--filter=@guuey/cli",
      ],
      { cwd: REPO_ROOT },
    );

    step(2, TOTAL, "packing the internal cohort (pack-tarball overrides, no registry needed)");
    const tarballs = packInternalCohort(REPO_ROOT, work);

    step(3, TOTAL, `scaffolding ${FRAMEWORK} → ${appDir}`);
    await run(
      "node",
      [CAA_BIN, appDir, "--framework", FRAMEWORK, "--name", "dev-e2e-app", "--no-git"],
      { cwd: work },
    );
    applyPackOverrides(appDir, tarballs);

    step(4, TOTAL, `fixing the todo MCP's hosted name to "${FIXED_MCP_NAME}"`);
    const todoPkgPath = join(appDir, "mcps/todo/package.json");
    const todoPkg = JSON.parse(readFileSync(todoPkgPath, "utf8"));
    todoPkg.name = FIXED_MCP_NAME;
    writeFileSync(todoPkgPath, JSON.stringify(todoPkg, null, 2) + "\n");

    step(5, TOTAL, "pnpm install (whole scaffolded workspace)");
    await run("corepack", ["pnpm", "install", "--no-frozen-lockfile"], { cwd: appDir });

    step(6, TOTAL, "guuey login --token *** (PAT masked; isolated HOME)");
    try {
      await guuey(["login", "--token", pat]);
    } catch (err) {
      // run() already redacts the PAT out of this message; re-wrap it to
      // stay actionable without re-echoing argv at all.
      throw new Error(
        `guuey login failed (${err instanceof Error ? err.message : String(err)}) — ` +
          "is GUUEY_E2E_PAT a valid, unexpired dev-env PAT (ggui_pat_...)?",
      );
    }

    step(7, TOTAL, `guuey apps create --name ${appName}`);
    // bufferOutput: the --json response carries the app's apiKey, which is
    // not in SECRETS yet — live streaming would print it before we could
    // register it. Buffer → extract → register → echo redacted, in order.
    const createRes = await guuey(["apps", "create", "--name", appName, "--json"], {
      bufferOutput: true,
    });
    const created = extractFirstJson(createRes.stdout);
    if (typeof created.apiKey === "string" && created.apiKey.length > 0) {
      SECRETS.push(created.apiKey);
      SECRETS.sort((a, b) => b.length - a.length);
    }
    process.stdout.write(redactSecrets(createRes.stdout, SECRETS));
    process.stderr.write(redactSecrets(createRes.stderr, SECRETS));
    appId = created.appId;
    if (!appId) {
      throw new Error(
        `apps create did not return an appId: ${redactSecrets(createRes.stdout, SECRETS)}`,
      );
    }
    console.log(`[dev-env-e2e]   appId: ${appId}`);

    step(8, TOTAL, "guuey deploy (MCP leg + ggui leg + agent leg)");
    const deployRes = await guuey(["deploy"]);

    const liveMatch = deployRes.stdout.match(/Live at (\S+)/);
    if (!liveMatch) throw new Error("deploy output did not print a \"Live at <url>\" line");
    const deployedUrl = liveMatch[1];
    console.log(`[dev-env-e2e]   deployed endpoint: ${deployedUrl}`);

    const gguiWarnLine =
      "ggui assets not pushed — the platform-side API is pending (tracked cross-team); deploy continues";
    if (!deployRes.stdout.includes(gguiWarnLine)) {
      throw new Error(
        `Expected the ggui-leg warn-and-continue line ("${gguiWarnLine}") in deploy output — ` +
          "either the leg silently changed behavior or it errored instead of warning.",
      );
    }
    if (deployRes.stdout.includes(PROD_GGUI_HOST)) {
      throw new Error(`deploy output references the PROD ggui host (${PROD_GGUI_HOST})`);
    }
    // Forward-compatible: once PushAppAssets lands and the ggui leg starts
    // printing a real federated host, it must land in the dev cloud, never
    // prod. Today the leg is env-dormant (see the warn line above) so this
    // is a no-op most of the time — logged either way for visibility.
    const gguiHostMention = deployRes.stdout.match(/https?:\/\/\S*ggui\S*/i);
    if (gguiHostMention) {
      if (!gguiHostMention[0].includes(expectedGguiSubstring)) {
        throw new Error(
          `deploy output mentions a ggui host (${gguiHostMention[0]}) that doesn't match ` +
            `the dev pattern ("${expectedGguiSubstring}")`,
        );
      }
      console.log(`[dev-env-e2e]   ggui host observed and matches dev pattern: ${gguiHostMention[0]}`);
    } else {
      console.log(
        "[dev-env-e2e]   no ggui host observed in deploy output (leg is env-dormant today — " +
          `expected dev pattern pre-computed as "${expectedGguiSubstring}" for when it lands)`,
      );
    }

    step(9, TOTAL, "asserting guuey.json gained agent.mcpServers.todo.server");
    const guueyJsonPath = join(appDir, "guuey.json");
    const guueyJson = JSON.parse(readFileSync(guueyJsonPath, "utf8"));
    serverId = guueyJson?.agent?.mcpServers?.todo?.server;
    if (!serverId || typeof serverId !== "string") {
      throw new Error("guuey.json#agent.mcpServers.todo.server was not written back after deploy");
    }
    console.log(`[dev-env-e2e]   serverId: ${serverId}`);

    step(10, TOTAL, `guuey mcp status ${serverId} (assert live + runtimeUrl)`);
    const statusRes = await guuey(["mcp", "status", serverId, "--json"]);
    const status = extractFirstJson(statusRes.stdout);
    if (status.server?.hostingStatus !== "live") {
      throw new Error(`mcp status: expected hostingStatus 'live', got '${status.server?.hostingStatus}'`);
    }
    if (!status.server?.runtimeUrl) {
      throw new Error("mcp status: server has no runtimeUrl");
    }
    console.log(`[dev-env-e2e]   runtimeUrl: ${status.server.runtimeUrl}`);

    step(11, TOTAL, "guuey deployments list (assert newest = live)");
    const deploymentsRes = await guuey(["deployments", "list", "--json"]);
    const deployments = extractFirstJson(deploymentsRes.stdout);
    const rows = Array.isArray(deployments) ? deployments : deployments.deployments;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("deployments list returned no rows");
    }
    const newest = rows.reduce((a, b) => (b.buildNumber > a.buildNumber ? b : a));
    if (newest.status !== "live") {
      throw new Error(`newest deployment (#${newest.buildNumber}) status is '${newest.status}', expected 'live'`);
    }

    step(12, TOTAL, `POST ${deployedUrl} — asserting session → message(s) → done`);
    const events = await assertAgentInvokeStreams(deployedUrl);
    if (events[0] !== "session") {
      throw new Error(`expected first SSE event 'session', got '${events[0]}' (all: ${events.join(",")})`);
    }
    if (!events.includes("message")) {
      throw new Error(`expected at least one 'message' event (all: ${events.join(",")})`);
    }
    if (events[events.length - 1] !== "done") {
      throw new Error(`expected the stream to end with 'done' (all: ${events.join(",")})`);
    }
    console.log(`[dev-env-e2e]   SSE events: ${events.join(" → ")}`);

    step(13, TOTAL, "ALL ASSERTIONS PASSED");
    console.log(`[dev-env-e2e] appId=${appId} serverId=${serverId} url=${deployedUrl}`);
  } finally {
    console.log("\n[dev-env-e2e] teardown");
    if (KEEP) {
      console.log("[dev-env-e2e] --keep set — skipping teardown. Clean up manually:");
      console.log(`[dev-env-e2e]   appId=${appId ?? "(none)"}  serverId=${serverId ?? "(none)"}`);
      console.log(`[dev-env-e2e]   workDir=${work}  fakeHome=${fakeHome}`);
      if (appId) {
        console.log(
          `[dev-env-e2e]   guuey undeploy --app-id ${appId} --force && guuey delete ${appId} --force`,
        );
      }
      if (serverId) {
        console.log(
          `[dev-env-e2e]   guuey mcp delete ${serverId} --force --yes --workspace ${workspace}`,
        );
      }
    } else {
      if (appId) {
        try {
          await guuey(["undeploy", "--app-id", appId, "--force"]);
        } catch (err) {
          residue.push(`undeploy app ${appId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
          await guuey(["delete", appId, "--force"]);
        } catch (err) {
          residue.push(`delete app ${appId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (serverId) {
        try {
          await guuey(["mcp", "delete", serverId, "--force", "--yes"]);
        } catch (err) {
          residue.push(`mcp delete ${serverId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        rmSync(work, { recursive: true, force: true });
      } catch (err) {
        residue.push(`rm -rf ${work}: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        rmSync(fakeHome, { recursive: true, force: true });
      } catch (err) {
        residue.push(`rm -rf ${fakeHome}: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (residue.length > 0) {
        console.error("\n[dev-env-e2e] RESIDUE — teardown could not clean up everything:");
        for (const r of residue) console.error(`  - ${r}`);
      } else {
        console.log("[dev-env-e2e] teardown clean — no residue.");
      }
    }
  }
}

main().catch((err) => {
  // Belt-and-braces: run() already redacts its own messages, but ANY error
  // reaching this top-level handler (assertion text embedding captured CLI
  // output, fetch failures, …) gets scrubbed again before printing.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n[dev-env-e2e] FAILED: ${redactSecrets(message, SECRETS)}`);
  if (err instanceof Error && err.stack && process.env.DEBUG) {
    console.error(redactSecrets(err.stack, SECRETS));
  }
  process.exitCode = 1;
});
