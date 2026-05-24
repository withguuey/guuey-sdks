/**
 * guuey deploy -- Package, upload, and deploy an agent to guuey cloud.
 *
 * Two deploy modes, auto-detected from the project root:
 *
 *   1. **Declarative** — repo has an `agent.json`, no `Dockerfile`.
 *      No tarball, no build. The agent.json snapshot (system prompt
 *      inlined) is POSTed directly to the control plane and the stock
 *      `nocode-runtime` pod boots off it.
 *   2. **Code** — repo has a `Dockerfile`. The CLI packs the source
 *      tree, uploads to S3, triggers a Kaniko build, and the resulting
 *      image runs as the agent. agent.json is ignored if also present
 *      unless `--declarative` is passed.
 *
 * Detection precedence:
 *   - `--declarative` flag    → force declarative (errors if no agent.json)
 *   - `--code` flag           → force code (errors if no Dockerfile)
 *   - else: agent.json + no Dockerfile → declarative
 *   - else: Dockerfile present         → code
 *   - else: error (need one or the other)
 *
 * Usage:
 *   guuey deploy                 # Auto-detect mode
 *   guuey deploy --declarative   # Force declarative (uses agent.json)
 *   guuey deploy --code          # Force code-mode (uses Dockerfile)
 *   guuey deploy --size sm       # Override runtime pod size
 *   guuey deploy --build-size lg # Override build Job size (code mode only)
 *   guuey deploy --force         # Force deploy even if no changes detected
 *
 * Flow (code mode):
 *   1. Create tarball of source code (via git archive or tar fallback)
 *   2. Get presigned S3 upload URL from API
 *   3. Upload tarball to S3
 *   4. Trigger deployment
 *   5. Poll for completion
 *
 * Flow (declarative mode):
 *   1. Load + validate agent.json via @guuey/config
 *   2. POST snapshot to /deploy/trigger with agentMode='nocode'
 *   3. Poll for completion
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, renameSync, existsSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  AGENT_JSON_FILENAME,
  loadAgentJson,
  type ResolvedAgentJson,
} from '@guuey/config';
import { requireAuth } from '../auth';
import { resolveConfig, loadProjectConfig } from '../config';
import * as out from '../output';

/**
 * Handle the `guuey deploy` command.
 *
 * Packages the current project as a tarball, uploads it to S3 via
 * a presigned URL, triggers a deployment, and polls until the agent
 * is live or the deployment fails.
 *
 * @param flags - CLI flags (e.g., `{ size: 'sm', target: 'ggui' }`)
 */
