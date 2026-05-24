// private/guuey-cli/src/config.test.ts
//
// Focused tests for the CLI's guuey.json writer/reader after the
// 2026-04-21 migration onto the canonical `@guuey-private/guuey-
// config` overlay. Pins three things that would have otherwise
// regressed silently:
//
//   1. `saveProjectConfig` rejects legacy ProjectConfig shapes
//      (appId/host/bridgeUrl/hosting) — the canonical schema is
//      `strip-unknown-keys`, so these fields get dropped on write.
//   2. `loadProjectConfig` returns `null` on malformed / missing
//      files. Downstream callsites branch on null; a happy-path
//      empty-object regression would silently read-as-present.
//   3. `resolveConfig` no longer falls back through guuey.json for
//      URL overrides. The env-var / amplify_outputs / default
//      chain is the ONLY path.

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadProjectConfig,
  saveProjectConfig,
  resolveConfig,
  setConfigFile,
} from './config';

/**
 * Tests that poke the filesystem change the CWD so `findProjectConfig`
 * walks into a scratch directory rather than the repo root. Each
 * test restores the original CWD.
 */
let originalCwd: string;
let scratchDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  scratchDir = mkdtempSync(join(tmpdir(), 'guuey-cli-config-test-'));
  process.chdir(scratchDir);
  // Redirect the global config file to a non-existent path inside
  // the scratch dir so tests are isolated from any real
  // `~/.guuey/config.json` the developer has locally.
  setConfigFile(join(scratchDir, '.guuey-global.json'));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(scratchDir, { recursive: true, force: true });
});

// ─── saveProjectConfig — canonical shape ─────────────────────────

describe('saveProjectConfig — canonical shape', () => {
  it('writes a minimal `{schema: "1"}` overlay', () => {
    saveProjectConfig({ schema: '1', deployments: [] });
    const onDisk = JSON.parse(
      readFileSync(join(scratchDir, 'guuey.json'), 'utf-8'),
    );
    expect(onDisk).toEqual({ schema: '1', deployments: [] });
  });

  it('writes a `{schema: "1", project: {id}}` overlay (create/link shape)', () => {
    saveProjectConfig({
      schema: '1',
      project: { id: 'app_12345' },
      deployments: [],
    });
    const onDisk = JSON.parse(
      readFileSync(join(scratchDir, 'guuey.json'), 'utf-8'),
    );
    expect(onDisk.project).toEqual({ id: 'app_12345' });
    expect(onDisk.project?.workspaceId).toBeUndefined();
  });

  it('writes a full overlay with project/deploy/deployments', () => {
    saveProjectConfig({
      schema: '1',
      project: { id: 'app_12345', workspaceId: 'ws_abc' },
      deploy: { size: 'sm', runtime: 'node22', region: 'us-east-1' },
      deployments: [
        {
          target: 'guuey',
          url: 'https://weather-bot.agents.guuey.com',
          deployedAt: '2026-04-21T10:00:00.000Z',
          buildId: 'build_01K',
        },
      ],
    });
    const onDisk = JSON.parse(
      readFileSync(join(scratchDir, 'guuey.json'), 'utf-8'),
    );
    expect(onDisk.deployments).toHaveLength(1);
    expect(onDisk.deploy?.size).toBe('sm');
  });

  it('throws on a malformed overlay (rejects wrong shape at validation)', () => {
    // @ts-expect-error — deliberate bad input pinning runtime guard
    expect(() => saveProjectConfig({ schema: '2' })).toThrow();
  });

  it('throws on a legacy ProjectConfig shape (the 2026-04-21 migration break)', () => {
    // @ts-expect-error — legacy flat ProjectConfig shape; TypeScript
    // already blocks this, but the runtime guard ALSO rejects it so
    // bad rewires land the same way at `save` time.
    expect(() => saveProjectConfig({ appId: 'app_12345', host: 'https://x' })).toThrow();
  });
});

// ─── loadProjectConfig — null semantics ──────────────────────────

