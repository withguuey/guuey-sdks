/**
 * `guuey dev --serve` — boot a local, pod-parity SSE server against the
 * project's own worker build (Task 11).
 *
 * Loads `guuey.json`, resolves the worker entry (`guuey.json#worker` when
 * declared, else `<root>/guuey.worker.js`), preflights the framework's LLM
 * key, lowers the agent's `mcpServers` for local dev (`lowerForDev`), and
 * hands off to `startDevServer` (`../dev/dev-server.js`).
 *
 * Without `--serve`, prints the Expo-style QR/bridge "coming soon" note —
 * the bridge-gateway flow (`guuey dev` w/o flags) lands slice 2+.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { loadGuueyJson, buildDeploySnapshot } from '@guuey/config';
import { findProjectConfig } from '../config.js';
import { startDevServer, lowerForDev } from '../dev/dev-server.js';
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
      `guuey.json#agent.entry (graceful mode) currently supports framework google-adk only — ` +
        `"${framework}" needs a full worker (serveNative). Remove agent.entry or switch framework.`,
    );
    process.exit(1);
    return;
  }
  const builtEntry = join(projectRoot, gracefulEntry ?? loaded.doc.worker ?? 'guuey.worker.js');
  if (!existsSync(builtEntry)) {
    out.error(
      `${gracefulEntry !== undefined ? 'Agent entry' : 'Worker entry'} not found at ${builtEntry} — run pnpm build first (or pnpm dev which watches).`,
    );
    process.exit(1);
    return;
  }
  let workerEntry = builtEntry;
  if (gracefulEntry !== undefined) {
    // Production topology, locally: node <@guuey/host> with the entry env.
    const require = createRequire(import.meta.url);
    workerEntry = require.resolve('@guuey/host');
    process.env.GUUEY_AGENT_ENTRY = gracefulEntry;
    process.env.GUUEY_WORKER_ROOT = projectRoot;
  }

  // Lowered snapshot: the deploy-shaped agent section (systemPrompt resolved
  // inline via `resolvedSystemPrompt` — the worker needn't re-read the file)
  // run through `lowerForDev` (hosted/external+devPort → localhost, default
  // ggui injected).
  const agent = lowerForDev(buildDeploySnapshot(loaded).agent);
  const agentSnapshotJson = JSON.stringify(agent);

  // Graceful mode: the CLI is also the LOCAL credential broker — the host
  // sources MCP exclusively from cred files (production contract), which
  // nothing else writes locally.
  const localCredentials =
    gracefulEntry !== undefined
      ? Object.fromEntries(
          Object.entries(agent.mcpServers ?? {}).flatMap(([name, s]) =>
            s.kind === 'external' && typeof s.url === 'string'
              ? [[name, { url: s.url, transport: s.transport ?? 'http' }]]
              : [],
          ),
        )
      : undefined;

  const srv = await startDevServer({
    port,
    framework,
    protocol: loaded.doc.protocol,
    workerCommand: process.execPath,
    workerArgs: [workerEntry],
    agentSnapshotJson,
    projectRoot,
    ...(localCredentials !== undefined ? { localCredentials } : {}),
  });

  console.log(`\nguuey dev server listening on http://localhost:${srv.port}`);
  console.log(`  POST /agent/invoke   (SSE stream)`);
  console.log(`  GET  /healthz\n`);
  console.log('Example:');
  console.log(
    `  curl -N -X POST http://localhost:${srv.port}/agent/invoke \\\n` +
      `    -H 'Content-Type: application/json' \\\n` +
      `    -d '{"input":"hello"}'\n`,
  );

  const shutdown = (): void => {
    void srv.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
