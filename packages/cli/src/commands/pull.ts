/**
 * guuey pull -- eject the agent definition from the latest no-code
 * deployment into a local `guuey.json` (the real eject mechanic, J5).
 *
 * Flow:
 *
 *   1. Resolve appId (flag / env / local guuey.json / global config).
 *   2. Fetch `GET /apps/:appId` (identity) + `GET /apps/:appId/deployments`
 *      (the deployment list).
 *   3. Pick the newest LIVE, NOCODE build from the list and fetch its
 *      definition snapshot via `GET /apps/:appId/deployments/:n` — the
 *      only endpoint that returns the agent-definition snapshot.
 *   4. When a nocode snapshot is present, REPLACE the local `agent`
 *      section with `snapshot.agent`; externalize the inlined
 *      systemPrompt string back out to `prompts/system.md` so the
 *      ejected project stays editable (round-trips losslessly through
 *      `guuey deploy`, which re-inlines it via `buildDeploySnapshot`).
 *   5. When there is no live nocode snapshot (code-mode app, or nothing
 *      deployed yet), refresh identity (`appId`) only and leave the
 *      local agent section untouched — the code project's local source
 *      is authoritative.
 *   6. Write through `saveProjectConfig` (re-validates the overlay).
 *
 * URL overrides (GUUEY_HOST, GUUEY_BRIDGE_URL, etc.) stay in `.env` —
 * `guuey pull` never touches them. `ggui.json` (the open portable
 * manifest) is never read or written by this command.
 *
 * Overwrite UX: auto-overwrite when a live nocode snapshot is present
 * (the eject flow runs `guuey pull` on a fresh scaffold, so the common
 * path is clean). The replaced agent's key fields are printed so a
 * non-placeholder local edit being clobbered is always visible.
 *
 * @example
 *   guuey pull                  # Use resolved appId from local context
 *   guuey pull --app-id app_X   # Override with an explicit appId
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requireAuth } from '../auth';
import {
  getProjectConfigPath,
  loadProjectConfig,
  resolveConfig,
  saveProjectConfig,
  type ResolvedConfig,
} from '../config';
import type { GuueyJsonV1 } from '@guuey/config';
import * as out from '../output';

/**
 * Canonical relative path the ejected systemPrompt is written to, so the
 * pulled project matches the `@guuey/create-agentic-app` scaffold
 * convention (`agent.systemPrompt = { file: 'prompts/system.md' }`).
 */
export const SYSTEM_PROMPT_FILE = 'prompts/system.md';

/**
 * `GET /apps/:appId` response shape — the subset `guuey pull` consumes.
 * The cliApi wire (`backend/.../cliApi/handlers/apps.ts#AppWire`) emits
 * `displayName` (NOT `name`) and does NOT carry `workspaceId`,
 * `agentSize`, or `primaryServingRegion` — those live on the deployment
 * snapshot, not the app row. Identity refresh off this row is `appId`
 * only; size/region/definition come from the snapshot (see below).
 */
export interface AppResponse {
  id: string;
  displayName?: string | null;
  // Other fields (status, guestAccess, etc.) are on the wire but `guuey
  // pull` does not map them onto `guuey.json`.
}

/**
 * `GET /apps/:appId/deployments` response row — the subset `guuey pull`
 * reads to pick the build to eject. Mirrors the cliApi `DeploymentWire`
 * (`backend/.../cliApi/handlers/deploy.ts`). `buildNumber`, `status`,
 * and `agentMode` are always present on the wire (legacy rows default
 * `agentMode` to `'code'`); `size` may be null.
 */
export interface DeploymentRow {
  buildNumber: number;
  status: string;
  agentMode: 'code' | 'nocode';
  size?: string | null;
  // Other DeploymentWire fields (deploymentId, endpointUrl, …) are on
  // the wire but unused by the eject pick.
}

export interface DeploymentsResponse {
  deployments: DeploymentRow[];
}

/**
 * `GET /apps/:appId/deployments/:n` response — the ONLY endpoint that
 * returns the agent-definition snapshot. `snapshot` is a schema-valid
 * `GuueyJsonV1` (systemPrompt inlined as a string) for nocode rows, and
 * `null` for code rows (their source is a tarball, not a snapshot).
 */
export interface DeploymentSnapshotResponse {
  snapshot: GuueyJsonV1 | null;
}

/**
 * Statuses that mean a build is the live serving workload. `guuey pull`
 * ejects the definition that is CURRENTLY deployed and serving, so only
 * `'live'` qualifies. In-flight (`queued`/`building`/`deploying`) and
 * terminal (`superseded`/`undeployed`/`failed`) rows are skipped.
 */
const DEPLOYED_STATUSES: ReadonlySet<string> = new Set(['live']);

