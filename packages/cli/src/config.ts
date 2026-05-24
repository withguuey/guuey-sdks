import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  GUUEY_JSON_FILENAME,
  type GuueyJsonV1,
  parseGuueyJson,
  safeParseGuueyJson,
} from '@guuey/config';
import { getConfigDir, getGlobalConfigFile } from './paths';

// ─── Global config (~/.guuey/config.json) ────────────────────────────

/**
 * Global CLI configuration stored in `~/.guuey/config.json`.
 * Contains user-level defaults and secrets (API key).
 *
 * Note: `bridgeUrl` is intentionally omitted — it is project-specific
 * and belongs in `guuey.json`, not global config.
 */
export interface CliConfig {
  /** Platform host URL (e.g., `https://platform.guuey.com`) */
  host?: string;
  /** API key for authentication (starts with `ggui_sk_`) */
  apiKey?: string;
  /** Default app ID to use when no project config is present */
  appId?: string;
}

/** Default platform endpoint — used when no endpoint is configured */
export const DEFAULT_ENDPOINT = 'https://platform.guuey.com';

/** Default WebSocket URL for end-user session events (API Gateway WS). */
export const DEFAULT_WS_URL = 'wss://ws.guuey.com/v1';

/**
 * Default WebSocket URL for the dev-link bridge (`guuey dev` CLI ↔ pod).
 * Path B: replaces the old API Gateway WS at `wss://ws.guuey.com/v1` with
 * the EKS bridge-gateway pod's Ingress.
 */
export const DEFAULT_BRIDGE_URL = 'wss://mcp.guuey.com/bridge-ws';

/** Default MCP endpoint URL */
export const DEFAULT_MCP_URL = 'https://mcp.guuey.com/v1';

/** Override config file path via --config flag. Set from CLI entry point. */
let configFileOverride: string | null = null;

/** Set a custom config file path (from --config CLI flag). */
export function setConfigFile(path: string): void {
  configFileOverride = path;
}

/** Get the active config file path. */
function getConfigFile(): string {
  return configFileOverride ?? getGlobalConfigFile();
}

function ensureDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load the global CLI configuration.
 * Uses --config override if set, otherwise ~/.guuey/config.json.
 *
 * @returns Parsed config, or an empty object if the file does not exist
 */
export function loadConfig(): CliConfig {
  const file = getConfigFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Persist the global CLI configuration to `~/.guuey/config.json`.
 * Creates the `~/.guuey` directory if it does not exist.
 *
 * @param config - Configuration to save
 */
export function saveConfig(config: CliConfig): void {
  ensureDir();
  writeFileSync(getConfigFile(), JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600, // Owner read/write only — file contains API keys
  });
}

/** Get the absolute path to the active config file. */
export function getConfigPath(): string {
  return getConfigFile();
}

// ─── Project config (guuey.json) ─────────────────────────────────────

/**
 * Project config for the closed `guuey` CLI. This is the Guuey
 * hosted overlay (`guuey.json`) — its schema is owned by
 * `@guuey/config`. The CLI deliberately re-exports
 * the canonical type rather than carrying its own parallel shape
 * (the legacy parallel interface was deleted 2026-04-21 as part of
 * the CLI writer migration). See
 * `docs/plans/2026-04-17-ggui-oss-split.md` §8 and
 * `docs/plans/2026-04-20-guuey-pull-migration-question.md`.
 *
 * Local-dev URL overrides (`GUUEY_HOST`, `GUUEY_BRIDGE_URL`,
 * `GUUEY_WS_URL`, `GUUEY_RENDER_URL`) are NO LONGER stored in
 * `guuey.json` — they live in `.env` only per §8.4. `guuey create`
 * writes them to `.env` on project creation when a sandbox
 * `amplify_outputs.json` surfaces them.
 */
export type ProjectConfig = GuueyJsonV1;

/** Find `guuey.json` in current directory or parents (up to 5 levels). */
export function findProjectConfig(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const filePath = join(dir, GUUEY_JSON_FILENAME);
    if (existsSync(filePath)) return filePath;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load and validate the project-level `guuey.json` overlay.
 * Searches the current directory and up to 5 parent directories.
 *
 * Returns `null` if no file is found OR if the file fails canonical
 * schema validation. Callers that care about the distinction should
 * use {@link getProjectConfigPath} + {@link safeParseGuueyJson}
 * directly.
 */
export function loadProjectConfig(): ProjectConfig | null {
  const filePath = findProjectConfig();
  if (!filePath) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    const result = safeParseGuueyJson(raw);
    if (!result.success) return null;
    return result.data;
  } catch {
    return null;
  }
}

/**
 * Write a project configuration to a `guuey.json` file. Validates
 * against the canonical `GuueyJsonV1` schema before writing — throws
 * `ZodError` on invalid input so callers can't silently ship a
 * malformed overlay.
 *
 * @param config - Canonical overlay to serialize
 * @param filePath - Target path (defaults to `./guuey.json` in CWD)
 */
export function saveProjectConfig(
  config: GuueyJsonV1,
  filePath?: string,
): void {
  const target = filePath ?? join(process.cwd(), GUUEY_JSON_FILENAME);
  const validated = parseGuueyJson(config);
  writeFileSync(target, JSON.stringify(validated, null, 2) + '\n', 'utf-8');
}

/** Get the path to the nearest `guuey.json` file, or `null` if none exists. */
export function getProjectConfigPath(): string | null {
  return findProjectConfig();
}

// ─── Environment Outputs (sandbox/deployed environment URLs) ────────

/**
 * Subset of environment outputs we care about.
 * Contains deployment-specific URLs for sandbox/dev/staging/prod.
 */
