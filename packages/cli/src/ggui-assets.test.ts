import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { packGguiAssets, pushGguiAssetsLeg, type GguiAssetBundle } from './ggui-assets.js';
import type { AuthTokens } from './auth.js';
import type { ResolvedConfig } from './config.js';
import type { apiRequest } from './deploy-shared.js';

// ─── packGguiAssets ────────────────────────────────────────────────────────

describe('packGguiAssets', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ggui-assets-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Lay down the standard fixture: ggui.json + blueprints/hello.json + themes/default.json. */
  function writeFixture(): void {
    mkdirSync(join(root, 'ggui', 'blueprints'), { recursive: true });
    mkdirSync(join(root, 'ggui', 'themes'), { recursive: true });
    writeFileSync(join(root, 'ggui', 'ggui.json'), JSON.stringify({ appId: 'app-1' }));
    writeFileSync(
      join(root, 'ggui', 'blueprints', 'hello.json'),
      JSON.stringify({ blueprint: 'hello' }),
    );
    writeFileSync(
      join(root, 'ggui', 'themes', 'default.json'),
      JSON.stringify({ theme: 'default' }),
    );
  }

  it('reads gguiJson content and packs files as dir-relative forward-slash paths', () => {
    writeFixture();

    const bundle = packGguiAssets(root, './ggui/ggui.json');

    expect(bundle.gguiJson).toBe(JSON.stringify({ appId: 'app-1' }));
    expect(bundle.files).toEqual([
      { path: 'blueprints/hello.json', content: JSON.stringify({ blueprint: 'hello' }) },
      { path: 'themes/default.json', content: JSON.stringify({ theme: 'default' }) },
    ]);
  });

  it('orders files deterministically regardless of directory-listing order', () => {
    writeFixture();
    // Add more files so alphabetical vs. filesystem order could plausibly diverge.
    writeFileSync(join(root, 'ggui', 'themes', 'alt.json'), '{}');
    writeFileSync(join(root, 'ggui', 'blueprints', 'zzz.json'), '{}');
    writeFileSync(join(root, 'ggui', 'README.md'), '# notes');

    const bundle1 = packGguiAssets(root, './ggui/ggui.json');
    const bundle2 = packGguiAssets(root, './ggui/ggui.json');

    const paths = bundle1.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(bundle2.files.map((f) => f.path)).toEqual(paths);
  });

  it('skips dotfiles and .gitkeep', () => {
    writeFixture();
    writeFileSync(join(root, 'ggui', 'blueprints', '.gitkeep'), '');
    writeFileSync(join(root, 'ggui', '.DS_Store'), 'junk');

    const bundle = packGguiAssets(root, './ggui/ggui.json');

    expect(bundle.files.map((f) => f.path)).toEqual([
      'blueprints/hello.json',
      'themes/default.json',
    ]);
  });

  it('skips non-allowlisted extensions', () => {
    writeFixture();
    writeFileSync(join(root, 'ggui', 'blueprints', 'icon.png'), 'not-really-png-bytes');

    const bundle = packGguiAssets(root, './ggui/ggui.json');

    expect(bundle.files.map((f) => f.path)).toEqual([
      'blueprints/hello.json',
      'themes/default.json',
    ]);
  });

  it('includes .md and .css files', () => {
    writeFixture();
    writeFileSync(join(root, 'ggui', 'themes', 'style.css'), 'body { color: red; }');
    writeFileSync(join(root, 'ggui', 'README.md'), '# hi');

    const bundle = packGguiAssets(root, './ggui/ggui.json');

    expect(bundle.files.map((f) => f.path)).toEqual([
      'README.md',
      'blueprints/hello.json',
      'themes/default.json',
      'themes/style.css',
    ]);
  });

  it('throws when the ggui.json config file is missing', () => {
    mkdirSync(join(root, 'ggui'), { recursive: true });

    expect(() => packGguiAssets(root, './ggui/ggui.json')).toThrow(/ggui config file not found/);
  });

  it('throws when the total bundle exceeds the 1 MiB cap', () => {
    writeFixture();
    writeFileSync(join(root, 'ggui', 'blueprints', 'huge.json'), 'x'.repeat(1024 * 1024 + 1));

    expect(() => packGguiAssets(root, './ggui/ggui.json')).toThrow(/1 MiB/);
  });
});

// ─── pushGguiAssetsLeg ───────────────────────────────────────────────────

describe('pushGguiAssetsLeg', () => {
  const auth: AuthTokens = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config: ResolvedConfig = { host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' };
  const bundle: GguiAssetBundle = {
    gguiJson: JSON.stringify({ appId: 'app-1' }),
    files: [{ path: 'blueprints/hello.json', content: '{}' }],
  };

  it('200 → { pushed: true }, hitting POST /apps/:id/ggui-assets/push with the bundle body', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path, body) => {
      calls.push({ method, path, body });
      return new Response(JSON.stringify({ status: 'pushed', fileCount: 1 }), { status: 200 });
    });

    const result = await pushGguiAssetsLeg({ appId: 'app-1', bundle, auth, config }, { api });

    expect(result).toEqual({ pushed: true });
    expect(calls).toEqual([
      { method: 'POST', path: '/apps/app-1/ggui-assets/push', body: bundle },
    ]);
  });

  it('501 not-yet-supported → { pushed: false, reason }', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 'not-yet-supported', message: 'ggui asset push is not yet enabled on this environment.' }),
        { status: 501 },
      ),
    );

    const result = await pushGguiAssetsLeg({ appId: 'app-1', bundle, auth, config }, { api });

    expect(result.pushed).toBe(false);
    expect(result.reason).toBe('ggui asset push is not yet enabled on this environment.');
  });

  it('other non-2xx (e.g. 500) throws with the real httpError nested {error:{code,message}} shape', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: 'InternalError', message: 'internal error' } }),
        { status: 500 },
      ),
    );

    await expect(
      pushGguiAssetsLeg({ appId: 'app-1', bundle, auth, config }, { api }),
    ).rejects.toThrow('internal error');
  });

  it('409 (no federated gguiAppId) throws with the real httpError nested {error:{code,message}} shape', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: { code: 'ConflictError', message: 'App app-1 has no federated ggui app' },
        }),
        { status: 409 },
      ),
    );

    await expect(
      pushGguiAssetsLeg({ appId: 'app-1', bundle, auth, config }, { api }),
    ).rejects.toThrow('App app-1 has no federated ggui app');
  });
});
