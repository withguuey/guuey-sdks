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
 *      is authoritative. In an EMPTY directory (no `guuey.json` at all,
 *      guuey#1287) a nocode snapshot SCAFFOLDS the file instead — a
 *      declarative project with no `agent.mode` key, which `guuey deploy`
 *      routes as no-code (a `guuey.json` alone is declarative) — so the
 *      Behavior page's `guuey pull` → edit → `guuey deploy` path works
 *      without a `guuey create` detour that would have defaulted the
 *      project to code mode; with nothing to eject the command still
 *      refuses, naming why. The one exception is the console-authored
 *      create-time prompt draft (`AppWire.draftSystemPrompt`, guuey#463):
 *      it is written to `prompts/system.md` under the KNOWN-DEFAULT
 *      replace rule (`resolveDraftPromptAction`) — only when the local
 *      file is missing or byte-identical to a shipped default; a
 *      builder-edited prompt is never clobbered, and a live nocode
 *      snapshot always takes precedence over the draft.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requireAuth } from '../auth';
import {
  getProjectConfigPath,
  loadProjectConfig,
  resolveConfig,
  saveProjectConfig,
  type ResolvedConfig,
} from '../config';
import {
  declaredServerEntries,
  GUUEY_DEFAULT_SYSTEM_PROMPT,
  GUUEY_SCAFFOLD_SYSTEM_PROMPT,
  type GuueyAgent,
  type GuueyJsonV1,
} from '@guuey/config';
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
  // N−1 NOTE (guuey#1272): the subset `guuey pull` consumes, read with a CAST —
  // unknown fields on the app response stay ignored; a strict parse here would
  // break an older CLI against a newer door (pin: `pull.test.ts` › "guuey#1272 —
  // unknown envelope fields stay ignored").
  id: string;
  displayName?: string | null;
  /**
   * The console-authored create-time prompt draft (guuey#455/#463) —
   * `AppWire.draftSystemPrompt`. Optional so `guuey pull` degrades to a
   * no-op against an older cliApi that does not carry the field yet.
   */
  draftSystemPrompt?: string | null;
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
  // N−1 NOTE (guuey#1272): this response is read with a CAST, never a strict
  // parse — unknown envelope fields MUST stay ignored, or an older CLI meeting
  // a newer door breaks on `pull`. The pin is `pull.test.ts` › "guuey#1272 —
  // unknown envelope fields stay ignored"; it fails the moment the reader is
  // hardened, which is the whole point of it.
  snapshot: GuueyJsonV1 | null;
  /** guuey#1272 — the `${platform.*}` url templates the snapshot was authored with; absent from an older door. */
  platformTemplates?: PlatformTemplates | null;
}

/**
 * MIRROR of `@guuey-private/cli-wire` `PlatformTemplatesWire` (the CLI cannot
 * import the private lib; `wire-sync.test.ts` pins the fields). The door
 * stores the RESOLVED url in the snapshot (every pod reads a plain URL) and
 * hands the authored template back here so `guuey pull` writes the template,
 * not the environment's host, into the local manifest.
 */
