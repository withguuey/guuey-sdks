/**
 * Shared deploy plumbing — source-packing + authenticated REST helpers used
 * by both `guuey deploy` (code mode) and `guuey mcp deploy`.
 *
 * Both commands run the same tarball→presigned-S3-PUT→trigger→poll flow; the
 * only difference is the endpoint surface (app-scoped vs workspace-scoped).
 * The packing routine (workspace-dep BFS + tar/git-archive creation + sha256)
 * lives here so neither caller duplicates it.
 */

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

/**
 * `tar --exclude` flags shared by every non-git-archive packing path
 * (working-tree tar, and both tar fallbacks). `.env*` (glob, not the
 * previous exact-match `.env`) so `.env.local`/`.env.production` etc. never
 * land in a tarball; `.npmrc` is a registry-token carrier; `.guuey-dev` and
 * `*.tsbuildinfo` are dev/build artifacts that don't belong in a deploy
 * either.
 */
const WORKING_TREE_TAR_EXCLUDES =
  "--exclude=node_modules --exclude=dist --exclude=.git --exclude='.env*' --exclude=.npmrc --exclude=.guuey-dev --exclude='*.tsbuildinfo' --exclude=.ggui --exclude=.guuey";

/** Result of packing a project's source into an upload-ready tarball. */
export interface PackResult {
  /** Absolute path of the gzip tarball on disk (caller must `cleanup`). */
  tarballPath: string;
  /** Tarball size in bytes (used for `contentLength`). */
  tarballSize: number;
  /** SHA-256 hex digest of the tarball buffer. */
  sourceHash: string;
}

/**
 * Pack the project at `cwd` into a gzip source tarball ready for upload.
 *
 * Resolves `workspace:*` dependencies by packing each into a local tarball
 * (`pnpm pack`) and rewriting the package.json refs to `file:./.ggui-deps/*`,
 * so the remote Docker build can `npm ci` without the pnpm workspace. When
 * there are no workspace deps, ships committed files via `git archive`
 * (fastest), falling back to a `tar` of the tree — UNLESS `includeWorkingTree`
 * is set (see below).
 *
 * `includeWorkingTree` (opt-in, default `false`): tars the actual working
 * tree instead of `git archive`'s committed-files-only snapshot. The
 * code-orchestrated agent leg (`commands/deploy.ts`) needs this — it builds
 * `guuey.worker.js` locally right before packing, and the scaffold's
 * `.gitignore` ignores that build artifact, so `git archive HEAD` would ship
 * a tarball with no worker in it. SECURITY-CRITICAL: this path excludes
 * `.env*`, `.npmrc`, `node_modules`, `.git`, `.guuey-dev`, `dist`, and
 * `*.tsbuildinfo` explicitly — a working-tree tar is the one packing path
 * that could otherwise leak an uncommitted local secret file into a build
 * image.
 *
 * Behavior is byte-identical to the logic that was previously inline in
 * `deploy()` — this is a pure extraction so `guuey mcp deploy` can reuse it.
 */
