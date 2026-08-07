/**
 * `guuey dev --serve` — boot a local, pod-parity SSE server against the
 * project's own worker build (Task 11).
 *
 * Loads `guuey.json`, resolves the boot mode — `#worker` (or a default
 * build) → full-worker; `#agent.entry` → entry-graceful host (google-adk);
 * neither, on a snapshot-driven framework (claude-agent-sdk /
 * openai-agents-sdk) → snapshot-only host boot, zero agent code (guuey#111)
 * — preflights the framework's LLM key, lowers the agent's `mcpServers`
 * for local dev (`lowerForDev`), and hands off to `startDevServer`
 * (`../dev/dev-server.js`).
 *
 * Without `--serve`, prints the Expo-style QR/bridge "coming soon" note —
 * the bridge-gateway flow (`guuey dev` w/o flags) lands slice 2+.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { loadGuueyJson, buildDeploySnapshot, declaredServerEntries } from '@guuey/config';
import { findProjectConfig } from '../config.js';
import { startDevServer, lowerForDev } from '../dev/dev-server.js';
import { spawnColocatedDev, type ColocatedDevEntry } from '../dev/colocated-dev.js';
import * as out from '../output.js';

const DEFAULT_PORT = 6790;

/** Frameworks `guuey dev --serve` can run locally (v1). */
const SUPPORTED_FRAMEWORKS = ['claude-agent-sdk', 'openai-agents-sdk', 'google-adk'] as const;
type SupportedFramework = (typeof SUPPORTED_FRAMEWORKS)[number];

function isSupportedFramework(v: string): v is SupportedFramework {
  return (SUPPORTED_FRAMEWORKS as readonly string[]).includes(v);
}

/** The env var each supported framework's LLM key rides on. */
const KEY_ENV_VAR: Record<SupportedFramework, string> = {
  'claude-agent-sdk': 'ANTHROPIC_API_KEY',
  'openai-agents-sdk': 'OPENAI_API_KEY',
  'google-adk': 'GEMINI_API_KEY',
};

/**
 * Minimal `.env.local` parser — `KEY=VALUE` lines, `#` comments, blank lines
 * skipped, optional matching quotes stripped. Not a general dotenv
 * implementation (no multiline values, no `${VAR}` interpolation) — the
 * scaffolded `.env.example` templates only ever need flat key=value pairs.
 */