export interface PlatformTemplates {
  mcpServers: Record<string, { url?: string; mcpResourceUrl?: string }>;
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
 * - When there is NO local overlay (`existing === null`, guuey#1287): a
 *   nocode snapshot becomes the whole file — the snapshot's own top-level
 *   fields plus the refreshed identity, the prompt externalized, and NO
 *   `agent.mode` key (a hand-authored declarative project; `guuey deploy`
 *   routes a `guuey.json` alone as no-code, and the scaffold's `'code'`
 *   is exactly the trap this branch removes). With no snapshot either
 *   there is nothing to write, and the mapper throws — the command turns
 *   that into the named refusal.
 *
 * Exported for unit tests — the command function below wraps it with I/O
 * + auth + error handling.
 *
 * @param app - `GET /apps/:appId` response payload
 * @param snapshot - nocode definition snapshot, or `null`
 * @param existing - Current local overlay, or `null` for an empty
 *   directory (then only a nocode snapshot can produce a file)
 */
/**
 * Put the authored `${platform.*}` templates back on the agent's external MCP
 * entries (guuey#1272). Only entries the door reported are touched; a name
 * that is no longer an external server is ignored.
 */
export function restorePlatformTemplates(agent: GuueyAgent, templates: PlatformTemplates | null): GuueyAgent {
  if (templates === null || agent.mcpServers === undefined) return agent;
  const servers = { ...agent.mcpServers };
  let changed = false;
  for (const [name, t] of Object.entries(templates.mcpServers)) {
    const entry = servers[name];
    if (entry === undefined || entry === false || entry.kind !== 'external') continue;
    servers[name] = {
      ...entry,
      ...(t.url !== undefined ? { url: t.url } : {}),
      ...(t.mcpResourceUrl !== undefined ? { mcpResourceUrl: t.mcpResourceUrl } : {}),
    };
    changed = true;
  }
  return changed ? { ...agent, mcpServers: servers } : agent;
}

export function mapHostedStateToOverlay(
  app: AppResponse,
  snapshot: GuueyJsonV1 | null,
  existing: GuueyJsonV1 | null,
  platformTemplates: PlatformTemplates | null = null,
): PullMapping {
  // No nocode snapshot to eject → refresh identity only, preserve the
  // local agent section (code projects own their local source). With no
  // local file either there is nothing to write (guuey#1287).
  if (snapshot === null) {
    if (existing === null) throw new Error(NOTHING_TO_EJECT);
    const overlay: GuueyJsonV1 = { ...existing, schema: '1', appId: app.id };
    return { overlay, promptFile: null, agentReplaced: false };
  }

  // Nocode snapshot present → replace the local agent with the pulled
  // definition. Externalize an inlined systemPrompt string so the
  // ejected project stays editable; honor an already-externalized ref.
  //
  // Deploy ROUTING is never imported from the snapshot: Studio stamps
  // `mode: 'declarative'` on every snapshot it deploys, so importing it
  // wholesale would silently reroute a code-mode scaffold's `guuey deploy`
  // back to a nocode POST one step after "eject to code" — the exact 409
  // this command exists to prevent. `mode` is the only deploy-routing
  // field on `GuueyAgent` (see its `AgentSectionV1` "── Deploy routing ──"
  // section in `@guuey/config`; `deploy.size`/`deploy.region` only
  // parametrize pod sizing, they don't select a code path in
  // `resolveDeployMode`), so preserving it alone is the complete fix.
  // The local value always wins; when the local project has none (a
  // hand-authored declarative project), the key is omitted entirely
  // rather than importing the snapshot's `'declarative'` stamp.
  // An empty directory has no local mode — the same "omit the key" branch
  // a hand-authored declarative project takes (guuey#1287).
  const localMode = existing?.agent.mode;
  // guuey#1272: the door resolved `${platform.*}` hosts into the snapshot; write the
  // authored template back so the local manifest stays environment-agnostic.
  let agent: GuueyAgent = restorePlatformTemplates(snapshot.agent, platformTemplates);
  let promptFile: { path: string; content: string } | null = null;
  const sp = snapshot.agent.systemPrompt;
  if (typeof sp === 'string') {
    promptFile = { path: SYSTEM_PROMPT_FILE, content: sp };
    agent = { ...agent, systemPrompt: { file: SYSTEM_PROMPT_FILE } };
  }
  if (localMode === undefined) {
    const { mode: _snapshotMode, ...rest } = agent;
    agent = rest;
  } else {
    agent = { ...agent, mode: localMode };
  }

  // guuey#1287: with no local file the snapshot IS the file (its own
  // top-level fields — `protocol`, `app`, `ggui`, … — are the deployed
  // truth); with one, the local top-level fields are preserved as before.
  const overlay: GuueyJsonV1 = {
    ...(existing ?? snapshot),
    schema: '1',
    appId: app.id,
    agent,
  };
  return { overlay, promptFile, agentReplaced: true };
}

/**
 * The one refusal left for an empty directory (guuey#1287): the app has no
 * deployed no-code definition to eject, so there is nothing to write.
 */
export const NOTHING_TO_EJECT =
  'No guuey.json here, and this app has no deployed no-code definition to eject. ' +
  'For a no-code app, deploy it once (the wizard, Studio, or `guuey agent apply`) and pull again; ' +
  'for a code-mode app, run `guuey create` to scaffold the project first — `guuey pull` then refreshes it.';

// ─── The create-time draft (guuey#463, the #455 rider) ────────────────

/**
 * What `guuey pull` should do with the console-authored create-time
 * prompt draft when there is NO live nocode snapshot (a snapshot always
 * takes precedence — its prompt is the deployed truth, the draft is
 * pre-deploy working text):
 *
 * - `write`  — put the draft into {@link SYSTEM_PROMPT_FILE}.
 * - `diverged` — leave the local file untouched and say so: the builder
 *   edited it, and pull never clobbers builder-authored text.
 * - `none`   — nothing to do (no draft on the wire: older cliApi omits
 *   the field, or none was authored / it is empty).
 */
export type DraftPromptAction =
  | { kind: 'write'; content: string }
  | { kind: 'diverged' }
  | { kind: 'none' };

/**
 * The two texts `pull` may overwrite — the scaffold's shipped
 * `prompts/system.md` and the runtime default — each in the exact
 * newline-normalized form `build-templates.mjs` stamps (`text + '\n'`),
 * plus the bare trimmed constant (an editor that strips the final
 * newline does not turn an untouched default into "builder-authored").
 * Anything else is the builder's own text and is never replaced.
 */
function isKnownDefaultPrompt(content: string): boolean {
  for (const text of [GUUEY_SCAFFOLD_SYSTEM_PROMPT, GUUEY_DEFAULT_SYSTEM_PROMPT]) {
    if (content === `${text}\n` || content === text) return true;
  }
  return false;
}

/**
 * The known-default replace rule (guuey#463), as a pure decision:
 *
 * | draft on the wire      | local `prompts/system.md`      | action     |
 * | ---------------------- | ------------------------------ | ---------- |
 * | absent (old cliApi) /  | —                              | `none`     |
 * |   `null` / empty       |                                |            |
 * | present                | missing                        | `write`    |
 * | present                | byte-identical known default   | `write`    |
 * | present                | anything else (builder-edited) | `diverged` |
 *
 * Callers apply this ONLY in the no-snapshot branch — a live nocode
 * snapshot's prompt always wins over the draft.
 *
 * Exported for unit tests.
 *
 * @param draft - `AppResponse.draftSystemPrompt` as fetched
 * @param localPrompt - current content of {@link SYSTEM_PROMPT_FILE}, or
 *   `null` when the file does not exist
 */
export function resolveDraftPromptAction(
  draft: string | null | undefined,
  localPrompt: string | null,
): DraftPromptAction {
  if (typeof draft !== 'string' || draft === '') return { kind: 'none' };
  if (localPrompt === null || isKnownDefaultPrompt(localPrompt)) {
    return { kind: 'write', content: draft };
  }
  return { kind: 'diverged' };
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
      'No app ID could be resolved. Run `guuey pull --app-id <id>`, or set GUUEY_APP_ID, or run `guuey create` first.',
    );
    process.exit(1);
  }