/**
 * Pick the build number to eject from a deployments list: the newest
 * (highest `buildNumber`) row that is both LIVE and NOCODE. Returns
 * `null` when the app has no live nocode deployment (code-mode app, or
 * nothing currently deployed) — the caller then degrades to an
 * identity-only refresh.
 *
 * Does not rely on the list's server-side ordering — picks by max
 * `buildNumber` explicitly.
 *
 * Exported for unit tests.
 */
export function pickSnapshotBuild(deployments: DeploymentRow[]): number | null {
  let picked: number | null = null;
  for (const d of deployments) {
    if (d.agentMode !== 'nocode') continue;
    if (!DEPLOYED_STATUSES.has(d.status)) continue;
    if (picked === null || d.buildNumber > picked) picked = d.buildNumber;
  }
  return picked;
}

/**
 * Result of mapping hosted state onto the local overlay.
 *
 * `overlay` is the merged `GuueyJsonV1` to write through
 * `saveProjectConfig`. `promptFile`, when non-null, is the inlined
 * systemPrompt string to externalize (mkdir + writeFile) so the ejected
 * project stays editable. `agentReplaced` is true when the local agent
 * section was overwritten by the pulled nocode snapshot (drives the
 * summary + overwrite notice).
 */
export interface PullMapping {
  overlay: GuueyJsonV1;
  promptFile: { path: string; content: string } | null;
  agentReplaced: boolean;
}

/**
 * Pure mapper from hosted state → canonical `GuueyJsonV1` overlay.
 *
 * - Always refreshes identity (`appId`) from the app row.
 * - When `snapshot` is a nocode definition: REPLACES the local `agent`
 *   section with `snapshot.agent` (framework/model/mcpServers/deploy/…)
 *   and externalizes an inlined systemPrompt string to
 *   {@link SYSTEM_PROMPT_FILE}. Honors a snapshot systemPrompt that is
 *   already a `{ file }` reference.
 * - When `snapshot` is `null` (code-mode / no live nocode deploy):
 *   preserves the local `agent` section untouched (identity refresh only).
 *
 * Every other top-level field (`workspaceId`, `app`, `ggui`, `worker`,
 * `protocol`, `runtime`) is preserved from the local overlay — pull only
 * replaces identity + the agent definition.
 *
 * Exported for unit tests — the command function below wraps it with I/O
 * + auth + error handling.
 *
 * @param app - `GET /apps/:appId` response payload
 * @param snapshot - nocode definition snapshot, or `null`
 * @param existing - Current local overlay (required — pull refreshes an
 *   existing file, it does not scaffold)
 */
export function mapHostedStateToOverlay(
  app: AppResponse,
  snapshot: GuueyJsonV1 | null,
  existing: GuueyJsonV1 | null,
): PullMapping {
  if (existing === null) {
    throw new Error(
      'mapHostedStateToOverlay requires an existing guuey.json (with at least an `agent` section). Run `guuey create` first to scaffold one.',
    );
  }

  // No nocode snapshot to eject → refresh identity only, preserve the
  // local agent section (code projects own their local source).
  if (snapshot === null) {
    const overlay: GuueyJsonV1 = { ...existing, schema: '1', appId: app.id };
    return { overlay, promptFile: null, agentReplaced: false };
  }

  // Nocode snapshot present → replace the local agent with the pulled
  // definition. Externalize an inlined systemPrompt string so the
  // ejected project stays editable; honor an already-externalized ref.
  let agent = snapshot.agent;
  let promptFile: { path: string; content: string } | null = null;
  const sp = snapshot.agent.systemPrompt;
  if (typeof sp === 'string') {
    promptFile = { path: SYSTEM_PROMPT_FILE, content: sp };
    agent = { ...snapshot.agent, systemPrompt: { file: SYSTEM_PROMPT_FILE } };
  }

  const overlay: GuueyJsonV1 = {
    ...existing,
    schema: '1',
    appId: app.id,
    agent,
  };
  return { overlay, promptFile, agentReplaced: true };
}

/**
 * Handle the `guuey pull` command. Fetches hosted state + writes
 * canonical `guuey.json` (ejecting the latest no-code agent definition).
 */
