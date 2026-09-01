/**
 * guuey deploy -- Package, upload, and deploy an agent to guuey cloud.
 *
 * Three deploy shapes, routed by `resolveDeployMode` (`../deploy-plan.ts`
 * — pure, unit-tested; see its doc comment for the full rule table):
 *
 *   1. **Code (worker-based, orchestrated)** — selected EXPLICITLY via the
 *      `--code` flag or `guuey.json#agent.mode: 'code'` (stamped by
 *      `@guuey/create-agentic-app` scaffolds). This is the one-command
 *      orchestrator (design doc `2026-07-03-guuey-create-agentic-app-design.md`
 *      §7): resolve/create the app, deploy each hosted-MCP `source` leg,
 *      push ggui assets, build the worker (`corepack pnpm build` →
 *      `guuey.worker.js`), then pack + upload + trigger + poll like any
 *      code-mode deploy. The backend builds the runtime image `FROM` its
 *      own base image (Kaniko `Dockerfile.worker` template) — no
 *      user-committed Dockerfile is read or required for this shape.
 *   2. **Code (user-Dockerfile, legacy)** — repo has a root `Dockerfile`
 *      and no explicit code declaration. Preserved unchanged: packs +
 *      uploads + triggers + polls with no MCP/ggui legs, no build step, no
 *      config snapshot.
 *   3. **Declarative** — `guuey.json` with `agent.mode: 'declarative'` or
 *      no mode + no Dockerfile (e.g. `guuey pull`'d Studio/no-code agent).
 *      No tarball, no build. The snapshot (system prompt inlined) is
 *      POSTed directly to the control plane and the stock
 *      `nocode-runtime` pod boots off it.
 *
 * Usage:
 *   guuey deploy                 # Auto-detect mode
 *   guuey deploy --declarative   # Force declarative (uses guuey.json, no build)
 *   guuey deploy --code          # Force code mode
 *   guuey deploy --size sm       # Override pod size
 *   guuey deploy --build-size lg # Override build Job size (code mode only)
 *   guuey deploy --max-pods 3    # Set the app's replica count (scaling S1)
 *   guuey deploy --app-id <id>   # Deploy to another app (binding untouched, guuey#232)
 *   guuey deploy --force         # Force deploy even if no changes detected
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  GUUEY_JSON_FILENAME,
  loadGuueyJson,
  buildDeploySnapshot,
  validateNoLiteralSecrets,
  validateColocatedServerNames,
  validateToolGates,
  writeGuueyJsonFile,
  declaredServerEntries,
  type ResolvedGuueyJson,
  type GuueyJsonV1,
} from '@guuey/config';
import { requireAuth, type AuthTokens } from '../auth';
import {
  resolveConfig,
  loadProjectConfig,
  loadConfig,
  saveConfig,
  type ResolvedConfig,
  type ProjectConfig,
} from '../config';
import { apiRequest, cleanup, packSource, parseApiError } from '../deploy-shared';
import { deployMcpFromSource, resolveServerName, resolveWorkspaceId, readPackageName } from './mcp';
import { fetchByoOriginGap, printByoOriginWarning } from './apps';
import {
  planMcpLegs,
  writeBackServerId,
  snapshotWithServerIds,
  resolveDeployMode,
  shouldOfferAppCreate,
} from '../deploy-plan';
import { buildGguiAssetPush, pushGguiAssetsLeg, type GguiAssetPushBody } from '../ggui-assets';
import * as out from '../output';

/**
 * Map a platform host to its portal origin — mirrors the live-verified
 * prefix map in `apps/platform/src/lib/env.ts#getPortalUrl` (dev/staging
 * sandbox hosts and the production apex), keyed off `config.host` (NOT
 * `config.portalUrl`/amplify outputs — those are unset in most envs today,
 * which is exactly how S12 shipped a hardcoded prod origin for a dev
 * deploy). Returns `null` for an unrecognized host so the caller can omit
 * the Portal line entirely rather than print a wrong origin.
 */
export function portalOriginForHost(host: string | undefined): string | null {
  if (!host) return null;
  let hostname: string;
  try {
    hostname = new URL(host).hostname;
  } catch {
    return null;
  }
  if (hostname === 'platform.guuey.com') return 'https://app.guuey.com';
  const sandboxMatch = hostname.match(/^([a-z0-9-]+)\.platform\.sandbox\.guuey\.com$/);
  if (sandboxMatch) return `https://${sandboxMatch[1]}.app.sandbox.guuey.com`;
  return null;
}

/**
 * The full Portal share-link line for a deployed app, or `null` when
 * `host` doesn't map to a known portal origin (see {@link portalOriginForHost}).
 */
export function portalLine(host: string | undefined, appId: string): string | null {
  const origin = portalOriginForHost(host);
  return origin ? `${origin}/agent/${appId}` : null;
}

/**
 * The pod-lifetime footer under every deploy summary.
 *
 * Agent pods are ALWAYS-ON: the controller holds `spec.replicas` at the
 * app's pod limit and nothing reaps a live agent on idle. This used to
 * promise "Scales to zero when idle", which was never true of an agent pod
 * and read as a billing promise (scaling S1, guuey#162). One helper so the
 * three deploy paths cannot drift back apart.
 */
function printPodLifetime(maxPods: number | undefined): void {
  console.log('  Pods run continuously — no scale-to-zero, no idle timeout.');
  console.log(
    maxPods === undefined
      ? '  Set the pod limit with --max-pods, or "guuey agent config --max-pods <n>".'
      : '  Change the limit with "guuey agent config --max-pods <n>" — no redeploy.',
  );
}

/**
 * Handle the `guuey deploy` command.
 *
 * @param flags - CLI flags (e.g., `{ size: 'sm', target: 'ggui' }`)
 */
/**
 * guuey#580 belt adoption: the deploy trigger's 202 may carry an additive
 * `warnings: string[]` (e.g. the server's MODES_DROPPED_ON_DEPLOY drift
 * warn — a modeless snapshot atop a modeful prior). Print each entry
 * verbatim, prefixed like every CLI warning; ignore anything not a
 * non-empty string (the field is additive wire — junk-tolerant by
 * design; old CLIs ignore it entirely, which is the belt's point).
 * Exported for tests.
 */
