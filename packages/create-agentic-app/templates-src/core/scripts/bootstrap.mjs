#!/usr/bin/env node
/**
 * pnpm bootstrap — configure this app. Two phases, deliberately split:
 *
 *   pnpm bootstrap                 local only, no account: brand, theme,
 *                                  copy → guuey.app.json + AGENTS.md
 *   pnpm bootstrap -- --link       bind an EXISTING guuey app (creation
 *                                  stays `guuey apps create` — the moment
 *                                  billing/trial starts remains explicit)
 *
 * Contract: converging + idempotent (re-run any time), `--check` prints
 * machine-readable JSON of what's configured and what's missing, `--yes`
 * is fully non-interactive, secrets are NEVER printed (paths only), and
 * every platform mutation goes through a `guuey` CLI primitive — this
 * script is a thin orchestrator, not a second platform client.
 *
 * Flags:
 *   --yes                 accept defaults for every prompt
 *   --check               report state as JSON and exit (0 = every required
 *                         step done, 3 = a required step missing; optional
 *                         steps are listed but never fail; never mutates)
 *   --link                run the bind phase (implies the local phase ran)
 *   --app-id <id>         the app to bind (default: guuey.json's appId,
 *                         else prompted)
 *   --env <e>             dev|staging|release when it cannot be derived
 *   --domains <d1,d2>     allowed origins to push on --link (prompted when
 *                         interactive; skipped under --yes without the flag)
 *   --name/--tagline/--accent/--mode/--headline   local-phase overrides
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(projectRoot, "guuey.app.json");
const AGENTS_PATH = join(projectRoot, "AGENTS.md");
const CLAUDE_PATH = join(projectRoot, "CLAUDE.md");
const GUUEY_JSON_PATH = join(projectRoot, "guuey.json");

const START_MARK = "<!-- guuey:bootstrap:start -->";
const END_MARK = "<!-- guuey:bootstrap:end -->";

// Per-env public hosts. Two distinct "agents" domain families exist and must
// not be confused: SLUG pages live at <slug>.agents.guuey.com (prod) /
// <slug>.agents.<env>.sandbox.guuey.com — always read back from the platform
// as pageUrl, never derived here — while canonical appId ENDPOINTS live at
// <appId>.agents.us-east-1.guuey.com (prod) / <appId>.agents.<env>.sandbox
// .guuey.com. `endpointDomain` below is the ENDPOINT family, used only as
// the fallback when the app has no live deployment to read the URL from.
const ENV_HOSTS = {
  release: {
    apiBaseUrl: "https://api.us-east-1.guuey.com/v1",
    widgetOrigin: "https://widget.guuey.com",
    portalUrl: "https://app.guuey.com",
    endpointDomain: "agents.us-east-1.guuey.com",
  },
  staging: {
    apiBaseUrl: "https://api.staging.sandbox.guuey.com/v1",
    widgetOrigin: "https://staging.widget.sandbox.guuey.com",
    portalUrl: "https://staging.app.sandbox.guuey.com",
    endpointDomain: "agents.staging.sandbox.guuey.com",
  },
  dev: {
    apiBaseUrl: "https://api.dev.sandbox.guuey.com/v1",
    widgetOrigin: "https://dev.widget.sandbox.guuey.com",
    portalUrl: "https://dev.app.sandbox.guuey.com",
    endpointDomain: "agents.dev.sandbox.guuey.com",
  },
};

// ── plumbing ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function writeConfig(config) {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function ask(rl, question, fallback, yes) {
  if (yes) return fallback;
  const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
  return answer || fallback;
}

/** Run a `guuey` CLI command; the CLI's own stderr passes through on failure. */
async function guuey(args) {
  try {
    const { stdout: out } = await execFileAsync("pnpm", ["exec", "guuey", ...args], {
      cwd: projectRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: out };
  } catch (err) {
    const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
    const out = typeof err?.stdout === "string" ? err.stdout.trim() : "";
    return { ok: false, stdout: out, error: stderr || out || String(err) };
  }
}

// ── ggui.json theme sync (guuey#302 scaffold hygiene) ───────────────────────

/**
 * Keep `ggui/ggui.json`'s theme MODE in step with guuey.app.json so the
 * local `ggui serve` preview matches the site (the scaffold used to ship
 * the two contradicting each other: light site, dark ggui preview). Only
 * `mode` syncs — `preset` is ggui-side vocabulary and stays the author's
 * choice. NOTE: the deployed render's theme is platform data (`guuey
 * deploy` deliberately ignores this block; guuey#304 owns the production
 * side) — this sync is about local-preview honesty.
 */
function syncGguiTheme(config) {
  const gguiJsonPath = join(projectRoot, "ggui", "ggui.json");
  if (!existsSync(gguiJsonPath)) return;
  const ggui = JSON.parse(readFileSync(gguiJsonPath, "utf8"));
  if (ggui.theme?.mode === config.theme.mode) return;
  ggui.theme = { ...(ggui.theme ?? {}), mode: config.theme.mode };
  writeFileSync(gguiJsonPath, `${JSON.stringify(ggui, null, 2)}\n`, "utf8");
  console.log(`ggui/ggui.json theme mode → ${config.theme.mode} (local preview matches the site).`);
}

// ── AGENTS.md managed block ─────────────────────────────────────────────────

function managedBlock(config) {
  const link = config.link;
  // The agent's shape steers the guidance: a declarative agent (an
  // `--example` extraction, or a Studio pull) has NO worker build — its
  // whole definition is guuey.json + the system prompt.
  const guueyJson = existsSync(GUUEY_JSON_PATH)
    ? JSON.parse(readFileSync(GUUEY_JSON_PATH, "utf8"))
    : {};
  const declarative = guueyJson?.agent?.mode === "declarative";
  const lines = [
    START_MARK,
    "## This project (generated by `pnpm bootstrap` — edit outside the markers)",
    "",
    `- **App**: ${config.brand.name} — ${config.brand.tagline}`,
    declarative
      ? "- **Agent shape**: DECLARATIVE — the agent is entirely `guuey.json` + `prompts/`; there is no worker build and no `src/` agent code. Change behavior by editing the system prompt / mcpServers, then `guuey deploy`."
      : "- **Agent shape**: code-mode — the agent entry under `src/` builds to the deployable worker (`pnpm build`).",
    link
      ? `- **Bound guuey app**: \`${link.appId}\` (${link.env}). NEVER hand-edit this id — re-run \`pnpm bootstrap -- --link\` to rebind.`
      : "- **Bound guuey app**: none yet — `pnpm bootstrap -- --link` binds one (create first with `guuey apps create --name ...`).",
    link ? `- **Agent endpoint**: ${link.endpointUrl}` : "- **Agent endpoint (local dev)**: http://localhost:6790 via `pnpm dev`",
    link && link.pageUrl ? `- **Agent's own page**: ${link.pageUrl}` : null,
    "- **Commands**: `pnpm dev` (local stack) · `pnpm bootstrap` (reconfigure) · `pnpm status` (live app state) · `guuey deploy` (ship the agent)",
    "- **Config**: `guuey.app.json` (frontend/brand — schema in `guuey.app.schema.json`) and `guuey.json` (the agent definition). Secrets live in `.env.local`, never in either file.",
    "- **Frontend**: `web/` — Vite + React on `@guuey/chat`; identity is guest-secret or BYO-OIDC, never both on one surface.",
    END_MARK,
  ].filter((line) => line !== null);
  return lines.join("\n");
}

function regenerateAgentsMd(config) {
  const block = managedBlock(config);
  let content = existsSync(AGENTS_PATH) ? readFileSync(AGENTS_PATH, "utf8") : "# AGENTS.md\n";
  const start = content.indexOf(START_MARK);
  const end = content.indexOf(END_MARK);
  if (start !== -1 && end !== -1 && end > start) {
    content = content.slice(0, start) + block + content.slice(end + END_MARK.length);
  } else {
    // Insert after the H1 (first line), before everything else.
    const nl = content.indexOf("\n");
    const head = nl === -1 ? content : content.slice(0, nl + 1);
    const rest = nl === -1 ? "" : content.slice(nl + 1);
    content = `${head}\n${block}\n${rest}`;
  }
  writeFileSync(AGENTS_PATH, content, "utf8");

  if (!existsSync(CLAUDE_PATH)) {
    writeFileSync(
      CLAUDE_PATH,
      "# CLAUDE.md\n\nSee [AGENTS.md](./AGENTS.md) — the single source of agent guidance for this repo.\n",
      "utf8",
    );
  }
}

// ── link-phase helpers ──────────────────────────────────────────────────────

function deriveEnv(app) {
  const hosts = [app.pageUrl, app.endpointUrl].filter(Boolean).join(" ");
  if (/\.agents\.guuey\.com|agents\.us-east-1\.guuey\.com/.test(hosts)) return "release";
  const m = /\.agents\.(dev|staging)\.sandbox\.guuey\.com/.exec(hosts);
  return m ? m[1] : null;
}

async function linkPhase(config, flags, yes) {
  const guueyJson = existsSync(GUUEY_JSON_PATH) ? JSON.parse(readFileSync(GUUEY_JSON_PATH, "utf8")) : {};
  let appId = typeof flags["app-id"] === "string" ? flags["app-id"] : guueyJson.appId;
  if (!appId && !yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    appId = (await rl.question("App id to bind (guuey apps list): ")).trim();
    rl.close();
  }
  if (!appId) {
    console.error("--link needs an app id: pass --app-id <id> (create one with `guuey apps create --name ...`).");
    process.exit(1);
  }

  const res = await guuey(["apps", "get", appId, "--json"]);
  if (!res.ok) {
    console.error(`Could not read app ${appId} via the guuey CLI:\n${res.error}`);
    console.error("Log in first (`guuey login`) and check the id (`guuey apps list`).");
    process.exit(1);
  }
  let app;
  try {
    app = JSON.parse(res.stdout);
  } catch {
    console.error(
      "`guuey apps get --json` did not return parseable JSON. Raw output follows — " +
        "if extra lines surround the JSON, that is a guuey CLI bug worth reporting:\n" +
        res.stdout,
    );
    process.exit(1);
  }

  const env = typeof flags.env === "string" ? flags.env : deriveEnv(app);
  if (!env || !ENV_HOSTS[env]) {
    console.error(
      "Could not derive the environment from the app record (no page/endpoint yet). Pass --env dev|staging|release.",
    );
    process.exit(1);
  }
  const hosts = ENV_HOSTS[env];

  // The platform's deployment records carry the full `…/agent/invoke` URL;
  // the config contract stores the ORIGIN (the web app appends paths).
  const endpointOrigin = (app.endpointUrl || `https://${appId}.${hosts.endpointDomain}`).replace(
    /\/agent\/invoke\/?$/,
    "",
  );

  config.link = {
    appId,
    env,
    apiBaseUrl: hosts.apiBaseUrl,
    endpointUrl: endpointOrigin,
    widgetOrigin: hosts.widgetOrigin,
    portalUrl: hosts.portalUrl,
    slug: app.urlSlug ?? null,
    pageUrl: app.pageUrl ?? null,
  };
  writeConfig(config);
  console.log(`Linked ${config.brand.name} → ${appId} (${env}).`);

  // Allowed domains: the origins this frontend will serve from (needed for
  // the widget's frame-ancestors AND the pod's CORS). Flag wins; prompted
  // when interactive; skipped (with the hint below) under --yes.
  let domains = typeof flags.domains === "string" ? flags.domains : null;
  if (domains === null && !yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    domains = (
      await rl.question("Allowed origins for this frontend (comma-separated, empty to skip): ")
    ).trim();
    rl.close();
  }

  // Platform pushes — each one a CLI primitive; failures are reported, not
  // hidden, and the run keeps converging on the rest.
  const pushes = [];
  if (domains) {
    pushes.push({
      step: "allowed-domains",
      result: await guuey(["apps", "update", appId, "--domains", domains]),
    });
  }
  pushes.push({
    step: "brand-accent",
    result: await guuey(["apps", "update", appId, "--brand-accent", config.theme.accent]),
  });
  // Theme-as-platform-data push rides `guuey apps update --chat-theme-file`
  // (filed as a platform CLI ask). Until that flag exists this step is
  // reported as skipped — never silently omitted, never worked around here.
  pushes.push({ step: "chat-theme", result: { ok: false, error: "skipped: needs `guuey apps update --chat-theme-file` (guuey#283)" } });

  for (const { step, result } of pushes) {
    if (result.ok) console.log(`  ✓ ${step}`);
    else console.log(`  – ${step}: ${result.error}`);
  }

  console.log("\nNext steps (each is one command — run when ready):");
  if (!domains) {
    console.log(`  guuey apps update ${appId} --domains <https://your-site.example>   # allow this frontend's origin`);
  }
  if (!config.link.slug) console.log("  guuey slug claim <name>            # public short name → portal link + hosted page");
  console.log("  guuey deploy                        # ship the agent definition in guuey.json");
  if (config.auth.oidc) {
    console.log(`  guuey apps update ${appId} --auth-mode byo --issuer-url ${config.auth.oidc.issuer} --audience ${config.auth.oidc.clientId}`);
  }
}

// ── check ───────────────────────────────────────────────────────────────────

function check(config) {
  // Required steps gate the exit code; optional ones are informational.
  const missing = [];
  const optional = [];
  if (!config.bootstrapped) missing.push({ step: "bootstrap", fix: "pnpm bootstrap" });
  if (!config.link) missing.push({ step: "link", fix: "pnpm bootstrap -- --link --app-id <id>" });
  if (config.link && !config.link.slug)
    optional.push({ step: "slug", fix: "guuey slug claim <name> (portal link + hosted page)" });
  if (!config.auth.oidc)
    optional.push({ step: "oidc", fix: "set auth.oidc {issuer, clientId} for sign-in (guest works without it)" });
  const report = {
    bootstrapped: config.bootstrapped,
    linked: config.link !== null,
    appId: config.link?.appId ?? null,
    env: config.link?.env ?? null,
    oidcConfigured: config.auth.oidc !== null,
    demoMode: config.demoMode,
    missing,
    optional,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(missing.length > 0 ? 3 : 0);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const yes = flags.yes === true;
  const config = readConfig();

  if (flags.check === true) return check(config);

  if (flags.link === true) {
    if (!config.bootstrapped) {
      console.error("Run the local phase first: pnpm bootstrap");
      process.exit(1);
    }
    await linkPhase(config, flags, yes);
    regenerateAgentsMd(config);
    return;
  }

  // Local phase — no account, no network.
  const rl = yes ? null : createInterface({ input: stdin, output: stdout });
  const name = typeof flags.name === "string" ? flags.name : await ask(rl, "App name", config.brand.name, yes);
  const tagline = typeof flags.tagline === "string" ? flags.tagline : await ask(rl, "Tagline", config.brand.tagline, yes);
  const accent = typeof flags.accent === "string" ? flags.accent : await ask(rl, "Accent color (#rrggbb)", config.theme.accent, yes);
  const mode = typeof flags.mode === "string" ? flags.mode : await ask(rl, "Theme mode (light|dark)", config.theme.mode, yes);
  const headline = typeof flags.headline === "string" ? flags.headline : await ask(rl, "Landing headline", config.copy.landing.headline, yes);
  rl?.close();

  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) {
    console.error(`Accent must be #rrggbb (got "${accent}").`);
    process.exit(1);
  }
  if (mode !== "light" && mode !== "dark") {
    console.error(`Theme mode must be light or dark (got "${mode}").`);
    process.exit(1);
  }

  config.brand.name = name;
  config.brand.tagline = tagline;
  config.brand.logoText = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "AA";
  config.theme.accent = accent;
  config.theme.mode = mode;
  config.copy.landing.headline = headline;
  config.bootstrapped = true;
  // A bootstrap makes the app YOURS — if this started life as a demo
  // extraction (`--example`), the demo chrome turns off here.
  config.demoMode = false;
  writeConfig(config);
  syncGguiTheme(config);
  regenerateAgentsMd(config);

  console.log(`\nConfigured "${name}" — guuey.app.json written, AGENTS.md updated.`);
  console.log("Next: pnpm dev (local stack) · pnpm bootstrap -- --link (bind a deployed app)");
}

await main();
