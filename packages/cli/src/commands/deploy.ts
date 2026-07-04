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
 *   guuey deploy --size sm       # Override runtime pod size
 *   guuey deploy --build-size lg # Override build Job size (code mode only)
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
  writeGuueyJsonFile,
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
import {
  planMcpLegs,
  writeBackServerId,
  snapshotWithServerIds,
  resolveDeployMode,
  shouldOfferAppCreate,
} from '../deploy-plan';
import { packGguiAssets, pushGguiAssetsLeg } from '../ggui-assets';
import * as out from '../output';

const DEFAULT_PORTAL_URL = 'https://app.guuey.com';

/**
 * Handle the `guuey deploy` command.
 *
 * @param flags - CLI flags (e.g., `{ size: 'sm', target: 'ggui' }`)
 */
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
  let appId = config.appId;
  if (!appId) {
    if (shouldOfferAppCreate(mode, process.stdin.isTTY, process.stdout.isTTY)) {
      appId = await ensureLinkedApp({ auth, config, project, guueyJsonPath: cwdGuueyJson });
      // ensureLinkedApp may have written `appId` into guuey.json — reload so
      // downstream reads (deploy.size default, etc.) see it.
      project = loadProjectConfig();
    } else {
      out.error('No app ID found. Run "guuey create" or "guuey link" first.');
      process.exit(1);
    }
  }

  // `deploy.size` on the canonical overlay is the app-level default
  // for new deploys. `buildSize` is a per-invocation flag only per
  // §8.4 (not overlay material). `target` is implicitly `'guuey'` on
  // every record the closed CLI writes — overlay-explicit target
  // selection is a future additive if non-Guuey hosted targets land.
  const size = (flags?.size as string) ?? project?.agent?.deploy?.size ?? 'sm';
  const buildSize = (flags?.['build-size'] as string) ?? 'md';
  const target = (flags?.target as string) ?? 'ggui';
  const label = flags?.label as string | undefined;
  const force = flags?.force === true;

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
      label,
      force,
      flags,
    });
  } else {
    await deployLegacyDockerfile({ auth, config, appId, size, buildSize, label, force });
  }
}

// ─── Preflight: first-run app create + link write-back ───────────────────

/** Prompt for a single line of input via readline. */
function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((res) => rl.question(question, res));
}