export async function deploy(flags?: Record<string, string | true>): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const project = loadProjectConfig();

  const appId = config.appId;
  if (!appId) {
    out.error('No app ID found. Run "guuey create" or "guuey link" first.');
    process.exit(1);
  }

  // `deploy.size` on the canonical overlay is the app-level default
  // for new deploys. `buildSize` is a per-invocation flag only per
  // §8.4 (not overlay material). `target` is implicitly `'guuey'` on
  // every record the closed CLI writes — overlay-explicit target
  // selection is a future additive if non-Guuey hosted targets land.
  const size = (flags?.size as string) ?? project?.deploy?.size ?? 'sm';
  const buildSize = (flags?.['build-size'] as string) ?? 'md';
  const target = (flags?.target as string) ?? 'ggui';
  const label = flags?.label as string | undefined;

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

  // ── Mode detection ──────────────────────────────────────────────────
  // Declarative mode: agent.json present + no Dockerfile (or --declarative).
  // Code mode: Dockerfile present (or --code).
  // The two modes share size/label/poll plumbing but diverge on packaging.
  const forceDeclarative = flags?.declarative === true;
  const forceCode = flags?.code === true;
  if (forceDeclarative && forceCode) {
    out.error('Cannot pass both --declarative and --code. Pick one.');
    process.exit(1);
  }
  const cwdAgentJson = join(process.cwd(), AGENT_JSON_FILENAME);
  const cwdDockerfile = join(process.cwd(), 'Dockerfile');
  const hasAgentJson = existsSync(cwdAgentJson);
  const hasDockerfile = existsSync(cwdDockerfile);

  let mode: 'declarative' | 'code';
  if (forceDeclarative) {
    if (!hasAgentJson) {
      out.error(
        `--declarative requires an ${AGENT_JSON_FILENAME} in the project root.`,
      );
      process.exit(1);
    }
    mode = 'declarative';
  } else if (forceCode) {
    if (!hasDockerfile) {
      out.error('--code requires a Dockerfile in the project root.');
      process.exit(1);
    }
    mode = 'code';
  } else if (hasAgentJson && !hasDockerfile) {
    mode = 'declarative';
  } else if (hasDockerfile) {
    if (hasAgentJson) {
      console.log(
        `  Both Dockerfile and ${AGENT_JSON_FILENAME} found — using Dockerfile (code mode).`,
      );
      console.log('  Pass --declarative to use agent.json instead.');
    }
    mode = 'code';
  } else {
    out.error(
      `No ${AGENT_JSON_FILENAME} or Dockerfile found in the project root.\n` +
        `  - Declarative agents: add an ${AGENT_JSON_FILENAME}.\n` +
        '  - Code-mode agents: commit a Dockerfile.',
    );
    process.exit(1);
  }

  if (mode === 'declarative') {
    await deployDeclarative({
      auth,
      config,
      appId,
      agentJsonPath: cwdAgentJson,
      size,
      label,
    });
    return;
  }

  console.log('');
  console.log('  Deploying agent to guuey cloud...');
  console.log('');

  // 1. Create tarball of source code
  const buildId = randomUUID().slice(0, 12);
  const tarballPath = join(tmpdir(), `ggui-deploy-${buildId}.tar.gz`);

  console.log('  Packaging source...');
  // Check for uncommitted changes
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8', cwd: process.cwd() });
    if (status.trim()) {
      console.log('  Warning: uncommitted changes detected — only committed files will be deployed.');
    }
  } catch {
    // Not a git repo — fallback to tar
  }

  // Resolve workspace:* dependencies — pack them as local tarballs so the
  // remote Docker build can install them without access to the pnpm workspace.
  const stagingDir = join(tmpdir(), `ggui-deploy-staging-${buildId}`);
  mkdirSync(stagingDir, { recursive: true });
  const pkgJsonPath = join(process.cwd(), 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  let hasWorkspaceDeps = false;

  // Code-mode deploy requires a user-committed Dockerfile. Default-Dockerfile
  // injection was retired with @ggui-ai/build-templates. Mode detection above
  // already proved Dockerfile exists; this is a defensive log line only.
  console.log("  Using your project's Dockerfile.");

  // Build a {pkgName → sourceDir} map for every workspace package in the
  // monorepo so we can recursively resolve transitive workspace deps. Without
  // this, a packed @ggui-ai/server still references @ggui-ai/protocol@0.0.2
  // at a real version number (pnpm pack converts workspace:* → version), and
  // npm tries to fetch that from the public registry where it isn't published.
  const workspaceMap = discoverWorkspacePackages(process.cwd());

  // BFS: pack direct workspace deps, inspect each packed tarball for
  // transitive workspace deps, queue those too.
  const packedByName = new Map<string, string>();
  const queue: string[] = [];
  for (const depType of ['dependencies', 'devDependencies'] as const) {
    const deps = pkgJson[depType] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (version.startsWith('workspace:')) queue.push(name);
    }
  }

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (packedByName.has(name)) continue;
    const sourceDir = workspaceMap.get(name);
    if (!sourceDir) {
      console.warn(`  Warning: workspace dep ${name} not found in monorepo`);
      continue;
    }
    try {
      const packOutput = execSync(`pnpm pack --pack-destination "${stagingDir}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        cwd: sourceDir,
      }).trim();
      const tgzName = packOutput.split('\n').pop()!.trim();
      const tgzBase = basename(tgzName);
      packedByName.set(name, tgzBase);
      console.log(`  Packed workspace dep: ${name} → ${tgzBase}`);
      hasWorkspaceDeps = true;

      const packedPkgJson = JSON.parse(
        execSync(`tar -xOzf "${join(stagingDir, tgzBase)}" package/package.json`, {
          encoding: 'utf-8',
          stdio: 'pipe',
        }),
      );
      for (const depType of ['dependencies', 'peerDependencies'] as const) {
        const deps = packedPkgJson[depType] as Record<string, string> | undefined;
        if (!deps) continue;
        for (const depName of Object.keys(deps)) {
          if (workspaceMap.has(depName) && !packedByName.has(depName)) {
            queue.push(depName);
          }
        }
      }
    } catch (err) {
      console.warn(`  Warning: failed to pack ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (hasWorkspaceDeps) {
    // Rewrite top-level deps to file: refs.
    for (const depType of ['dependencies', 'devDependencies'] as const) {
      const deps = pkgJson[depType] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [name, version] of Object.entries(deps)) {
        if (!version.startsWith('workspace:')) continue;
        const tgz = packedByName.get(name);
        if (tgz) deps[name] = `file:./.ggui-deps/${tgz}`;
      }
    }
    // Overrides force npm to resolve transitive workspace deps to our packed
    // tarballs too (e.g. @ggui-ai/server → @ggui-ai/protocol dep).
    const overrides = (pkgJson.overrides ??= {}) as Record<string, string>;
    for (const [name, tgz] of packedByName) {
      overrides[name] = `file:./.ggui-deps/${tgz}`;
    }
  }

  // Staging path is only needed when packing workspace deps — user always
  // commits their own Dockerfile (no injection path).
  const useStagingPath = hasWorkspaceDeps;

  // Create the tarball — use tar (not git archive) to include staged workspace deps
  try {
    if (useStagingPath) {
      // rsync FIRST, so our later writes (modified package.json, generated
      // package-lock.json) are not clobbered by the source's workspace:*
      // package.json.
      execSync(
        `rsync -a --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env --exclude=.ggui --exclude=.guuey . "${stagingDir}/"`,
        { stdio: 'pipe', cwd: process.cwd() },
      );
      // Move packed tarballs to .ggui-deps/ inside staging
      mkdirSync(join(stagingDir, '.ggui-deps'), { recursive: true });
      for (const f of readdirSync(stagingDir)) {
        if (f.endsWith('.tgz')) {
          renameSync(join(stagingDir, f), join(stagingDir, '.ggui-deps', f));
        }
      }
      if (hasWorkspaceDeps) {
        // Now write the modified package.json (with file:./.ggui-deps/*.tgz
        // refs + overrides) and generate its matching lockfile. Order matters
        // — must be after rsync so rsync doesn't overwrite it.
        writeFileSync(join(stagingDir, 'package.json'), JSON.stringify(pkgJson, null, 2));
        try {
          execSync('npm install --package-lock-only --ignore-scripts --legacy-peer-deps 2>/dev/null', {
            stdio: 'pipe',
            cwd: stagingDir,
          });
        } catch {
          // lockfile gen may warn but still produce a valid file
        }
      }
      execSync(`tar czf "${tarballPath}" -C "${stagingDir}" .`, { stdio: 'pipe' });
    } else {
      // User has their own Dockerfile and no workspace deps — git archive
      // is fastest (only ships committed files).
      try {
        execSync(`git archive --format=tar HEAD | gzip > "${tarballPath}"`, {
          stdio: 'pipe',
          cwd: process.cwd(),
        });
      } catch {
        execSync(
          `tar czf "${tarballPath}" --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env --exclude=.ggui --exclude=.guuey .`,
          { stdio: 'pipe', cwd: process.cwd() },
        );
      }
    }
  } catch {
    // Fallback: use tar directly
    execSync(
      `tar czf "${tarballPath}" --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env --exclude=.ggui --exclude=.guuey .`,
      { stdio: 'pipe', cwd: process.cwd() },
    );
  }

  const tarballBuffer = readFileSync(tarballPath);
  const tarballSize = tarballBuffer.length;
  const sourceHash = createHash('sha256').update(tarballBuffer).digest('hex');
  console.log(`  Packaged ${(tarballSize / 1024).toFixed(0)} KB`);

  // 2. Check for changes + get presigned upload URL
  const force = flags?.force === true;
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
    const data = (await uploadRes.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Upload failed: HTTP ${uploadRes.status}`);
    cleanup(tarballPath);
    process.exit(1);
  }

  const { uploadUrl, uploadId, buildNumber } = (await uploadRes.json()) as {
    uploadUrl: string;
    uploadId: string;
    buildNumber: number;
  };

  // 3. Upload tarball to S3 via presigned URL
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

  // 4. Trigger deploy
  console.log('  Building & deploying...');
  const deployRes = await apiRequest(auth.pat, config, 'POST', `/apps/${appId}/deploy/trigger`, {
    deploymentId: buildId,
    buildNumber,
    size,
    buildSize,
    sourceHash,
    sourceTarballKey: `${appId}/${uploadId}.tar.gz`,
    ...(label ? { versionLabel: label } : {}),
  });

  if (deployRes.status !== 202) {
    const data = (await deployRes.json().catch(() => ({}))) as Record<string, string | number>;
    if (deployRes.status === 429) {
      // Quota hit — show the reason + a Retry-After hint if we got one.
      const secs = Number(data.retryAfterSeconds ?? deployRes.headers.get('Retry-After') ?? 0);
      const when = secs > 0 ? ` Retry in ~${Math.ceil(secs / 60)} minute(s).` : '';
      out.error(`${data.error ?? 'Build quota exceeded.'}${when}`);
    } else {
      out.error(String(data.error ?? `Deploy trigger failed: HTTP ${deployRes.status}`));
    }
    cleanup(tarballPath);
    process.exit(1);
  }

  // 5. Stream build logs inline (best-effort) while polling for completion.
  // The log-stream attach may fail (controller not ready, Job not yet
  // scheduled) — the background poller is authoritative for deploy outcome,
  // so a stream failure never blocks the deploy itself.
  const streamAbort = new AbortController();
  void attachBuildLogStream(auth.pat, config, appId, buildNumber, streamAbort.signal).catch(
    (e) => {
      if (process.env.GGUI_DEBUG) console.error(`  [stream] ${String(e)}`);
    },
  );

  let status = 'queued';
  let url = '';
  let lastMessage = '';
  const startTime = Date.now();
  // Controller budgets: 15 min build + 5 min readiness + slack. Must stay
  // >= backend's sum or the CLI will report failure on a build the backend
  // still considers valid. See reconcile-one.ts BUILD_TIMEOUT_MS + DEPLOY_TIMEOUT_MS.
  const TIMEOUT_MS = 22 * 60 * 1000; // 22 minutes

  while (status !== 'live' && status !== 'failed' && status !== 'superseded') {
    if (Date.now() - startTime > TIMEOUT_MS) {
      out.error('Deploy timed out after 22 minutes.');
      cleanup(tarballPath);
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, 3000));

    const statusRes = await apiRequest(
      auth.pat,
      config,
      'GET',
      `/apps/${appId}/deploy/status/${buildNumber}`,
    );
    if (!statusRes.ok) {
      // Debug: log non-200 responses during polling
      const errBody = await statusRes.text().catch(() => '');
      if (process.env.GGUI_DEBUG) console.error(`  [poll] HTTP ${statusRes.status}: ${errBody.slice(0, 100)}`);
      continue;
    }

    const data = (await statusRes.json()) as {
      status: string;
      message?: string;
      url?: string;
      error?: string;
    };

    if (data.status === 'queued' && lastMessage !== 'Queued...') {
      console.log('  Queued...');
      lastMessage = 'Queued...';
    } else if (data.message && data.message !== lastMessage) {
      console.log(`  ${data.message}`);
      lastMessage = data.message;
    }

    status = data.status;
    if (data.url) url = data.url;
    if (data.error) {
      out.error(data.error);
      cleanup(tarballPath);
      process.exit(1);
    }
  }

  // Stop following the Kaniko log stream — the poll loop is authoritative.
  streamAbort.abort();

  // 6. Done
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
 * Loads agent.json, inlines `systemPrompt.file` references, and POSTs
 * the resolved snapshot to the trigger endpoint. The control plane
 * writes an AgentDeployment with `agentMode='nocode'` + a JSON-stringified
 * `snapshotConfig`; the stock nocode-runtime pod reads the snapshot at
 * boot and runs the framework adapter with no per-agent image build.
 *
 * Status polling re-uses the same `/deployments/:n/status` endpoint as
 * code-mode; the controller surfaces 'live' once the pod is ready.
 */
async function deployDeclarative(opts: {
  auth: { pat: string };
  config: { apiUrl?: string };
  appId: string;
  agentJsonPath: string;
  size: string;
  label: string | undefined;
}): Promise<void> {
  const { auth, config, appId, agentJsonPath, size, label } = opts;

  console.log('');
  console.log('  Deploying declarative agent to guuey cloud...');
  console.log('');

  // 1. Load + validate agent.json (inlines systemPrompt.file refs).
  let snapshot: ResolvedAgentJson;
  try {
    snapshot = loadAgentJson(agentJsonPath);
  } catch (err) {
    out.error(
      `Failed to load ${AGENT_JSON_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const systemPromptLen = snapshot.systemPrompt?.length ?? 0;
  const mcpServers = snapshot.mcpServers
    ? Object.keys(snapshot.mcpServers).join(', ')
    : 'ggui (default)';
  console.log(`  framework:    ${snapshot.framework ?? 'claude-agent-sdk (default)'}`);
  console.log(`  model:        ${snapshot.model ?? '(framework default)'}`);
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
    const data = (await triggerRes.json().catch(() => ({}))) as Record<
      string,
      string | number
    >;
    if (triggerRes.status === 429) {
      const secs = Number(
        data.retryAfterSeconds ?? triggerRes.headers.get('Retry-After') ?? 0,
      );
      const when = secs > 0 ? ` Retry in ~${Math.ceil(secs / 60)} minute(s).` : '';
      out.error(`${data.error ?? 'Deploy quota exceeded.'}${when}`);
    } else {
      out.error(String(data.error ?? `Deploy trigger failed: HTTP ${triggerRes.status}`));
    }
    process.exit(1);
  }

  const { buildNumber } = (await triggerRes.json()) as { buildNumber: number };

  // 3. Poll for live (no Kaniko log stream — declarative deploys skip the build).
  console.log('  Provisioning pod...');
  let status = 'queued';
  let url = '';
  let lastMessage = '';
  const startTime = Date.now();
  // Declarative deploys skip the build entirely, so the deploy/readiness
  // budget alone applies. 5 min readiness + slack ≈ 7 min ceiling.
  const TIMEOUT_MS = 7 * 60 * 1000;

  while (status !== 'live' && status !== 'failed' && status !== 'superseded') {
    if (Date.now() - startTime > TIMEOUT_MS) {
      out.error('Deploy timed out after 7 minutes.');
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, 3000));

    const statusRes = await apiRequest(
      auth.pat,
      config,
      'GET',
      `/apps/${appId}/deploy/status/${buildNumber}`,
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
      url?: string;
      error?: string;
    };

    if (data.status === 'queued' && lastMessage !== 'Queued...') {
      console.log('  Queued...');
      lastMessage = 'Queued...';
    } else if (data.message && data.message !== lastMessage) {
      console.log(`  ${data.message}`);
      lastMessage = data.message;
    }

    status = data.status;
    if (data.url) url = data.url;
    if (data.error) {
      out.error(data.error);
      process.exit(1);
    }
  }

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

/** Remove the temporary tarball file, ignoring errors. */
function cleanup(tarballPath: string): void {
  try {
    unlinkSync(tarballPath);
  } catch {
    /* ignore */
  }
}

/**
 * Walk up from `startDir` to find `pnpm-workspace.yaml`, then enumerate
 * every package.json under the common workspace top-levels and return a
 * `{ pkgName → absolute dir }` map. Used by the deploy packer to resolve
 * transitive workspace deps (e.g. @ggui-ai/server → @ggui-ai/protocol)
 * so the remote `npm ci` can install them from packed tarballs.
 */
function discoverWorkspacePackages(startDir: string): Map<string, string> {
  const map = new Map<string, string>();
  let dir = startDir;
  let root: string | null = null;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      root = dir;
      break;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  if (!root) return map;

  const candidates = ['packages', 'core', 'cloud', 'agents', 'internal'];
  for (const top of candidates) {
    const topDir = join(root, top);
    if (!existsSync(topDir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(topDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgDir = join(topDir, entry);
      const pkgJsonPath = join(pkgDir, 'package.json');
      try {
        if (!statSync(pkgDir).isDirectory()) continue;
        if (!existsSync(pkgJsonPath)) continue;
        const pj = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        if (typeof pj.name === 'string') map.set(pj.name, pkgDir);
      } catch {
        // ignore
      }
    }
  }
  return map;
}

/** Make an authenticated JSON request to the CLI API. */
async function apiRequest(
  pat: string,
  config: { apiUrl?: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  if (!config.apiUrl) {
    throw new Error('REST API URL not configured. Ensure amplify_outputs.json is present or set GGUI_API_URL.');
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