  // Load the local overlay when there is one. A file that exists but does
  // not validate is refused (pull never guesses at a broken file); NO file
  // is fine — a nocode snapshot scaffolds it (guuey#1287), and with nothing
  // to eject the refusal below names why.
  const existing = loadProjectConfig();
  if (existing === null && getProjectConfigPath() !== null) {
    out.error(
      'guuey.json exists but failed schema validation. Fix it and retry, or run `guuey create` to start fresh.',
    );
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
  let platformTemplates: PlatformTemplates | null = null;
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
    ({ snapshot, platformTemplates = null } = (await snapRes.json()) as DeploymentSnapshotResponse);
  }

  // Map + externalize the prompt + write. An empty directory with nothing
  // to eject is the one refusal left (guuey#1287).
  if (existing === null && snapshot === null) {
    out.error(NOTHING_TO_EJECT);
    process.exit(1);
  }
  const scaffolded = existing === null;
  const { overlay, promptFile, agentReplaced } = mapHostedStateToOverlay(
    app,
    snapshot,
    existing,
    platformTemplates,
  );

  if (promptFile) {
    const target = join(process.cwd(), promptFile.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, promptFile.content, 'utf-8');
  }

  // guuey#463 — the console-authored create-time draft, under the
  // known-default replace rule. Only in the no-snapshot branch: a live
  // nocode snapshot's prompt (externalized above) always takes precedence
  // over pre-deploy working text.
  let draftAction: DraftPromptAction = { kind: 'none' };
  if (!agentReplaced) {
    const target = join(process.cwd(), SYSTEM_PROMPT_FILE);
    const localPrompt = existsSync(target) ? readFileSync(target, 'utf-8') : null;
    draftAction = resolveDraftPromptAction(app.draftSystemPrompt, localPrompt);
    if (draftAction.kind === 'write') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, draftAction.content, 'utf-8');
    }
  }

  saveProjectConfig(overlay);

  // Human-readable summary.
  console.log('');
  const appLabel = app.displayName
    ? `${app.displayName} (${app.id})`
    : app.id;
  if (agentReplaced) {
    out.success(
      scaffolded
        ? 'guuey.json created from the latest no-code deployment (declarative — `guuey deploy` routes it as no-code)'
        : 'guuey.json ejected from the latest no-code deployment',
    );
    console.log('');
    console.log(`  App:          ${appLabel}`);
    if (buildNumber !== null) console.log(`  Deployment:   build #${buildNumber} (nocode)`);
    console.log(`  Agent:        replaced the local agent section with the deployed snapshot`);
    console.log(`  framework:    ${overlay.agent.framework ?? 'claude-agent-sdk (default)'}`);
    console.log(`  model:        ${overlay.agent.model ?? '(framework default)'}`);
    if (promptFile) {
      console.log(`  systemPrompt: ${promptFile.path} (${promptFile.content.length} chars)`);
    }
    // `declaredServerEntries` drops the `ggui: false` opt-out — it is not a
    // configured server, and listing it here would read as "ggui is on".
    const mcpServers = overlay.agent.mcpServers
      ? declaredServerEntries(overlay.agent.mcpServers).map(([name]) => name).join(', ') ||
        '(none — ggui disabled)'
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
    if (draftAction.kind === 'write') {
      console.log(
        `  systemPrompt: ${SYSTEM_PROMPT_FILE} seeded from the app's create-time draft (${draftAction.content.length} chars)`,
      );
    } else if (draftAction.kind === 'diverged') {
      console.log(
        `  systemPrompt: local ${SYSTEM_PROMPT_FILE} has your own edits — left untouched (the app's create-time draft was not applied)`,
      );
    } else {
      console.log('  No no-code snapshot to pull; refreshed app binding only.');
    }
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
