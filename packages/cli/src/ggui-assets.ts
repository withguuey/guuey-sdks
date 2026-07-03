/**
 * ggui asset leg — pack a project's `ggui/` dir into a `GguiAssetBundle` and
 * push it to the cliApi control plane (create-agentic-app T14/T15).
 *
 * Design doc `2026-07-03-guuey-create-agentic-app-design.md` §8: the deploy
 * orchestrator (`commands/deploy.ts`, Step 3 — after MCP legs, before the
 * agent leg) calls {@link packGguiAssets} then {@link pushGguiAssetsLeg}.
 * The push endpoint is env-dormant until ggui's provisioning API is wired
 * (`GGUI_PROVISIONING_API_URL`), so it returns `501 {code:'not-yet-supported'}`
 * rather than a hard failure — the CLI is expected to warn and continue,
 * distinct from a real (non-2xx, non-501) error, which aborts the deploy
 * before the agent leg runs (§7 ordering).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import type { AuthTokens } from './auth';
import type { ResolvedConfig } from './config';
import { apiRequest } from './deploy-shared';

/**
 * Wire contract for `POST /v1/apps/:id/ggui-assets/push`. Mirrors
 * `backend/amplify/functions/shared/ggui-provisioning-client.ts`'s
 * `GguiAssetBundle` verbatim — duplicated here (not imported) because the
 * CLI is an OSS package (`@guuey/cli`) and cannot depend on the closed
 * backend (`@guuey-private/*`).
 */
export interface GguiAssetBundle {
  /** The project's `ggui.json` manifest content (utf8). */
  gguiJson: string;
  /** repo-relative under the ggui dir, utf8, forward-slash paths. */
  files: Array<{ path: string; content: string }>;
}

/** Total content cap (`gguiJson` + all `files[].content`, utf8 byte length). Matches the backend's own cap. */
const MAX_BUNDLE_BYTES = 1024 * 1024; // 1 MiB

/** Text-file extensions swept into the bundle; everything else (images, binaries, etc.) is skipped. */
const TEXT_EXTENSIONS = new Set(['.json', '.md', '.css']);

/** Recursively collect `{ path, content }` entries under `dir`, deterministically ordered. */
function walkAssetDir(dir: string, assetDir: string, skip: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const entries = readdirSync(dir).sort();
  for (const entry of entries) {
    // Skip dotfiles (`.gitkeep`, `.DS_Store`, `.git/`, etc.) — never part of the asset bundle.
    if (entry.startsWith('.')) continue;

    const full = join(dir, entry);
    if (full === skip) continue;

    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkAssetDir(full, assetDir, skip));
      continue;
    }
    if (!st.isFile()) continue;

    if (!TEXT_EXTENSIONS.has(extname(entry))) continue;

    const relPath = relative(assetDir, full).split(sep).join('/');
    out.push({ path: relPath, content: readFileSync(full, 'utf-8') });
  }
  return out;
}

/**
 * Pack a project's ggui assets into a {@link GguiAssetBundle}.
 *
 * `configFile` is `guuey.json#ggui.configFile` (e.g. `./ggui/ggui.json`);
 * the asset dir is its directory. Walks the asset dir recursively —
 * text-file allowlist (`.json .md .css`), skipping dotfiles/`.gitkeep` and
 * the manifest file itself (already carried as `gguiJson`). File ordering
 * is sorted for a deterministic bundle (stable diffs, stable hashing).
 *
 * Throws if `configFile` doesn't resolve to a real file, or if the total
 * utf8 byte length of `gguiJson` + every file's content exceeds the 1 MiB
 * cap the backend enforces (fail fast, client-side, before the network call).
 */
export function packGguiAssets(projectRoot: string, configFile: string): GguiAssetBundle {
  const gguiJsonPath = join(projectRoot, configFile);
  if (!existsSync(gguiJsonPath) || !statSync(gguiJsonPath).isFile()) {
    throw new Error(`ggui config file not found: ${configFile} (resolved to ${gguiJsonPath})`);
  }
  const gguiJson = readFileSync(gguiJsonPath, 'utf-8');
  const assetDir = dirname(gguiJsonPath);

  // Plain codepoint comparison (not `localeCompare`) so ordering is stable
  // across locales/ICU builds, not just within one machine.
  const files = walkAssetDir(assetDir, assetDir, gguiJsonPath).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  let totalBytes = Buffer.byteLength(gguiJson, 'utf8');
  for (const file of files) {
    totalBytes += Buffer.byteLength(file.content, 'utf8');
  }
  if (totalBytes > MAX_BUNDLE_BYTES) {
    throw new Error(`ggui asset bundle exceeds 1 MiB limit (got ${totalBytes} bytes)`);
  }

  return { gguiJson, files };
}

/**
 * Push a packed {@link GguiAssetBundle} to
 * `POST /v1/apps/:id/ggui-assets/push`.
 *
 * - `200` → `{ pushed: true }`.
 * - `501 {code:'not-yet-supported'}` (env-dormant on the backend until
 *   ggui's provisioning API is wired) → `{ pushed: false, reason }`, NOT a
 *   throw — this is the warn-and-continue leg, distinct from a real error.
 * - Any other non-2xx → throws.
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection — network stubbing without a live backend (mirrors
 * `deployMcpFromSource`'s `deps.api` seam in `commands/mcp.ts`).
 */
export async function pushGguiAssetsLeg(
  opts: {
    appId: string;
    bundle: GguiAssetBundle;
    auth: AuthTokens;
    config: ResolvedConfig;
  },
  deps?: { api?: typeof apiRequest },
): Promise<{ pushed: boolean; reason?: string }> {
  const api = deps?.api ?? apiRequest;
  const { appId, bundle, auth, config } = opts;

  const res = await api(auth.pat, config, 'POST', `/apps/${appId}/ggui-assets/push`, bundle);

  if (res.ok) {
    return { pushed: true };
  }

  if (res.status === 501) {
    const data = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    return {
      pushed: false,
      reason: data.message ?? 'ggui asset push is not yet enabled on this environment.',
    };
  }

  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  throw new Error(data.error ?? data.message ?? `ggui asset push failed: HTTP ${res.status}`);
}