function parseEnvLocal(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * Snapshot-only host boot decision (guuey#111): for frameworks whose host
 * runner is snapshot-driven (claude-agent-sdk / openai-agents-sdk —
 * `agentEntry: false` in @guuey/host's framework registry), a project with
 * no `#worker`, no `#agent.entry`, and no default worker build boots the
 * SAME universal host a production pod runs, from `GUUEY_AGENT_SNAPSHOT`
 * alone — zero agent code, zero build step. A declared worker, or a build
 * present at the default path, still wins (the builder wrote it; never
 * silently ignore it). google-adk stays entry/worker-driven — its runner
 * LOADS the agent module.
 */
export function isSnapshotOnlyBoot(input: {
  worker: string | undefined;
  agentEntry: string | undefined;
  framework: string;
  defaultWorkerBuildExists: boolean;
}): boolean {
  return (
    input.worker === undefined &&
    input.agentEntry === undefined &&
    input.framework !== 'google-adk' &&
    !input.defaultWorkerBuildExists
  );
}

function printComingSoon(): void {
  out.error(
    'guuey dev is being rebuilt as an Expo-style bridge + QR flow (slice 2+).\n' +
      '  Today, run the pod-parity local SSE server with:\n' +
      '    guuey dev --serve [--port 6790]\n' +
      '  In the meantime for the bridge flow, deploy with `guuey deploy` and\n' +
      '  iterate against the live endpoint at https://platform.guuey.com.',
  );
}

export async function dev(flags?: Record<string, string | true>): Promise<void> {
  if (flags?.serve !== true) {
    printComingSoon();
    process.exit(1);
    return;
  }

  const portFlag = flags.port;
  const port = typeof portFlag === 'string' ? Number(portFlag) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    out.error(`--port must be a valid port number (got "${String(portFlag)}").`);
    process.exit(1);
    return;
  }

  const configPath = findProjectConfig();
  if (!configPath) {
    out.error(
      'No guuey.json found in this directory or its parents. Run this from a guuey project (see `guuey create`).',
    );
    process.exit(1);
    return;
  }
  const projectRoot = dirname(configPath);

  let loaded;
  try {
    loaded = loadGuueyJson(configPath);
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  const framework = loaded.doc.agent.framework ?? 'claude-agent-sdk';
  if (!isSupportedFramework(framework)) {
    out.error(
      `guuey dev --serve only supports framework: ${SUPPORTED_FRAMEWORKS.join(' | ')} (guuey.json#agent.framework is "${framework}").`,
    );
    process.exit(1);
    return;
  }

  // Key preflight — env wins, .env.local is the fallback (mirrors the
  // scaffolded template's own GUUEY_AGENT_SNAPSHOT-vs-.env.local convention).
  const requiredKey = KEY_ENV_VAR[framework];
  let haveKey = typeof process.env[requiredKey] === 'string' && process.env[requiredKey] !== '';
  const envLocalPath = join(projectRoot, '.env.local');
  if (!haveKey && existsSync(envLocalPath)) {
    const parsed = parseEnvLocal(envLocalPath);
    if (parsed[requiredKey]) {
      process.env[requiredKey] = parsed[requiredKey];
      haveKey = true;
    }
  }
  if (!haveKey) {
    out.error(
      `Missing ${requiredKey} — set it in your shell environment or in .env.local at the project root.`,
    );
    process.exit(1);
    return;
  }

  // Graceful mode: guuey.json#agent.entry (no #worker) — the CLI spawns the
  // SAME universal host that runs the agent in production, pointed at the
  // built agent module (GUUEY_AGENT_ENTRY, contained under the project root).
  // Full-worker mode otherwise: `guuey.json#worker` (the template-authored
  // override for a non-default build output path) when declared, else the
  // default build output. Mirrors `deploy.ts`'s entry resolution.
  const gracefulEntry = loaded.doc.worker === undefined ? loaded.doc.agent.entry : undefined;
  if (gracefulEntry !== undefined && framework !== 'google-adk') {
    out.error(
      `guuey.json#agent.entry (graceful mode) supports framework google-adk only — ` +
        `"${framework}" agents are snapshot-only (the host ignores an agent entry). ` +
        `Remove agent.entry: with no #worker either, guuey dev --serve boots @guuey/host ` +
        `from guuey.json directly, no build step.`,
    );
    process.exit(1);
    return;
  }
  const builtEntry = join(projectRoot, gracefulEntry ?? loaded.doc.worker ?? 'guuey.worker.js');
  const snapshotOnly = isSnapshotOnlyBoot({
    worker: loaded.doc.worker,
    agentEntry: loaded.doc.agent.entry,
    framework,
    defaultWorkerBuildExists: existsSync(builtEntry),
  });
  if (!snapshotOnly && !existsSync(builtEntry)) {
    out.error(
      `${gracefulEntry !== undefined ? 'Agent entry' : 'Worker entry'} not found at ${builtEntry} — run pnpm build first (or pnpm dev which watches).`,
    );
    process.exit(1);
    return;
  }
  const hostMode = gracefulEntry !== undefined || snapshotOnly;
  let workerEntry = builtEntry;
  if (hostMode) {
    // Production topology, locally: node <@guuey/host>. Entry-graceful mode
    // (google-adk) additionally points the host at the built agent module.
    const require = createRequire(import.meta.url);
    workerEntry = require.resolve('@guuey/host');
    if (gracefulEntry !== undefined) process.env.GUUEY_AGENT_ENTRY = gracefulEntry;
    process.env.GUUEY_WORKER_ROOT = projectRoot;
  }

  // Auto-spawn colocated dev-loop parity (Task 7): the deploy-shaped
  // snapshot (pre-lowering) still carries every `colocated` entry's
  // `source`/`devPort` — spawn each one's own dev server BEFORE the dev
  // server starts, so `lowerForDev`'s localhost URLs are dialable from the
  // first invoke.
  const snapshotAgent = buildDeploySnapshot(loaded).agent;
  const colocatedEntries: ColocatedDevEntry[] = [];
  // `declaredServerEntries` filters the `ggui: false` opt-out (guuey#24) — not a
  // server, so there is never a dev child to spawn for it.
  for (const [name, entry] of declaredServerEntries(snapshotAgent.mcpServers)) {
    if (entry.kind === 'colocated' && entry.devPort !== undefined) {
      colocatedEntries.push({ name, source: entry.source, devPort: entry.devPort });
    }
  }
  const colocatedDev = spawnColocatedDev(colocatedEntries, projectRoot);

  // Lowered snapshot: run through `lowerForDev` (hosted/external+devPort →
  // localhost, colocated+devPort → localhost + tracked in `colocatedNames`,
  // default ggui injected).
  const { agent, colocatedNames } = lowerForDev(snapshotAgent);
  const agentSnapshotJson = JSON.stringify(agent);

  // Host modes (entry-graceful AND snapshot-only): the CLI is also the LOCAL
  // credential broker — the host sources MCP exclusively from cred files
  // (production contract), which nothing else writes locally.
  const localCredentials =
    hostMode
      ? Object.fromEntries(
          declaredServerEntries(agent.mcpServers).flatMap(([name, s]) =>
            s.kind === 'external' && typeof s.url === 'string'
              ? [[name, { url: s.url, transport: s.transport ?? 'http' }]]
              : [],
          ),
        )
      : undefined;

  // Dev-identity: which of those `localCredentials` servers are
  // colocated-derived (see `lowerForDev`'s `colocatedNames`), plus the
  // `colocatedResourceUrl` appId segment — `guuey.json#appId` if this
  // project has been through `guuey create`/`guuey pull --app-id`, else the
  // literal `'local'`.
  const devAppId = loaded.doc.appId ?? 'local';
  const devIdentity = hostMode ? { colocatedNames, devAppId } : undefined;

  const srv = await startDevServer({
    port,
    framework,
    protocol: loaded.doc.protocol,
    workerCommand: process.execPath,
    workerArgs: [workerEntry],
    agentSnapshotJson,
    projectRoot,
    ...(localCredentials !== undefined ? { localCredentials } : {}),
    ...(devIdentity !== undefined ? { devIdentity } : {}),
  });

  if (snapshotOnly) {
    console.log(
      `\nSnapshot-only mode: no worker build found — booting @guuey/host straight from guuey.json (production topology).`,
    );
  }
  console.log(`\nguuey dev server listening on http://localhost:${srv.port}`);
  console.log(`  POST /agent/invoke              (SSE stream)`);
  console.log(`  GET  /threads/:id/messages      (in-memory history, read-plane shape)`);
  console.log(`  GET  /healthz\n`);
  console.log('Example:');
  console.log(
    `  curl -N -X POST http://localhost:${srv.port}/agent/invoke \\\n` +
      `    -H 'Content-Type: application/json' \\\n` +
      `    -d '{"input":"hello"}'\n`,
  );

  const shutdown = (): void => {
    colocatedDev.stop();
    void srv.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