export function printTriggerWarnings(body: unknown): void {
  if (body === null || typeof body !== 'object') return;
  const warnings = (body as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return;
  for (const w of warnings) {
    if (typeof w === 'string' && w.length > 0) console.log(`  ! ${w}`);
  }
}

export async function deploy(flags?: Record<string, string | true>): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  let project = loadProjectConfig();

  const cwd = process.cwd();
  const cwdGuueyJson = join(cwd, GUUEY_JSON_FILENAME);
  const cwdDockerfile = join(cwd, 'Dockerfile');
  const cwdPackageJson = join(cwd, 'package.json');
  const hasGuueyJson = existsSync(cwdGuueyJson);
  const hasDockerfile = existsSync(cwdDockerfile);
  const hasPackageJson = existsSync(cwdPackageJson);

  // ── Mode resolution (single decision, pure + unit-tested) ────────────
  // `agent.mode` must come from the ROOT guuey.json — loadProjectConfig
  // walks parent directories, so gate on hasGuueyJson (cwd) to avoid a
  // parent project's declaration leaking into an unrelated subdirectory.
  const decision = resolveDeployMode({
    forceDeclarative: flags?.declarative === true,
    forceCode: flags?.code === true,
    hasGuueyJson,
    hasDockerfile,
    hasPackageJson,
    agentMode: hasGuueyJson ? project?.agent?.mode : undefined,
  });
  if (decision.kind === 'error') {
    out.error(decision.message);
    process.exit(1);
  }
  const mode = decision.mode;
  if (mode === 'code-legacy-dockerfile' && hasGuueyJson) {
    console.log(
      `  Both Dockerfile and ${GUUEY_JSON_FILENAME} found — using Dockerfile (legacy code mode).`,
    );
    console.log(
      `  Set ${GUUEY_JSON_FILENAME}#agent.mode or pass --declarative/--code to route explicitly.`,
    );
  }

  // ── Step 1: Preflight — auth + app linked ─────────────────────────────
  // The orchestrated code path (only) offers to create + link an app right
  // here on a first interactive run (design doc §7.1). Every other case —
  // non-TTY invocations included — keeps the pre-existing fail-fast error.
  //
  // guuey#232: an explicit `--app-id` WINS over the guuey.json binding — the
  // same precedence every other subcommand already applies
  // (`flags['app-id'] ?? config.appId`), and what "deploy this one scaffold
  // to a second environment" needs. Before this, the flag was read by no
  // one here and a bound scaffold silently deployed to its bound id (the
  // demo-tier stand-up hit exactly that). The guuey.json binding is NOT
  // rewritten by an override — the working copy stays bound to its own id.
  const explicitAppId = typeof flags?.['app-id'] === 'string' ? flags['app-id'].trim() : undefined;
  if (flags?.['app-id'] !== undefined && !explicitAppId) {
    out.error('--app-id needs a value (e.g. --app-id <uuid>).');
    process.exit(1);
  }
  // guuey#355: deploy resolves its identity SOURCE-AWARE, never through the
  // merged config. Precedence: --app-id > GGUI_APP_ID (an explicit
  // per-invocation choice) > the guuey.json binding. The machine-global
  // default (~/.guuey/config.json) is used ONLY when the directory has no
  // guuey.json at all (the explicitly-bound single-project flow) — a
  // project that deliberately carries no appId must REFUSE, not silently
  // deploy to whatever id a past ritual left in the operator's global
  // config (the near-miss: a bare deploy from the trimly checkout resolved
  // to the LIVE Helper's id).
  const envAppId = process.env.GGUI_APP_ID?.trim() || undefined;
  const projectBoundAppId = project?.appId;
  const overridden = explicitAppId
    ? projectBoundAppId && explicitAppId !== projectBoundAppId
      ? { source: `the ${GUUEY_JSON_FILENAME} binding`, id: projectBoundAppId }
      : !project && config.appId && explicitAppId !== config.appId
        ? { source: 'the global default (~/.guuey/config.json)', id: config.appId }
        : undefined
    : undefined;
  if (overridden) {
    console.log(
      `  --app-id ${explicitAppId} overrides ${overridden.source} (${overridden.id}) for this deploy only.`,
    );
  }
  let appId = explicitAppId ?? envAppId ?? projectBoundAppId ?? (project ? undefined : config.appId);
  if (!appId) {
    if (shouldOfferAppCreate(mode, process.stdin.isTTY, process.stdout.isTTY)) {
      appId = await ensureLinkedApp({ auth, config, project, guueyJsonPath: cwdGuueyJson });
      // ensureLinkedApp may have written `appId` into guuey.json — reload so
      // downstream reads (deploy.size default, etc.) see it.
      project = loadProjectConfig();
    } else {
      out.error(
        `No app linked${project ? ` (${GUUEY_JSON_FILENAME} carries no "appId"${config.appId ? '; the global default is deliberately NOT used for deploys' : ''})` : ''}. ` +
          'Set "appId" in guuey.json, pass --app-id <id>, run "guuey pull --app-id <id>" to bind an existing app, or run "guuey deploy" in an interactive terminal to create one.',
      );
      process.exit(1);
    }
  }

  // `deploy.size` on the canonical overlay is the app-level default
  // for new deploys. `buildSize` is a per-invocation flag only per
  // §8.4 (not overlay material). `target` is implicitly `'guuey'` on
  // every record the closed CLI writes — overlay-explicit target
  // selection is a future additive if non-Guuey hosted targets land.
  const size = (flags?.size as string) ?? project?.agent?.deploy?.size ?? 'xs';
  const buildSize = (flags?.['build-size'] as string) ?? 'md';
  const target = (flags?.target as string) ?? 'ggui';
  const label = flags?.label as string | undefined;
  const force = flags?.force === true;

  // `--max-pods` is FLAG-ONLY, unlike `--size`: `guuey.json#agent.deploy` is
  // a strictObject of `{size, region}` (`@guuey/config#DeploySchema`), so
  // there is no overlay key to fall back to — adding one is a schema change,
  // not a CLI change. Absent flag = field omitted from the trigger body =
  // the app's persisted knob is left untouched (a redeploy never resets it).
  // The real ceiling is the SERVER's (plan tier, or an admin per-app raise);
  // it answers 409 AGENT_MAX_PODS naming the number, so this validates only
  // "positive integer" and never guesses a limit.
  const maxPodsFlag = flags?.['max-pods'];
  let maxPods: number | undefined;
  if (maxPodsFlag !== undefined) {
    const parsed = maxPodsFlag === true ? NaN : Number(maxPodsFlag);
    if (!Number.isInteger(parsed) || parsed < 1) {
      out.error('--max-pods must be a positive integer (e.g. --max-pods 3).');
      process.exit(1);
    }
    maxPods = parsed;
  }
  // Same absent-keeps semantics as --max-pods (runtime-update-channel §4.2):
  // a carried value persists via the trigger; a builder's opt-out must never
  // be silently dropped.
  const autoUpdateFlag = flags?.['runtime-auto-update'];
  let runtimeAutoUpdate: boolean | undefined;
  if (autoUpdateFlag !== undefined) {
    if (autoUpdateFlag !== 'on' && autoUpdateFlag !== 'off') {
      out.error('--runtime-auto-update takes "on" or "off" (e.g. --runtime-auto-update off pins the runtime at this deploy).');
      process.exit(1);
    }
    runtimeAutoUpdate = autoUpdateFlag === 'on';
  }

  const VALID_BUILD_SIZES = ['sm', 'md', 'lg', 'xl'];
  if (!VALID_BUILD_SIZES.includes(buildSize)) {
    out.error(
      `Invalid --build-size "${buildSize}". Must be one of: ${VALID_BUILD_SIZES.join(', ')}.`,
    );
    process.exit(1);
  }

  // Validate version label (git tag rules)
  if (label) {
    const LABEL_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
    if (!LABEL_REGEX.test(label) || label.includes('..') || label.endsWith('.lock') || label.endsWith('.')) {
      out.error(`Invalid label "${label}". Use git-tag format: alphanumeric, dots, hyphens, underscores. No spaces or special characters.`);
      process.exit(1);
    }
  }

  if (target !== 'ggui') {
    out.error(`Target "${target}" is not yet supported. Only "ggui" is available.`);
    process.exit(1);
  }

  if (mode === 'declarative') {
    await deployDeclarative({
      auth,
      config,
      appId,
      guueyJsonPath: cwdGuueyJson,
      size,
      maxPods,
      runtimeAutoUpdate,
      label,
    });
  } else if (mode === 'code-orchestrated') {
    await deployCode({
      auth,
      config,
      appId,
      guueyJsonPath: cwdGuueyJson,
      root: cwd,
      size,
      buildSize,
      maxPods,
      runtimeAutoUpdate,
      label,
      force,
      flags,
    });
  } else {
    await deployLegacyDockerfile({ auth, config, appId, size, buildSize, maxPods, runtimeAutoUpdate, label, force });
  }

  // A deployed byo app with an empty origin allowlist is an embed browsers
  // will refuse (guuey#186 Gap 2) — the moment the deploy lands is the
  // moment the builder can act on it. Warn, never block; placed AFTER the
  // deploy legs so every client-side validation error above stays
  // network-free, and best-effort by the helper's own contract (a failed
  // read means no warning).
  if (await fetchByoOriginGap(appId)) printByoOriginWarning(appId);
}

