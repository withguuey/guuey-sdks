/**
 * guuey pull -- refresh local `guuey.json` from hosted state.
 *
 * Final Phase 4 tail of the OSS split per
 * `docs/plans/2026-04-20-guuey-pull-migration-question.md`. All
 * prerequisites landed in sessions 1-4; this command is a pure
 * consumer slice:
 *
 *   1. Resolve appId (flag / env / local guuey.json / global config).
 *   2. Fetch `GET /apps/:appId` + `GET /apps/:appId/deployments` from
 *      the hosted CLI API.
 *   3. Map response fields onto the canonical `GuueyJsonV1` shape
 *      (schema owned by `@guuey/config`).
 *   4. Preserve `mcpProxies` + `mcpServers` from any existing local
 *      overlay (hosted API has no source for these).
 *   5. Write through `saveProjectConfig`.
 *
 * URL overrides (GUUEY_HOST, GUUEY_BRIDGE_URL, etc.) stay in `.env` —
 * `guuey pull` never touches them. `ggui.json` (the open portable
 * manifest) is never read or written by this command.
 *
 * @example
 *   guuey pull                  # Use resolved appId from local context
 *   guuey pull --app-id app_X   # Override with an explicit appId
 */

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
 * `GET /apps/:appId` response shape — the subset of fields `guuey
 * pull` consumes. Matches what `app-handler.ts` emits (commit
 * 5fc832a7 + follow-ups).
 */
export interface AppResponse {
  id: string;
  name?: string | null;
  workspaceId?: string | null;
  agentSize?: string | null;
  primaryServingRegion?: string | null;
  // Other fields (hasBYOK, endpointUrl, etc.) are present on the wire
  // but `guuey pull` does not map them onto `guuey.json`.
}

/**
 * `GET /apps/:appId/deployments` response row — the subset `guuey
 * pull` consumes. Matches the explicit projection in
 * `app-handler.ts#handleListDeployments`.
 */
export interface DeploymentRow {
  buildNumber?: number;
  status?: string;
  endpointUrl?: string | null;
  deploymentId?: string | null;
  deployedAt?: string | null;
}

export interface DeploymentsResponse {
  deployments: DeploymentRow[];
}

/**
 * Pure mapper from hosted API responses → canonical
 * `GuueyJsonV1` overlay. Preserves user-owned fields (`mcpProxies`
 * + `mcpServers`) from any existing local overlay; replaces
 * `project` / `deploy` / `deployments` with hosted truth.
 *
 * Exported for unit tests — the command function below wraps it
 * with I/O + auth + error handling.
 *
 * @param app - `GET /apps/:appId` response payload
 * @param deployments - `GET /apps/:appId/deployments` response rows
 * @param existing - Current local overlay, or `null` for fresh file
 */
export function mapHostedStateToOverlay(
  app: AppResponse,
  _deployments: DeploymentRow[],
  existing: GuueyJsonV1 | null,
): GuueyJsonV1 {
  if (existing === null) {
    throw new Error(
      'mapHostedStateToOverlay requires an existing guuey.json (with at least an `agent` section). Run `guuey create` first to scaffold one.',
    );
  }

  // Refresh platform-managed fields (appId, workspaceId, agent.deploy)
  // from hosted truth; preserve everything else the user owns.
  const agentDeploy: NonNullable<NonNullable<GuueyJsonV1['agent']>['deploy']> = {
    ...(existing.agent.deploy ?? {}),
  };
  if (app.agentSize) {
    agentDeploy.size = app.agentSize as NonNullable<
      NonNullable<NonNullable<GuueyJsonV1['agent']>['deploy']>['size']
    >;
  }
  if (app.primaryServingRegion) agentDeploy.region = app.primaryServingRegion;

  const merged: GuueyJsonV1 = {
    ...existing,
    schema: '1',
    appId: app.id,
    agent: {
      ...existing.agent,
      ...(Object.keys(agentDeploy).length > 0 ? { deploy: agentDeploy } : {}),
    },
  };
  if (app.workspaceId) merged.workspaceId = app.workspaceId;

  return merged;
}

/**
 * Handle the `guuey pull` command. Fetches hosted state + writes
 * canonical `guuey.json`.
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
      'No app ID could be resolved. Run `guuey pull --app-id <id>`, or set GGUI_APP_ID, or run `guuey link` / `guuey create` first.',
    );
    process.exit(1);
  }

  // Load existing overlay — pull refreshes platform-managed fields
  // on an existing file. `guuey create` scaffolds the initial file
  // with the user-owned `agent` section.
  const existing = loadProjectConfig();
  if (existing === null) {
    if (getProjectConfigPath() !== null) {
      out.error(
        'guuey.json exists but failed schema validation. Fix it and retry, or run `guuey create` to start fresh.',
      );
    } else {
      out.error(
        'No guuey.json found in this project. Run `guuey create` first to scaffold one — `guuey pull` refreshes platform-managed fields on an existing file.',
      );
    }
    process.exit(1);
  }

  // Fetch hosted state.
  console.log('  Fetching app state...');
  const appRes = await apiRequest(auth.pat, config, 'GET', `/apps/${appId}`);
  if (!appRes.ok) {
    await handleApiFailure(appRes, `Failed to fetch app: ${appId}`);
  }
  const { app } = (await appRes.json()) as { app: AppResponse };

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

  // Map + write.
  const overlay = mapHostedStateToOverlay(app, deployments, existing);
  saveProjectConfig(overlay);

  // Human-readable summary.
  console.log('');
  out.success('guuey.json refreshed from hosted state');
  console.log('');
  console.log(`  App:          ${app.name ? app.name + ' (' + app.id + ')' : app.id}`);
  if (overlay.workspaceId)
    console.log(`  Workspace:    ${overlay.workspaceId}`);
  if (overlay.agent.deploy) {
    const parts: string[] = [];
    if (overlay.agent.deploy.size) parts.push(`size=${overlay.agent.deploy.size}`);
    if (overlay.agent.deploy.region) parts.push(`region=${overlay.agent.deploy.region}`);
    if (parts.length > 0) console.log(`  Deploy:       ${parts.join(', ')}`);
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