describe('loadProjectConfig — null semantics', () => {
  it('returns null when no guuey.json exists', () => {
    expect(loadProjectConfig()).toBeNull();
  });

  it('returns null when guuey.json is not valid JSON', () => {
    writeFileSync(join(scratchDir, 'guuey.json'), '{ not valid json', 'utf-8');
    expect(loadProjectConfig()).toBeNull();
  });

  it('returns null when guuey.json fails canonical schema validation', () => {
    // Legacy ProjectConfig shape — no `schema` field at all.
    writeFileSync(
      join(scratchDir, 'guuey.json'),
      JSON.stringify({ appId: 'app_12345', host: 'https://x' }),
      'utf-8',
    );
    expect(loadProjectConfig()).toBeNull();
  });

  it('returns the parsed overlay when the file is valid', () => {
    writeFileSync(
      join(scratchDir, 'guuey.json'),
      JSON.stringify({ schema: '1', project: { id: 'app_12345' } }),
      'utf-8',
    );
    const project = loadProjectConfig();
    expect(project?.schema).toBe('1');
    expect(project?.project?.id).toBe('app_12345');
  });

  it('strips legacy top-level fields that sneak into a valid overlay', () => {
    // A user who hand-edits their file and mixes canonical + legacy
    // shapes. Canonical parse strips unknowns — the CLI should
    // reflect the canonical truth, not the stale flat keys.
    writeFileSync(
      join(scratchDir, 'guuey.json'),
      JSON.stringify({
        schema: '1',
        project: { id: 'app_12345' },
        // Legacy fields that must NOT survive canonical parse:
        appId: 'app_legacy',
        host: 'https://legacy.example.com',
        hosting: { size: 'lg' },
      }),
      'utf-8',
    );
    const project = loadProjectConfig();
    expect(project?.project?.id).toBe('app_12345');
    expect(project as unknown as { appId?: string }).not.toHaveProperty(
      'appId',
    );
    expect(project as unknown as { host?: string }).not.toHaveProperty(
      'host',
    );
    expect(project as unknown as { hosting?: unknown }).not.toHaveProperty(
      'hosting',
    );
  });
});

// ─── resolveConfig — URL overrides no longer ride guuey.json ─────

describe('resolveConfig — URL overrides', () => {
  const ENV_KEYS = [
    'GGUI_HOST',
    'GGUI_BRIDGE_URL',
    'GGUI_WS_URL',
    'GGUI_RENDER_URL',
    'GGUI_APP_ID',
    'GGUI_API_KEY',
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('does NOT fall back to guuey.json for `host`', () => {
    // A guuey.json file with a legacy `host` field must NOT surface
    // through resolveConfig after the migration. The canonical
    // loader strips it; resolveConfig's `project.host` rung is gone.
    writeFileSync(
      join(scratchDir, 'guuey.json'),
      JSON.stringify({
        schema: '1',
        project: { id: 'app_12345' },
        // Legacy field that used to fallback — now inert.
        host: 'https://should-not-resolve.example.com',
      }),
      'utf-8',
    );
    const resolved = resolveConfig();
    expect(resolved.host).not.toBe('https://should-not-resolve.example.com');
    // Default endpoint wins when no env var / global config is set.
    expect(resolved.host).toBe('https://platform.guuey.com');
  });

  it('honours `GGUI_HOST` env var override', () => {
    process.env.GGUI_HOST = 'https://env.example.com';
    const resolved = resolveConfig();
    expect(resolved.host).toBe('https://env.example.com');
  });

  it('resolves `appId` from canonical `project.project?.id`', () => {
    writeFileSync(
      join(scratchDir, 'guuey.json'),
      JSON.stringify({ schema: '1', project: { id: 'app_12345' } }),
      'utf-8',
    );
    const resolved = resolveConfig();
    expect(resolved.appId).toBe('app_12345');
  });

  it('env GGUI_APP_ID still overrides canonical `project.id`', () => {
    writeFileSync(
      join(scratchDir, 'guuey.json'),
      JSON.stringify({ schema: '1', project: { id: 'app_from_file' } }),
      'utf-8',
    );
    process.env.GGUI_APP_ID = 'app_from_env';
    const resolved = resolveConfig();
    expect(resolved.appId).toBe('app_from_env');
  });
});