// ─── Preflight: first-run app create + link write-back ───────────────────

/** Prompt for a single line of input via readline. */
function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((res) => rl.question(question, res));
}

/**
 * The reusable core of the app-create offer (S9 regression coverage):
 * send the create request with an already-resolved `appName`, parse the
 * REAL response shape, and write back to both the project overlay and the
 * global config. Split out of `ensureLinkedApp` so the actual bug surface
 * (wrong payload key, wrong response parse) is unit-testable without
 * mocking the interactive readline prompt.
 *
 * cliApi POST /v1/apps expects `displayName` (NOT `name`) and returns 201
 * `{ app: {...AppWire} }` — no `apiKey` (see
 * `backend/amplify/functions/cliApi/handlers/apps.ts#handleCreateApp`/
 * `toWire`). Mirrors `apps.ts#appsCreate`'s parse of the same route.
 *
 * Returns the resolved appId; exits the process on API failure.
 */
export async function createLinkedApp(opts: {
  auth: AuthTokens;
  config: ResolvedConfig;
  project: ProjectConfig | null;
  guueyJsonPath: string;
  appName: string;
}): Promise<string> {
  const { auth, config, project, guueyJsonPath, appName } = opts;

  console.log('  Creating platform app...');
  const res = await apiRequest(auth.pat, config, 'POST', '/apps', {
    displayName: appName,
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    out.error(`Failed to create app: ${parseApiError(data, `HTTP ${res.status}`)}`);
    process.exit(1);
  }
  const { app } = (await res.json()) as { app: { id: string; displayName: string } };

  out.success(`Created app "${app.displayName}"`);
  console.log(`  App ID:  ${app.id}`);
  console.log('');

  // Write-back: project overlay (if one exists yet) + the global config,
  // so the appId resolves next run too.
  if (project) {
    writeGuueyJsonFile(guueyJsonPath, { ...project, appId: app.id });
    console.log(`  Wrote appId back to ${GUUEY_JSON_FILENAME}`);
  } else {
    // No project file to bind — persist the id as the machine-global
    // default so the next projectless run resolves. Said LOUDLY (guuey#355
    // ask 3): a quietly-written global default is how a later deploy from
    // an unrelated checkout nearly targeted the live Helper. Bound
    // projects never touch the operator's global config.
    const existing = loadConfig();
    existing.appId = app.id;
    saveConfig(existing);
    console.log(
      '  Wrote appId to ~/.guuey/config.json as the GLOBAL default (used only in directories with no guuey.json binding).',
    );
  }

  return app.id;
}

/**
 * Step 1 of the deploy orchestrator (design doc §7.1): resolve the linked
 * app, or — on a first run with none — offer to create one right here.
 *
 * Mirrors `apps.ts#appsCreate` (POST /apps, persist to the global CLI
 * config), writing the new appId back into the project overlay too, so a
 * fresh `@guuey/create-agentic-app` scaffold can go straight from `guuey
 * create` to `guuey deploy` with no separate `guuey apps create` step.
 *
 * Returns the resolved appId; exits the process on API failure.
 */
async function ensureLinkedApp(opts: {
  auth: AuthTokens;
  config: ResolvedConfig;
  project: ProjectConfig | null;
  guueyJsonPath: string;
}): Promise<string> {
  const { auth, config, project, guueyJsonPath } = opts;
  if (config.appId) return config.appId;

  console.log('');
  console.log('  No app linked yet.');
  const defaultName = readPackageName(process.cwd()) ?? 'My Agent';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let appName: string;
  try {
    const answer = await prompt(rl, `  App name [${defaultName}]: `);
    appName = answer.trim() || defaultName;
  } finally {
    rl.close();
  }

  return createLinkedApp({ auth, config, project, guueyJsonPath, appName });
}

// ─── Code mode: one-command orchestrator ──────────────────────────────────

/**
 * The orchestrated code-mode deploy (design doc §7): MCP legs → ggui leg →
 * build-then-pack agent leg. Requires a `guuey.json` — the config that
 * drives every leg (hosted-MCP entries, the ggui asset dir, the snapshot
 * shipped alongside the tarball).
 */
async function deployCode(opts: {
  auth: AuthTokens;
  config: ResolvedConfig;
  appId: string;
  guueyJsonPath: string;
  root: string;
  size: string;
  buildSize: string;
  maxPods: number | undefined;
  runtimeAutoUpdate?: boolean | undefined;
  label: string | undefined;
  force: boolean;
  flags?: Record<string, string | true>;
}): Promise<void> {
  const { auth, config, appId, guueyJsonPath, root, size, buildSize, maxPods, runtimeAutoUpdate, label, force, flags } =
    opts;

  console.log('');
  console.log('  Deploying agent to guuey cloud...');
  console.log('');

  // ── Load guuey.json + validate ──
  let loaded: ResolvedGuueyJson;
  try {
    loaded = loadGuueyJson(guueyJsonPath);
  } catch (err) {
    out.error(
      `Failed to load ${GUUEY_JSON_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  let doc: GuueyJsonV1 = loaded.doc;

  const secretViolations = validateNoLiteralSecrets(doc.agent);
  if (secretViolations.length > 0) {
    out.error(
      'Found literal secrets in mcpServers[].headers:\n' +
        secretViolations.map((s) => `  - ${s}`).join('\n') +
        '\nDeclare the secret name in agent.secrets and reference it as ${env.NAME}.',
    );
    process.exit(1);
  }

  // A colocated server's name becomes a URL path segment + KV scope key at
  // pod boot (`lowerColocated` -> `colocatedResourceUrl`) — catch an invalid
  // one HERE, before upload, instead of letting it surface only as an
  // unactionable POD_FATAL_BOOT_ERROR crash-loop.
  const colocatedNameViolations = validateColocatedServerNames(doc.agent);
  if (colocatedNameViolations.length > 0) {
    out.error(colocatedNameViolations.map((v) => `  - ${v}`).join('\n'));
    process.exit(1);
  }

  // guuey#234: tool-gate entries must parse the config grammar and name servers
  // this agent connects — caught HERE, before upload; the alternative is a
  // mis-spelled tool surfacing at turn time inside a headless pod.
  const toolGateViolations = validateToolGates(doc.agent);
  if (toolGateViolations.length > 0) {
    out.error(
      'Invalid tools.allowlist / tools.denylist entries:\n' +
        toolGateViolations.map((v) => `  - ${v}`).join('\n') +
        '\nUse "<server>.<tool>", "<server>.*", or a bare tool name.',
    );
    process.exit(1);
  }

  // ── Step 2: MCP legs ──
  // Re-deploys of an entry that already has `server` still run — the
  // backend reuse-or-creates by name, so this ships a new version of the
  // SAME server. Write-backs are facts, applied immediately per leg (not
  // staged), so a later leg's failure never loses an earlier leg's result.
  const legs = planMcpLegs(doc.agent);
  const mcpRuntimeUrls: Record<string, string | undefined> = {};
  if (legs.length > 0) {
    const workspaceId =
      doc.workspaceId ?? (await resolveWorkspaceId(flags, process.env, { auth, config }));
    if (!workspaceId) {
      out.error(
        'Hosted MCP servers need a workspace. Set guuey.json#workspaceId (via "guuey pull"), ' +
          'pass --workspace <id>, or set GUUEY_WORKSPACE.',
      );
      process.exit(1);
    }

    for (const leg of legs) {
      const dir = join(root, leg.source);
      const name = resolveServerName(undefined, readPackageName(dir)) ?? leg.name;
      console.log(`  MCP "${leg.name}" (${leg.source}) → deploying as "${name}"...`);
      try {
        // eslint-disable-next-line no-await-in-loop -- MCP legs deploy sequentially by design (each write-back must land before the next leg starts).
        const result = await deployMcpFromSource({ dir, name, workspaceId, auth, config });
        doc = writeBackServerId(doc, leg.name, result.serverId);
        writeGuueyJsonFile(guueyJsonPath, doc);
        mcpRuntimeUrls[leg.name] = result.runtimeUrl;
      } catch (err) {
        out.error(
          `MCP "${leg.name}" failed to deploy: ${err instanceof Error ? err.message : String(err)}`,
        );
        console.log(`  Run "guuey mcp logs ${leg.name}" for the captured build output.`);
        process.exit(1);
      }
    }
  }

  // ── Step 3: ggui asset leg ──
  if (doc.ggui?.configFile) {
    let body: GguiAssetPushBody;
    try {
      body = await buildGguiAssetPush(root, doc.ggui.configFile);
    } catch (err) {
      out.error(`Failed to pack ggui assets: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    try {
      const result = await pushGguiAssetsLeg({ appId, body, auth, config });
      if (!result.pushed) {
        console.log(
          '  ggui assets not pushed — the leg is not yet armed on this environment; deploy continues',
        );
      }
    } catch (err) {
      out.error(`ggui asset push failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // ── Step 4: agent leg (last) — build, THEN pack ──
  console.log('  Building...');
  try {
    execSync('corepack pnpm build', { cwd: root, stdio: 'inherit' });
  } catch {
    out.error('Build failed ("corepack pnpm build" exited non-zero). Fix the error above and retry.');
    process.exit(1);
  }

  // Hard gate BEFORE packing: a build misconfiguration (wrong tsup entry,
  // missing noExternal, etc.) must never silently ship a tarball with no
  // worker in it — the deploy-controller would fall back to a host default,
  // and the pod would come up running the wrong (or no) agent code.
  //
  // `guuey.json#worker` is the template-authored override for a non-default
  // build output path, honored by the runtime's worker-select. Mirrors
  // `dev.ts`'s worker-entry resolution.
  // Graceful projects (guuey.json#agent.entry, no #worker) build the agent
  // MODULE instead of a worker bundle — gate on that file instead.
  const workerField = doc.worker;
  const expectedOut = workerField ?? doc.agent?.entry ?? 'guuey.worker.js';
  const workerEntryPath = join(root, expectedOut);
  if (!existsSync(workerEntryPath)) {
    out.error(
      `Build succeeded but ${workerEntryPath} was not produced. Check the root ` +
        `"build" script (expected to emit ${expectedOut} via tsup) and retry.`,
    );
    process.exit(1);
  }

  const buildId = randomUUID().slice(0, 12);
  const { tarballPath, tarballSize, sourceHash } = packSource({
    buildId,
    cwd: root,
    includeWorkingTree: true,
  });

  const uploadRes = await apiRequest(auth.pat, config, 'POST', `/apps/${appId}/deploy/upload`, {
    buildId,
    size,
    contentLength: tarballSize,
    sourceHash,
  });

  if (!force && uploadRes.status === 304) {
    console.log('');
    out.success('Nothing to deploy. Agent is up to date.');
    cleanup(tarballPath);
    return;
  }

  if (!uploadRes.ok) {
    const data: unknown = await uploadRes.json().catch(() => ({}));
    out.error(parseApiError(data, `Upload failed: HTTP ${uploadRes.status}`));
    cleanup(tarballPath);
    process.exit(1);
  }

  const { uploadUrl, uploadId, buildNumber } = (await uploadRes.json()) as {
    uploadUrl: string;
    uploadId: string;
    buildNumber: number;
  };

  const fileBuffer = readFileSync(tarballPath);
  const uploadToS3 = await fetch(uploadUrl, {
    method: 'PUT',
    body: fileBuffer,
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(tarballSize),
    },
  });

  if (!uploadToS3.ok) {
    out.error(`S3 upload failed: HTTP ${uploadToS3.status}`);
    cleanup(tarballPath);
    process.exit(1);
  }

  // Assert every hosted mcpServers entry resolved before shipping the
  // snapshot — a throw here means an MCP leg was skipped without a
  // write-back landing, which "should never happen" given the loop above,
  // but the deploy-controller would otherwise boot a pod that can't reach
  // the server, so this stays a hard client-side gate.
  let resolvedDoc: GuueyJsonV1;
  try {
    resolvedDoc = snapshotWithServerIds(doc);
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    cleanup(tarballPath);
    process.exit(1);
  }
  const snapshotConfig = JSON.stringify(buildDeploySnapshot({ ...loaded, doc: resolvedDoc }));

  console.log('  Building & deploying...');
  const runtimePinBefore = await captureRuntimePin(auth.pat, config, appId);
  const deployRes = await apiRequest(auth.pat, config, 'POST', `/apps/${appId}/deploy/trigger`, {
    deploymentId: buildId,
    buildNumber,
    size,
    buildSize,
    sourceHash,
    sourceTarballKey: `${appId}/${uploadId}.tar.gz`,
    agentMode: 'code',
    snapshotConfig,
    ...(label ? { versionLabel: label } : {}),
    ...(maxPods !== undefined ? { maxPods } : {}),
    ...(runtimeAutoUpdate !== undefined ? { runtimeAutoUpdate } : {}),
  });

  if (deployRes.status !== 202) {
    const data = (await deployRes.json().catch(() => ({}))) as { retryAfterSeconds?: number };
    if (deployRes.status === 429) {
      const secs = Number(data.retryAfterSeconds ?? deployRes.headers.get('Retry-After') ?? 0);
      const when = secs > 0 ? ` Retry in ~${Math.ceil(secs / 60)} minute(s).` : '';
      out.error(`${parseApiError(data, 'Build quota exceeded.')}${when}`);
    } else {
      out.error(parseApiError(data, `Deploy trigger failed: HTTP ${deployRes.status}`));
    }
    cleanup(tarballPath);
    process.exit(1);
  }

  printTriggerWarnings(await deployRes.clone().json().catch(() => ({})));

  const streamAbort = new AbortController();
  void attachBuildLogStream(auth.pat, config, appId, buildNumber, streamAbort.signal).catch(
    (e) => {
      if (process.env.GGUI_DEBUG) console.error(`  [stream] ${String(e)}`);
    },
  );

  const { status, url, pageUrl: polledPageUrl } = await pollDeployStatus({
    auth,
    config,
    appId,
    buildNumber,
    timeoutMs: 22 * 60 * 1000,
    tarballPath,
  });
  streamAbort.abort();
  cleanup(tarballPath);

  if (status === 'superseded') {
    console.log('');
    out.error('Deployment superseded by a newer deploy. Run "guuey deploy" again if needed.');
    process.exit(1);
  }
  if (status === 'failed') {
    console.log('');
    out.error('Deployment failed. Run "guuey deployments list" for details.');
    process.exit(1);
  }

  // ── Step 5: output ──
  console.log('');
  out.success(`Live at ${url}`);
  printPageLine(await awaitPageUrl({ auth, config, appId, buildNumber, pageUrl: polledPageUrl }));
  await maybePrintRuntimePinNotice(auth.pat, config, appId, runtimePinBefore);
  console.log('');
  console.log(`  Build:  #${buildNumber}${label ? ` (${label})` : ''}`);
  console.log(`  Size:   runtime=${size}, build=${buildSize}`);
  if (maxPods !== undefined) console.log(`  Pods:   max=${maxPods}`);
  printPodLifetime(maxPods);
  console.log('');
  const portal = portalLine(config.host, appId);
  if (portal) console.log(`  Portal: ${portal}`);
  if (Object.keys(mcpRuntimeUrls).length > 0) {
    console.log('');
    console.log('  Hosted MCP servers:');
    for (const [name, runtimeUrl] of Object.entries(mcpRuntimeUrls)) {
      console.log(`    ${name}: ${runtimeUrl ?? '(runtime URL not yet available)'}`);
    }
  }
  console.log('');
}

/**
 * Poll `GET /apps/:id/deployments/:n/status` to a terminal status. Shared by
 * every deploy path (code-orchestrated, legacy-Dockerfile, declarative).
 *
 * The route + response shape MUST match the real handler
 * (`backend/amplify/functions/cliApi/handler.ts` route table +
 * `handlers/deploy.ts#handleGetDeploymentStatus`'s projection):
 * `/apps/:id/deployments/:n/status` (NOT `/deploy/status/:n` — that route
 * doesn't exist), returning `endpointUrl`/`errorMessage` (NOT `url`/`error`).
 *
 * `tarballPath` is optional — code-mode callers pass it so a timeout/error
 * cleans up the tarball; the declarative path has no tarball to clean up.
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection (mirrors `deployMcpFromSource`'s `deps.api` seam in `commands/mcp.ts`).
 */

/**
 * The pinned-redeploy notice (runtime-update-channel §10.1, founder-
 * ratified): "redeploy refreshes the pin" stays one rule — AND the
 * builder is told when their pinned app's runtime moved because of it.
 * Best-effort on both legs (a notice must never fail a deploy): capture
 * the pre-deploy state before the trigger, compare after live.
 */
async function captureRuntimePin(
  pat: string,
  config: { apiUrl?: string },
  appId: string,
): Promise<{ pinned: boolean; digest: string | null } | undefined> {
  try {
    const res = await apiRequest(pat, config, 'GET', `/apps/${appId}/config`);
    if (!res.ok) return undefined;
    const wire = (await res.json()) as { runtimeAutoUpdate?: boolean; runtimeImageDigest?: string | null };
    return { pinned: wire.runtimeAutoUpdate === false, digest: wire.runtimeImageDigest ?? null };
  } catch {
    return undefined;
  }
}

async function maybePrintRuntimePinNotice(
  pat: string,
  config: { apiUrl?: string },
  appId: string,
  before: { pinned: boolean; digest: string | null } | undefined,
): Promise<void> {
  if (!before?.pinned || !before.digest) return;
  const after = await captureRuntimePin(pat, config, appId);
  if (!after?.digest || after.digest === before.digest) return;
  console.log('');
  console.log(
    `  Note: this app pins its runtime, and this deploy refreshed the pin — ` +
      `runtime updated from ${before.digest.slice(0, 19)}… to ${after.digest.slice(0, 19)}….`,
  );
}

export async function pollDeployStatus(
  opts: {
    auth: { pat: string };
    config: { apiUrl?: string };
    appId: string;
    buildNumber: number;
    timeoutMs: number;
    tarballPath?: string;
  },
  deps?: { api?: typeof apiRequest },
): Promise<{ status: string; url: string; pageUrl: string | null }> {
  const api = deps?.api ?? apiRequest;
  const { auth, config, appId, buildNumber, timeoutMs, tarballPath } = opts;
  let status = 'queued';
  let url = '';
  let pageUrl: string | null = null;
  let lastMessage = '';
  const startTime = Date.now();

  while (status !== 'live' && status !== 'failed' && status !== 'superseded') {
    if (Date.now() - startTime > timeoutMs) {
      out.error(`Deploy timed out after ${Math.round(timeoutMs / 60000)} minutes.`);
      if (tarballPath) cleanup(tarballPath);
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, 3000));

    const statusRes = await api(
      auth.pat,
      config,
      'GET',
      `/apps/${appId}/deployments/${buildNumber}/status`,
    );
    if (!statusRes.ok) {
      if (process.env.GGUI_DEBUG) {
        const errBody = await statusRes.text().catch(() => '');
        console.error(`  [poll] HTTP ${statusRes.status}: ${errBody.slice(0, 100)}`);
      }
      continue;
    }

    const data = (await statusRes.json()) as DeploymentStatusPoll;

    // Progress is DIAGNOSTICS, not data — stderr, always (guuey#280 CI
    // find, 2026-08-21): under `--json` these lines used to hit stdout and
    // corrupt the one-JSON-document contract (`agent apply --wait --json >
    // file` carried 'Queued...' beside the payload, killing the helper
    // CI's jq step). stderr keeps interactive UX identical and json-mode
    // stdout machine-clean, with no mode flag to thread.
    if (data.status === 'queued' && lastMessage !== 'Queued...') {
      console.error('  Queued...');
      lastMessage = 'Queued...';
    } else if (data.message && data.message !== lastMessage) {
      console.error(`  ${data.message}`);
      lastMessage = data.message;
    }

    status = data.status;
    if (data.endpointUrl) url = data.endpointUrl;
    if (data.pageUrl) pageUrl = data.pageUrl;
    if (data.errorMessage) {
      out.error(data.errorMessage);
      if (tarballPath) cleanup(tarballPath);
      process.exit(1);
    }
  }

  return { status, url, pageUrl };
}

/**
 * The status projection's fields this loop reads — a strict subset of the
 * server's `DeploymentStatusWire` (`backend/libs/cli-wire/deploy.ts`).
 * `pageUrl` (guuey#249) is the APP's standalone page, server-composed from
 * its slug; the CLI prints it verbatim and never derives the slug host.
 */
interface DeploymentStatusPoll {
  status: string;
  message?: string;
  endpointUrl?: string | null;
  errorMessage?: string | null;
  pageUrl?: string | null;
}

/** How long {@link awaitPageUrl} re-reads after Live before giving up. */
export const PAGE_URL_WAIT_MS = 12_000;
const PAGE_URL_TICK_MS = 2_000;

/**
 * The app's page URL after a Live — read back from the status projection,
 * never computed here (guuey#249).
 *
 * The platform claims an app's DEFAULT slug server-side, on the
 * `AgentDeployment` row's first `→ live` edge (the deployStream Lambda), so
 * on a FIRST deploy the poll that sees `live` can land a second or two
 * before the slug does. This re-reads the same status route until `pageUrl`
 * is non-null or {@link PAGE_URL_WAIT_MS} passes; a redeploy of a slugged
 * app returns immediately (the poll already carried it). `null` after the
 * wait means "no page to print" — the deploy is still a success, and the
 * builder can `guuey slug claim` (or `guuey apps get` a moment later).
 */
export async function awaitPageUrl(
  opts: {
    auth: { pat: string };
    config: { apiUrl?: string };
    appId: string;
    buildNumber: number;
    /** What the poll loop already saw — returned as-is when non-null. */
    pageUrl: string | null;
    waitMs?: number;
  },
  deps?: { api?: typeof apiRequest; sleep?: (ms: number) => Promise<void> },
): Promise<string | null> {
  if (opts.pageUrl) return opts.pageUrl;
  const api = deps?.api ?? apiRequest;
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.waitMs ?? PAGE_URL_WAIT_MS);
  while (Date.now() < deadline) {
    await sleep(PAGE_URL_TICK_MS);
    const res = await api(
      opts.auth.pat,
      opts.config,
      'GET',
      `/apps/${opts.appId}/deployments/${opts.buildNumber}/status`,
    );
    if (!res.ok) continue;
    const data = (await res.json()) as DeploymentStatusPoll;
    if (data.pageUrl) return data.pageUrl;
  }
  return null;
}

/**
 * The one "Your agent's page" line every deploy surface prints after Live
 * (guuey#249). Prints nothing when there is no page to print — never a
 * guessed URL.
 */
export function printPageLine(pageUrl: string | null): void {
  if (pageUrl) console.log(`  Your agent's page: ${pageUrl}`);
}

// ─── Legacy code mode: user-committed Dockerfile, no guuey.json ─────────
//
// Preserved unchanged from the pre-orchestrator implementation for the
// (untested, unused-in-repo) case of a root Dockerfile with no guuey.json
// at all — so there is no guuey.json to load, no MCP/ggui legs to run, and
// no framework worker to build. `agentMode: 'code'` is now sent explicitly
// (previously implicit via the backend's own default) for parity with
// `deployCode`; `snapshotConfig` is omitted since there is nothing to
// snapshot.

async function deployLegacyDockerfile(opts: {
  auth: AuthTokens;
  config: ResolvedConfig;
  appId: string;
  size: string;
  buildSize: string;
  maxPods: number | undefined;
  runtimeAutoUpdate?: boolean | undefined;
  label: string | undefined;
  force: boolean;
}): Promise<void> {
  const { auth, config, appId, size, buildSize, maxPods, runtimeAutoUpdate, label, force } = opts;

  console.log('');
  console.log('  Deploying agent to guuey cloud...');
  console.log('');

  const buildId = randomUUID().slice(0, 12);
  const { tarballPath, tarballSize, sourceHash } = packSource({
    buildId,
    cwd: process.cwd(),
  });

  const uploadRes = await apiRequest(auth.pat, config, 'POST', `/apps/${appId}/deploy/upload`, {
    buildId,
    size,
    contentLength: tarballSize,
    sourceHash,
  });

  if (!force && uploadRes.status === 304) {
    console.log('');
    out.success('Nothing to deploy. Agent is up to date.');
    cleanup(tarballPath);
    return;
  }

  if (!uploadRes.ok) {
    const data: unknown = await uploadRes.json().catch(() => ({}));
    out.error(parseApiError(data, `Upload failed: HTTP ${uploadRes.status}`));
    cleanup(tarballPath);
    process.exit(1);
  }

  const { uploadUrl, uploadId, buildNumber } = (await uploadRes.json()) as {
    uploadUrl: string;
    uploadId: string;
    buildNumber: number;
  };

  const fileBuffer = readFileSync(tarballPath);
  const uploadToS3 = await fetch(uploadUrl, {
    method: 'PUT',
    body: fileBuffer,
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(tarballSize),
    },
  });

  if (!uploadToS3.ok) {
    out.error(`S3 upload failed: HTTP ${uploadToS3.status}`);
    cleanup(tarballPath);
    process.exit(1);
  }

  console.log('  Building & deploying...');
  const runtimePinBefore = await captureRuntimePin(auth.pat, config, appId);
  const deployRes = await apiRequest(auth.pat, config, 'POST', `/apps/${appId}/deploy/trigger`, {
    deploymentId: buildId,
    buildNumber,
    size,
    buildSize,
    sourceHash,
    sourceTarballKey: `${appId}/${uploadId}.tar.gz`,
    agentMode: 'code',
    ...(label ? { versionLabel: label } : {}),
    ...(maxPods !== undefined ? { maxPods } : {}),
    ...(runtimeAutoUpdate !== undefined ? { runtimeAutoUpdate } : {}),
  });

  if (deployRes.status !== 202) {
    const data = (await deployRes.json().catch(() => ({}))) as { retryAfterSeconds?: number };
    if (deployRes.status === 429) {
      const secs = Number(data.retryAfterSeconds ?? deployRes.headers.get('Retry-After') ?? 0);
      const when = secs > 0 ? ` Retry in ~${Math.ceil(secs / 60)} minute(s).` : '';
      out.error(`${parseApiError(data, 'Build quota exceeded.')}${when}`);
    } else {
      out.error(parseApiError(data, `Deploy trigger failed: HTTP ${deployRes.status}`));
    }
    cleanup(tarballPath);
    process.exit(1);
  }

  const streamAbort = new AbortController();
  void attachBuildLogStream(auth.pat, config, appId, buildNumber, streamAbort.signal).catch(
    (e) => {
      if (process.env.GGUI_DEBUG) console.error(`  [stream] ${String(e)}`);
    },
  );

  const { status, url, pageUrl: polledPageUrl } = await pollDeployStatus({
    auth,
    config,
    appId,
    buildNumber,
    timeoutMs: 22 * 60 * 1000,
    tarballPath,
  });
  streamAbort.abort();
  cleanup(tarballPath);

  if (status === 'superseded') {
    console.log('');
    out.error('Deployment superseded by a newer deploy. Run "guuey deploy" again if needed.');
    process.exit(1);
  }

  if (status === 'failed') {
    console.log('');
    out.error('Deployment failed. Run "guuey deployments list" for details.');
    process.exit(1);
  }

  console.log('');
  out.success(`Live at ${url}`);
  printPageLine(await awaitPageUrl({ auth, config, appId, buildNumber, pageUrl: polledPageUrl }));
  await maybePrintRuntimePinNotice(auth.pat, config, appId, runtimePinBefore);
  console.log('');
  console.log(`  Build:  #${buildNumber}${label ? ` (${label})` : ''}`);
  console.log(`  Size:   runtime=${size}, build=${buildSize}`);
  if (maxPods !== undefined) console.log(`  Pods:   max=${maxPods}`);
  printPodLifetime(maxPods);
  console.log('');
}

/**
 * Declarative deploy path: skips tarball + S3 + Kaniko build entirely.
 * Loads guuey.json, inlines `agent.systemPrompt.file` references, and
 * POSTs the resolved snapshot (whole guuey.json document) to the trigger
 * endpoint. The control plane writes an AgentDeployment with
 * `agentMode='nocode'` + a JSON-stringified `snapshotConfig`; the stock
 * nocode-runtime pod reads the snapshot at boot and runs the framework
 * adapter with no per-agent image build.
 *
 * Status polling re-uses the same `/deployments/:n/status` endpoint as
 * code-mode; the controller surfaces 'live' once the pod is ready.
 */
async function deployDeclarative(opts: {
  auth: { pat: string };
  config: { apiUrl?: string };
  appId: string;
  guueyJsonPath: string;
  size: string;
  maxPods: number | undefined;
  runtimeAutoUpdate?: boolean | undefined;
  label: string | undefined;
}): Promise<void> {
  const { auth, config, appId, guueyJsonPath, size, maxPods, runtimeAutoUpdate, label } = opts;

  console.log('');
  console.log('  Deploying declarative agent to guuey cloud...');
  console.log('');

  // 1. Load + validate guuey.json + build deploy snapshot
  //    (inlines `agent.systemPrompt.file` references into the resolved string).
  let resolved: ResolvedGuueyJson;
  try {
    resolved = loadGuueyJson(guueyJsonPath);
  } catch (err) {
    out.error(
      `Failed to load ${GUUEY_JSON_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const snapshot = buildDeploySnapshot(resolved);
  const agent = snapshot.agent;

  // Reject literal secrets in mcpServers[].headers before upload — they'd ride
  // into the pod's config as plaintext. The backend re-checks authoritatively;
  // this is the fast, friendly client-side guard.
  const secretViolations = validateNoLiteralSecrets(agent);
  if (secretViolations.length > 0) {
    out.error(
      'Found literal secrets in mcpServers[].headers:\n' +
        secretViolations.map((s) => `  - ${s}`).join('\n') +
        '\nDeclare the secret name in agent.secrets and reference it as ${env.NAME}.',
    );
    process.exit(1);
  }

  // Same colocated-server-name gate as the code-orchestrated path (see
  // deployCode) — the declarative path skips the build/pack pipeline but
  // still ships a snapshot the pod's `lowerColocated` will crash-loop on
  // if a colocated name is invalid.
  const colocatedNameViolations = validateColocatedServerNames(agent);
  if (colocatedNameViolations.length > 0) {
    out.error(colocatedNameViolations.map((v) => `  - ${v}`).join('\n'));
    process.exit(1);
  }

  // Same tool-gate grammar gate as the code-orchestrated path (guuey#234).
  const toolGateViolations = validateToolGates(agent);
  if (toolGateViolations.length > 0) {
    out.error(
      'Invalid tools.allowlist / tools.denylist entries:\n' +
        toolGateViolations.map((v) => `  - ${v}`).join('\n') +
        '\nUse "<server>.<tool>", "<server>.*", or a bare tool name.',
    );
    process.exit(1);
  }

  const systemPromptLen =
    typeof agent.systemPrompt === 'string' ? agent.systemPrompt.length : 0;
  // `declaredServerEntries` drops the `ggui: false` opt-out — it is not a
  // configured server, and listing it here would read as "ggui is on".
  const mcpServers = agent.mcpServers
    ? declaredServerEntries(agent.mcpServers).map(([name]) => name).join(', ') || '(none — ggui disabled)'
    : 'ggui (default)';
  console.log(`  framework:    ${agent.framework ?? 'claude-agent-sdk (default)'}`);
  console.log(`  model:        ${agent.model ?? '(framework default)'}`);
  console.log(`  systemPrompt: ${systemPromptLen} chars`);
  console.log(`  mcpServers:   ${mcpServers}`);
  console.log('');

  // 2. POST the trigger directly. No tarball, no upload step.
  const deploymentId = randomUUID().slice(0, 12);
  const runtimePinBefore = await captureRuntimePin(auth.pat, config, appId);
  const triggerRes = await apiRequest(auth.pat, config, 'POST', `/apps/${appId}/deploy/trigger`, {
    deploymentId,
    size,
    agentMode: 'nocode',
    snapshotConfig: snapshot,
    ...(label ? { versionLabel: label } : {}),
    ...(maxPods !== undefined ? { maxPods } : {}),
    ...(runtimeAutoUpdate !== undefined ? { runtimeAutoUpdate } : {}),
  });

  if (triggerRes.status !== 202) {
    const data = (await triggerRes.json().catch(() => ({}))) as { retryAfterSeconds?: number };
    if (triggerRes.status === 429) {
      const secs = Number(
        data.retryAfterSeconds ?? triggerRes.headers.get('Retry-After') ?? 0,
      );
      const when = secs > 0 ? ` Retry in ~${Math.ceil(secs / 60)} minute(s).` : '';
      out.error(`${parseApiError(data, 'Deploy quota exceeded.')}${when}`);
    } else {
      out.error(parseApiError(data, `Deploy trigger failed: HTTP ${triggerRes.status}`));
    }
    process.exit(1);
  }

  const { buildNumber } = (await triggerRes.json()) as { buildNumber: number };

  // 3. Poll for live (no Kaniko log stream — declarative deploys skip the
  //    build; no tarball either, so `pollDeployStatus` gets no tarballPath).
  console.log('  Provisioning pod...');
  // Declarative deploys skip the build entirely, so the deploy/readiness
  // budget alone applies. 5 min readiness + slack ≈ 7 min ceiling.
  const { status, url, pageUrl: polledPageUrl } = await pollDeployStatus({
    auth,
    config,
    appId,
    buildNumber,
    timeoutMs: 7 * 60 * 1000,
  });

  if (status === 'superseded') {
    console.log('');
    out.error('Deployment superseded by a newer deploy. Run "guuey deploy" again if needed.');
    process.exit(1);
  }

  if (status === 'failed') {
    console.log('');
    out.error('Deployment failed. Run "guuey deployments list" for details.');
    process.exit(1);
  }

  console.log('');
  out.success(`Live at ${url}`);
  printPageLine(await awaitPageUrl({ auth, config, appId, buildNumber, pageUrl: polledPageUrl }));
  await maybePrintRuntimePinNotice(auth.pat, config, appId, runtimePinBefore);
  console.log('');
  console.log(`  Build:  #${buildNumber}${label ? ` (${label})` : ''}`);
  console.log(`  Size:   runtime=${size}`);
  if (maxPods !== undefined) console.log(`  Pods:   max=${maxPods}`);
  console.log('  Stock nocode-runtime pod.');
  printPodLifetime(maxPods);
  console.log('');
}

/**
 * Mint a stream-token and pipe the controller's chunked Kaniko output to
 * stdout. Retries the token mint a few times because the build Job is
 * created asynchronously by the controller — the first calls after trigger
 * will 404 with "No active build Job" until the reconciler picks up the
 * queued record and creates the Kaniko Job.
 *
 * Silent on failure: the status poll loop remains the user-visible source
 * of truth. Streaming is a DX enhancement, not the contract.
 */
async function attachBuildLogStream(
  pat: string,
  config: { apiUrl?: string },
  appId: string,
  buildNumber: number,
  signal: AbortSignal,
): Promise<void> {
  // Retry the token mint for ~30s — ample time for the controller to claim
  // + create Job. After that, assume a no-code deploy / rollback where no
  // Kaniko Job exists at all; drop out silently.
  let streamUrl: string | null = null;
  const tokenDeadline = Date.now() + 30_000;
  while (!streamUrl && Date.now() < tokenDeadline && !signal.aborted) {
    const res = await apiRequest(
      pat,
      config,
      'POST',
      `/apps/${appId}/deploy/build-logs/${buildNumber}/stream-token`,
    );
    if (res.ok) {
      const body = (await res.json()) as { streamUrl?: string };
      if (body.streamUrl) streamUrl = body.streamUrl;
    }
    if (!streamUrl) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!streamUrl) return;
  if (signal.aborted) return;

  const streamRes = await fetch(streamUrl, { signal });
  if (!streamRes.ok || !streamRes.body) return;

  console.log('');
  console.log('  ── build logs ──');

  // `Response.body` is a web ReadableStream of Uint8Array. Decode + tee to
  // stdout line-by-line so colors/ANSI from Kaniko/pnpm render correctly
  // and partial lines at the chunk boundary don't print as two.
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) console.log(`  │ ${line}`);
      }
    }
    if (buffer.length > 0) console.log(`  │ ${buffer}`);
  } catch {
    // Client-side abort (poll loop ended) or network hiccup — stay silent.
  } finally {
    console.log('  ── end build logs ──');
    console.log('');
  }
}