export interface AmplifyOutputs {
  websocketUrl?: string;
  renderUrl?: string;
  bridgeWebSocketUrl?: string;
  appConfigUrl?: string;
  mcpUrl?: string;
  apiUrl?: string;
  platformUrl?: string;
  portalUrl?: string;
  mcpProxyUrl?: string;
}

let _amplifyOutputsCache: AmplifyOutputs | null = null;

/**
 * Load amplify_outputs.json from known locations.
 * Search order: cwd, backend/amplify_outputs.json, up to 3 parents.
 * Returns empty object if not found (common for external developers).
 */
export function loadAmplifyOutputs(): AmplifyOutputs {
  if (_amplifyOutputsCache) return _amplifyOutputsCache;

  const searchPaths = [
    join(process.cwd(), 'amplify_outputs.json'),
    join(process.cwd(), 'cloud', 'amplify_outputs.json'),
  ];

  // Walk up to 3 parent directories
  let dir = process.cwd();
  for (let i = 0; i < 3; i++) {
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
    searchPaths.push(join(dir, 'amplify_outputs.json'));
    searchPaths.push(join(dir, 'cloud', 'amplify_outputs.json'));
  }

  for (const filePath of searchPaths) {
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
        const custom = raw?.custom ?? {};
        _amplifyOutputsCache = {
          websocketUrl: custom.websocketUrl,
          renderUrl: custom.renderUrl,
          bridgeWebSocketUrl: custom.bridgeWebSocketUrl,
          appConfigUrl: custom.appConfigUrl,
          mcpUrl: custom.mcpUrl,
          apiUrl: custom.cliApiUrl ?? custom.apiUrl,
          platformUrl: custom.platformUrl,
          portalUrl: custom.portalUrl,
          mcpProxyUrl: custom.mcpProxyUrl,
        };
        return _amplifyOutputsCache;
      } catch {
        // Malformed file — skip
      }
    }
  }

  _amplifyOutputsCache = {};
  return _amplifyOutputsCache;
}

// ─── Resolved config (env > guuey.json > amplify_outputs > ~/.guuey/config.json) ──

/**
 * Fully resolved configuration with all layers merged.
 *
 * Priority: env vars > guuey.json > amplify_outputs.json > ~/.guuey/config.json > defaults
 *
 * Note: `apiKey` never comes from `guuey.json` (secrets stay in `.env`
 * or `~/.guuey/config.json`).
 */
export interface ResolvedConfig {
  host: string;
  apiKey?: string;
  appId?: string;
  bridgeUrl?: string;
  /** Platform WebSocket URL (for session events) */
  wsUrl?: string;
  /** Render endpoint base URL (for short code URLs) */
  renderUrl?: string;
  /** App config API URL */
  appConfigUrl?: string;
  /** MCP endpoint URL */
  mcpUrl?: string;
  /** REST API endpoint URL (for BYOK etc.) */
  apiUrl?: string;
  /** Platform app URL (e.g., https://platform.guuey.com) */
  platformUrl?: string;
  /** Portal app URL (e.g., https://app.guuey.com) */
  portalUrl?: string;
  /** MCP proxy URL (e.g., https://mcp-proxy.guuey.com) */
  mcpProxyUrl?: string;
}

/**
 * Resolve config with priority:
 *   env vars > amplify_outputs.json > ~/.guuey/config.json > defaults
 *
 * Local-dev URL overrides (`GUUEY_HOST`, `GUUEY_BRIDGE_URL`,
 * `GUUEY_WS_URL`, `GUUEY_RENDER_URL`) are `.env`-only — they no longer
 * fall back through `guuey.json` per §8.4 (the overlay is hosted
 * state, not a URL-pinning surface). `appId` still comes from the
 * canonical overlay's `project.id` when present, since that IS
 * hosted identity.
 */
export function resolveConfig(): ResolvedConfig {
  const global = loadConfig();
  const project = loadProjectConfig();
  const amplify = loadAmplifyOutputs();

  return {
    host: process.env.GUUEY_HOST ?? global.host ?? DEFAULT_ENDPOINT,
    apiKey: process.env.GUUEY_API_KEY ?? global.apiKey,
    appId: process.env.GGUI_APP_ID ?? project?.project?.id ?? global.appId,
    bridgeUrl:
      process.env.GUUEY_BRIDGE_URL ??
      amplify.bridgeWebSocketUrl ??
      DEFAULT_BRIDGE_URL,
    wsUrl:
      process.env.GUUEY_WS_URL ?? amplify.websocketUrl ?? DEFAULT_WS_URL,
    renderUrl: process.env.GUUEY_RENDER_URL ?? amplify.renderUrl,
    appConfigUrl: process.env.GGUI_APP_CONFIG_URL ?? amplify.appConfigUrl,
    mcpUrl: process.env.GUUEY_MCP_URL ?? amplify.mcpUrl ?? DEFAULT_MCP_URL,
    apiUrl: process.env.GUUEY_API_URL ?? amplify.apiUrl,
    platformUrl: process.env.GGUI_PLATFORM_URL ?? amplify.platformUrl,
    portalUrl: process.env.GGUI_PORTAL_URL ?? amplify.portalUrl,
    mcpProxyUrl: process.env.GGUI_MCP_PROXY_URL ?? amplify.mcpProxyUrl,
  };
}

/**
 * Resolve full config including the loaded canonical overlay.
 * Returns the overlay as `null` when no `guuey.json` is present (or
 * when validation failed) — downstream callers branch on nullability.
 */
export function resolveFullConfig(): ResolvedConfig & {
  project: ProjectConfig | null;
} {
  const config = resolveConfig();
  const project = loadProjectConfig();
  return { ...config, project };
}