/**
 * Step 1 of the deploy orchestrator (design doc §7.1): resolve the linked
 * app, or — on a first run with none — offer to create one right here.
 *
 * Mirrors `apps.ts#appsCreate` (POST /apps, persist to the global CLI
 * config) and `link.ts` (write the new appId back into the project
 * overlay), so a fresh `@guuey/create-agentic-app` scaffold can go straight
 * from `guuey create` to `guuey deploy` with no separate `guuey create
 * <app>`/`guuey link` step.
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

  console.log('  Creating platform app...');
  const res = await apiRequest(auth.pat, config, 'POST', '/apps', {
    name: appName,
    userAuthMode: 'anonymous',
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    out.error(`Failed to create app: ${parseApiError(data, `HTTP ${res.status}`)}`);
    process.exit(1);
  }
  const data = (await res.json()) as { appId: string; apiKey: string };

  out.success(`Created app "${appName}"`);
  console.log(`  App ID:  ${data.appId}`);
  console.log('');

  // Write-back: project overlay (if one exists yet) + the global config —
  // mirrors link.ts's dual write so the appId resolves next run too.
  if (project) {
    writeGuueyJsonFile(guueyJsonPath, { ...project, appId: data.appId });
    console.log(`  Wrote appId back to ${GUUEY_JSON_FILENAME}`);
  }
  const existing = loadConfig();
  existing.appId = data.appId;
  existing.apiKey = data.apiKey;
  saveConfig(existing);

  return data.appId;
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
  label: string | undefined;
  force: boolean;
  flags?: Record<string, string | true>;
}): Promise<void> {
  const { auth, config, appId, guueyJsonPath, root, size, buildSize, label, force, flags } = opts;

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

  // ── Step 2: MCP legs ──
  // Re-deploys of an entry that already has `server` still run — the
  // backend reuse-or-creates by name, so this ships a new version of the
  // SAME server. Write-backs are facts, applied immediately per leg (not
  // staged), so a later leg's failure never loses an earlier leg's result.
  const legs = planMcpLegs(doc.agent);
  const mcpRuntimeUrls: Record<string, string | undefined> = {};
  if (legs.length > 0) {
    const workspaceId = doc.workspaceId ?? resolveWorkspaceId(flags, process.env);
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
        console.log('  Run "guuey deployments logs <buildNumber>" for details.');
        process.exit(1);
      }
    }
  }

  // ── Step 3: ggui asset leg ──
  if (doc.ggui?.configFile) {
    let bundle: ReturnType<typeof packGguiAssets>;
    try {
      bundle = packGguiAssets(root, doc.ggui.configFile);
    } catch (err) {
      out.error(`Failed to pack ggui assets: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    try {
      const result = await pushGguiAssetsLeg({ appId, bundle, auth, config });
      if (!result.pushed) {
        console.log(
          '  ggui assets not pushed — the platform-side API is pending (tracked cross-team); deploy continues',
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
  // `guuey.json#worker` is a raw string field NOT in the canonical zod
  // schema (a template-authored override for a non-default build output
  // path, honored by the runtime's worker-select) — read the raw file
  // rather than the validated `doc`, which would strip an unrecognized
  // field under `strictObject`. Mirrors `dev.ts`'s worker-entry resolution.
  const rawDoc = JSON.parse(readFileSync(guueyJsonPath, 'utf8')) as Record<string, unknown>;
  const workerField =
    typeof rawDoc.worker === 'string' && rawDoc.worker.length > 0 ? rawDoc.worker : undefined;
  const workerEntryPath = join(root, workerField ?? 'guuey.worker.js');
  if (!existsSync(workerEntryPath)) {
    out.error(
      `Build succeeded but ${workerEntryPath} was not produced. Check the root ` +
        `"build" script (expected to emit ${workerField ?? 'guuey.worker.js'} via tsup) and retry.`,
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

  const { status, url } = await pollDeployStatus({
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
  console.log('');
  console.log(`  Build:  #${buildNumber}${label ? ` (${label})` : ''}`);
  console.log(`  Size:   runtime=${size}, build=${buildSize}`);
  console.log('  Scales to zero when idle.');
  console.log('');
  console.log(`  Portal: ${config.portalUrl ?? DEFAULT_PORTAL_URL}/${appId}`);
  if (Object.keys(mcpRuntimeUrls).length > 0) {
    console.log('');
    console.log('  Hosted MCP servers:');
    for (const [name, runtimeUrl] of Object.entries(mcpRuntimeUrls)) {
      console.log(`    ${name}: ${runtimeUrl ?? '(runtime URL not yet available)'}`);
    }
  }
  console.log('');
  console.log(`  Build logs retained for 30 days. View with \`guuey deployments logs ${buildNumber}\`.`);
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
): Promise<{ status: string; url: string }> {
  const api = deps?.api ?? apiRequest;
  const { auth, config, appId, buildNumber, timeoutMs, tarballPath } = opts;
  let status = 'queued';
  let url = '';
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

    const data = (await statusRes.json()) as {
      status: string;
      message?: string;
      endpointUrl?: string | null;
      errorMessage?: string | null;
    };

    if (data.status === 'queued' && lastMessage !== 'Queued...') {
      console.log('  Queued...');
      lastMessage = 'Queued...';
    } else if (data.message && data.message !== lastMessage) {
      console.log(`  ${data.message}`);
      lastMessage = data.message;
    }

    status = data.status;
    if (data.endpointUrl) url = data.endpointUrl;
    if (data.errorMessage) {
      out.error(data.errorMessage);
      if (tarballPath) cleanup(tarballPath);
      process.exit(1);
    }
  }

  return { status, url };
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
  label: string | undefined;
  force: boolean;
}): Promise<void> {
  const { auth, config, appId, size, buildSize, label, force } = opts;

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
  const deployRes = await apiRequest(auth.pat, config, 'POST', `/apps/${appId}/deploy/trigger`, {
    deploymentId: buildId,
    buildNumber,
    size,
    buildSize,
    sourceHash,
    sourceTarballKey: `${appId}/${uploadId}.tar.gz`,
    agentMode: 'code',
    ...(label ? { versionLabel: label } : {}),
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

  const { status, url } = await pollDeployStatus({
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
  console.log('');
  console.log(`  Build:  #${buildNumber}${label ? ` (${label})` : ''}`);
  console.log(`  Size:   runtime=${size}, build=${buildSize}`);
  console.log('  Scales to zero when idle.');
  console.log('');
  console.log(`  Build logs retained for 30 days. View with \`guuey deployments logs ${buildNumber}\`.`);
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
  label: string | undefined;
}): Promise<void> {
  const { auth, config, appId, guueyJsonPath, size, label } = opts;

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

  const systemPromptLen =
    typeof agent.systemPrompt === 'string' ? agent.systemPrompt.length : 0;
  const mcpServers = agent.mcpServers
    ? Object.keys(agent.mcpServers).join(', ')
    : 'ggui (default)';
  console.log(`  framework:    ${agent.framework ?? 'claude-agent-sdk (default)'}`);
  console.log(`  model:        ${agent.model ?? '(framework default)'}`);
  console.log(`  systemPrompt: ${systemPromptLen} chars`);
  console.log(`  mcpServers:   ${mcpServers}`);
  console.log('');

  // 2. POST the trigger directly. No tarball, no upload step.
  const deploymentId = randomUUID().slice(0, 12);
  const triggerRes = await apiRequest(auth.pat, config, 'POST', `/apps/${appId}/deploy/trigger`, {
    deploymentId,
    size,
    agentMode: 'nocode',
    snapshotConfig: snapshot,
    ...(label ? { versionLabel: label } : {}),
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
  const { status, url } = await pollDeployStatus({
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
  console.log('');
  console.log(`  Build:  #${buildNumber}${label ? ` (${label})` : ''}`);
  console.log(`  Size:   runtime=${size}`);
  console.log('  Stock nocode-runtime pod; scales to zero when idle.');
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