export function packSource(opts: {
  buildId: string;
  cwd: string;
  /** Tar the working tree instead of `git archive` (committed-only). Default `false`. */
  includeWorkingTree?: boolean;
}): PackResult {
  const { buildId, cwd, includeWorkingTree = false } = opts;
  const tarballPath = join(tmpdir(), `ggui-deploy-${buildId}.tar.gz`);

  console.log('  Packaging source...');
  // Check for uncommitted changes — committed-files-only packing paths only.
  // A working-tree run ships uncommitted files by design, so this warning
  // would state the opposite of reality there.
  if (!includeWorkingTree) {
    try {
      const status = execSync('git status --porcelain', { encoding: 'utf-8', cwd });
      if (status.trim()) {
        console.log('  Warning: uncommitted changes detected — only committed files will be deployed.');
      }
    } catch {
      // Not a git repo — fallback to tar
    }
  }

  // Resolve workspace:* dependencies — pack them as local tarballs so the
  // remote Docker build can install them without access to the pnpm workspace.
  const stagingDir = join(tmpdir(), `ggui-deploy-staging-${buildId}`);
  mkdirSync(stagingDir, { recursive: true });
  const pkgJsonPath = join(cwd, 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  let hasWorkspaceDeps = false;

  // The legacy (non-orchestrated) code-mode deploy requires a user-committed
  // Dockerfile — default-Dockerfile injection was retired with
  // @ggui-ai/build-templates, and mode detection by the caller already
  // proved one exists, so this is a defensive log line only. It does NOT
  // apply to the code-orchestrated agent leg (`includeWorkingTree`): that
  // shape is built from guuey's own Kaniko Dockerfile template, so there is
  // no user Dockerfile in play, and printing this line there would be false.
  if (!includeWorkingTree) {
    console.log("  Using your project's Dockerfile.");
  }

  // Build a {pkgName → sourceDir} map for every workspace package in the
  // monorepo so we can recursively resolve transitive workspace deps. Without
  // this, a packed @ggui-ai/server still references @ggui-ai/protocol@0.0.2
  // at a real version number (pnpm pack converts workspace:* → version), and
  // npm tries to fetch that from the public registry where it isn't published.
  const workspaceMap = discoverWorkspacePackages(cwd);

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
        `rsync -a --exclude=node_modules --exclude=dist --exclude=.git --exclude='.env*' --exclude=.guuey-dev --exclude='*.tsbuildinfo' --exclude=.ggui --exclude=.guuey . "${stagingDir}/"`,
        { stdio: 'pipe', cwd },
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
    } else if (includeWorkingTree) {
      // Opt-in working-tree tar (see doc comment) — NOT git archive, so
      // uncommitted/gitignored files (e.g. the freshly built
      // `guuey.worker.js`) are included. SECURITY-CRITICAL: exclude secrets
      // and build/dev artifacts explicitly, since this is the one packing
      // path that ships more than `git archive`'s committed-files snapshot.
      execSync(`tar czf "${tarballPath}" ${WORKING_TREE_TAR_EXCLUDES} .`, { stdio: 'pipe', cwd });
    } else {
      // User has their own Dockerfile and no workspace deps — git archive
      // is fastest (only ships committed files). CRITICAL: run git archive
      // to a temp tar FIRST (not piped into gzip) — a `git archive | gzip`
      // pipeline masks git's failure behind gzip's success and silently
      // writes a 0-byte tarball. Verify a non-empty result before trusting
      // it; otherwise fall back to a working-tree tar (covers non-git dirs
      // and repos with no HEAD — e.g. a freshly scaffolded `--no-git` app).
      let archived = false;
      try {
        execSync(`git rev-parse --verify HEAD`, { stdio: 'pipe', cwd });
        execSync(`git archive --format=tar.gz -o "${tarballPath}" HEAD`, {
          stdio: 'pipe',
          cwd,
        });
        archived = statSync(tarballPath).size > 0;
      } catch {
        archived = false;
      }
      if (!archived) {
        execSync(`tar czf "${tarballPath}" ${WORKING_TREE_TAR_EXCLUDES} .`, { stdio: 'pipe', cwd });
      }
    }
  } catch {
    // Fallback: use tar directly
    execSync(`tar czf "${tarballPath}" ${WORKING_TREE_TAR_EXCLUDES} .`, { stdio: 'pipe', cwd });
  }

  const tarballBuffer = readFileSync(tarballPath);
  const tarballSize = tarballBuffer.length;
  const sourceHash = createHash('sha256').update(tarballBuffer).digest('hex');
  console.log(`  Packaged ${(tarballSize / 1024).toFixed(0)} KB`);

  return { tarballPath, tarballSize, sourceHash };
}

/** Remove the temporary tarball file, ignoring errors. */
export function cleanup(tarballPath: string): void {
  try {
    unlinkSync(tarballPath);
  } catch {
    /* ignore */
  }
}

/**
 * Parse a cliApi error response body into a human-readable message.
 *
 * `backend/amplify/functions/shared/response.ts#httpError` serializes every
 * error NESTED — `{ error: { code, message } }` — but every CLI call site
 * used to read `data.error` as though it were a flat string, which prints
 * `[object Object]` on every real API error. This is the one parser every
 * caller should use: it tries the nested `{error:{message}}` shape first,
 * then a flat `{error: string}` shape (for any legacy/ad-hoc response that
 * isn't `httpError`-shaped), then a top-level `message` field, and finally
 * falls back to the caller-supplied default (typically `HTTP <status>`).
 */
export function parseApiError(data: unknown, fallback: string): string {
  if (data === null || typeof data !== 'object') return fallback;
  const record = data as Record<string, unknown>;
  const err = record.error;
  if (err !== null && typeof err === 'object') {
    const nested = (err as Record<string, unknown>).message;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  if (typeof err === 'string' && err.length > 0) return err;
  if (typeof record.message === 'string' && record.message.length > 0) return record.message;
  return fallback;
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
export async function apiRequest(
  pat: string,
  config: { apiUrl?: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  if (!config.apiUrl) {
    throw new Error('REST API URL not configured. Ensure amplify_outputs.json is present or set GUUEY_API_URL.');
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
