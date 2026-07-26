/**
 * ggui asset leg — pack a project's `ggui/` dir into a `GguiAssetBundle` and
 * push it to the cliApi control plane (create-agentic-app T14/T15).
 *
 * Design doc `2026-07-03-guuey-create-agentic-app-design.md` §8: the deploy
 * orchestrator (`commands/deploy.ts`, Step 3 — after MCP legs, before the
 * agent leg) calls {@link packGguiAssets} then {@link pushGguiAssetsLeg}.
 * The push endpoint is env-dormant until ggui lands the asset route and an
 * operator sets the route-specific `GGUI_ASSETS_PUSH_API_URL` on cliApi
 * (deliberately unset everywhere; the shared `GGUI_PROVISIONING_API_URL`
 * does NOT arm this route). Dormant, it returns the flat
 * `501 {code:'not-yet-supported'}` — the ONLY response the CLI treats as
 * warn-and-continue. Every other error, including any other 501, aborts
 * the deploy before the agent leg runs (§7 ordering).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import type { AuthTokens } from './auth';
import type { ResolvedConfig } from './config';
import { apiRequest, parseApiError } from './deploy-shared';

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
 * The exact dormancy-501 shape the backend returns
 * (`httpJson(501, {code:'not-yet-supported', message})` in
 * `ggui-assets.ts`'s `handleGguiAssetsPush`) — a deliberate non-error
 * signal, distinct from a real 501 `GuueyError` (which serializes nested,
 * `{error:{code,message}}`, per `httpError`).
 */
function isDormancy501(data: unknown): data is { code: string; message?: string } {
  if (data === null || typeof data !== 'object') return false;
  const rec = data as Record<string, unknown>;
  return (
    rec.code === 'not-yet-supported' &&
    (rec.message === undefined || typeof rec.message === 'string')
  );
}

/**
 * Push a packed {@link GguiAssetBundle} to
 * `POST /v1/apps/:id/ggui-assets/push`.
 *
 * - `200` → `{ pushed: true }`.
 * - `501 {code:'not-yet-supported'}` (env-dormant on the backend until
 *   ggui's provisioning API is wired) → `{ pushed: false, reason }`, NOT a
 *   throw — this is the warn-and-continue leg, distinct from a real error.
 * - Any other non-2xx, INCLUDING a 501 that isn't the exact dormancy shape
 *   above → throws. A 501 is only ever a signal we've defined ourselves;
 *   any other code on that status is unexpected and must abort the deploy
 *   rather than silently continue.
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

  const data: unknown = await res.json().catch(() => ({}));

  if (res.status === 501 && isDormancy501(data)) {
    return {
      pushed: false,
      reason: data.message ?? 'ggui asset push is not yet enabled on this environment.',
    };
  }

  throw new Error(parseApiError(data, `ggui asset push failed: HTTP ${res.status}`));
}