export async function pull(
  flags?: Record<string, string | true>,
): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();

  // Resolve appId — flag > env > local overlay > global config.
  const appId =
    (typeof flags?.['app-id'] === 'string' ? flags['app-id'] : undefined) ??
    config.appId;

  if (!appId) {
    out.error(
      'No app ID could be resolved. Run `guuey pull --app-id <id>`, or set GGUI_APP_ID, or run `guuey create` first.',
    );
    process.exit(1);
  }

  // Load existing overlay — pull refreshes an existing file. `guuey
  // create` scaffolds the initial file with the `agent` section.
  const existing = loadProjectConfig();
  if (existing === null) {
    if (getProjectConfigPath() !== null) {
      out.error(
        'guuey.json exists but failed schema validation. Fix it and retry, or run `guuey create` to start fresh.',
      );
    } else {
      out.error(
        'No guuey.json found in this project. Run `guuey create` first to scaffold one — `guuey pull` refreshes an existing file.',
      );
    }
    process.exit(1);
  }

  // Fetch identity.
  console.log('  Fetching app state...');
  const appRes = await apiRequest(auth.pat, config, 'GET', `/apps/${appId}`);
  if (!appRes.ok) {
    await handleApiFailure(appRes, `Failed to fetch app: ${appId}`);
  }
  const { app } = (await appRes.json()) as { app: AppResponse };

  // Fetch the deployment list, pick the live nocode build to eject.
  console.log('  Fetching deployment records...');
  const depsRes = await apiRequest(
    auth.pat,
    config,
    'GET',
    `/apps/${appId}/deployments`,
  );
  if (!depsRes.ok) {
    await handleApiFailure(depsRes, `Failed to fetch deployments: ${appId}`);
  }
  const { deployments } = (await depsRes.json()) as DeploymentsResponse;
  const buildNumber = pickSnapshotBuild(deployments);

  // Fetch the definition snapshot for the picked build (nocode only).
  let snapshot: GuueyJsonV1 | null = null;
  if (buildNumber !== null) {
    console.log(`  Pulling no-code definition (build #${buildNumber})...`);
    const snapRes = await apiRequest(
      auth.pat,
      config,
      'GET',
      `/apps/${appId}/deployments/${buildNumber}`,
    );
    if (!snapRes.ok) {
      await handleApiFailure(
        snapRes,
        `Failed to fetch deployment snapshot: build #${buildNumber}`,
      );
    }
    ({ snapshot } = (await snapRes.json()) as DeploymentSnapshotResponse);
  }

  // Map + externalize the prompt + write.
  const { overlay, promptFile, agentReplaced } = mapHostedStateToOverlay(
    app,
    snapshot,
    existing,
  );

  if (promptFile) {
    const target = join(process.cwd(), promptFile.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, promptFile.content, 'utf-8');
  }

  saveProjectConfig(overlay);

  // Human-readable summary.
  console.log('');
  const appLabel = app.displayName
    ? `${app.displayName} (${app.id})`
    : app.id;
  if (agentReplaced) {
    out.success('guuey.json ejected from the latest no-code deployment');
    console.log('');
    console.log(`  App:          ${appLabel}`);
    if (buildNumber !== null) console.log(`  Deployment:   build #${buildNumber} (nocode)`);
    console.log(`  Agent:        replaced the local agent section with the deployed snapshot`);
    console.log(`  framework:    ${overlay.agent.framework ?? 'claude-agent-sdk (default)'}`);
    console.log(`  model:        ${overlay.agent.model ?? '(framework default)'}`);
    if (promptFile) {
      console.log(`  systemPrompt: ${promptFile.path} (${promptFile.content.length} chars)`);
    }
    const mcpServers = overlay.agent.mcpServers
      ? Object.keys(overlay.agent.mcpServers).join(', ')
      : 'ggui (default)';
    console.log(`  mcpServers:   ${mcpServers}`);
    if (overlay.agent.deploy) {
      const parts: string[] = [];
      if (overlay.agent.deploy.size) parts.push(`size=${overlay.agent.deploy.size}`);
      if (overlay.agent.deploy.region) parts.push(`region=${overlay.agent.deploy.region}`);
      if (parts.length > 0) console.log(`  Deploy:       ${parts.join(', ')}`);
    }
  } else {
    out.success('App binding refreshed (appId only)');
    console.log('');
    console.log(`  App:          ${appLabel}`);
    console.log('  No no-code snapshot to pull; refreshed app binding only.');
  }
  console.log('');
}

/**
 * Human-friendly error rendering for a non-OK hosted API response.
 * Reads the body for an `error` field if JSON; falls back to status
 * line otherwise. Always exits 1.
 */
async function handleApiFailure(
  res: Response,
  prefix: string,
): Promise<never> {
  let message: string;
  try {
    const data = (await res.json()) as { error?: string };
    message = data.error ?? `HTTP ${res.status}`;
  } catch {
    message = `HTTP ${res.status} ${res.statusText}`;
  }
  if (res.status === 401) {
    out.error(`${prefix}: ${message}. Run \`guuey login\` and try again.`);
  } else if (res.status === 404) {
    out.error(`${prefix}: app not found.`);
  } else if (res.status === 403) {
    out.error(`${prefix}: forbidden (not the app owner).`);
  } else {
    out.error(`${prefix}: ${message}`);
  }
  process.exit(1);
}

/** Make an authenticated JSON request to the CLI API. */
async function apiRequest(
  pat: string,
  config: ResolvedConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  if (!config.apiUrl) {
    throw new Error(
      'REST API URL not configured. Ensure amplify_outputs.json is present or set GUUEY_API_URL.',
    );
  }
  const baseUrl = config.apiUrl.replace(/\/$/, '');
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pat}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
