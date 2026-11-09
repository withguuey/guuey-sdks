/**
 * guuey#3287 — `guuey deploy` sends a pod size only when the builder named one
 * (`--size`, else `agent.deploy.size`); otherwise the server's rule decides
 * (the app keeps its size, a first deploy gets xs, guuey#3286/#3288) and the
 * `Size:` line prints what the 202 says.
 *
 * Drives the real `deploy()` through the orchestrated code path, with the
 * build and the source pack stubbed (the harness of deploy-code-access.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { deploy, readTriggerSize, runtimeSizeLabel } from './deploy.js';
import { parseGuueyJson } from '@guuey/config';
import { resolveConfig, loadProjectConfig } from '../config.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(() => Buffer.from('')),
    spawnSync: vi.fn((file: string) => ({ status: file === 'pnpm' ? 0 : 1 })),
  };
});

const packed = vi.hoisted(() => ({ path: '' }));
vi.mock('../deploy-shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deploy-shared.js')>();
  return {
    ...actual,
    packSource: vi.fn(() => ({ tarballPath: packed.path, tarballSize: 4, sourceHash: 'sha256:test' })),
    cleanup: vi.fn(),
  };
});

vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return { ...actual, requireAuth: vi.fn(() => ({ pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' })) };
});

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    resolveConfig: vi.fn(),
    loadProjectConfig: vi.fn(() => null),
    loadConfig: vi.fn(() => ({})),
    saveConfig: vi.fn(),
  };
});

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

describe('deploy() --code — the size is the builder\'s or the server\'s, never a CLI default (guuey#3287)', () => {
  let dir: string;
  let originalCwd: string;
  let fetchSpy: MockInstance<typeof fetch>;
  let logSpy: MockInstance<typeof console.log>;

  /** The platform, with the trigger's 202 body as given. */
  function mockPlatform(accepted: Record<string, unknown>): void {
    fetchSpy.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/apps/app-1/deployments')) return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
      if (url.endsWith('/apps/app-1/deploy/upload')) {
        return new Response(JSON.stringify({ uploadUrl: 'https://s3.test/upload', uploadId: 'up-1', buildNumber: 1 }), { status: 200 });
      }
      if (url === 'https://s3.test/upload') return new Response('', { status: 200 });
      if (url.endsWith('/apps/app-1/deploy/trigger')) return new Response(JSON.stringify(accepted), { status: 202 });
      if (url.includes('/deployments/1/status')) {
        return new Response(JSON.stringify({ status: 'live', endpointUrl: 'https://app-1.guuey.app', errorMessage: null, pageUrl: 'https://app-1.agents.guuey.test/' }), { status: 200 });
      }
      if (url.endsWith('/apps/app-1') && method === 'GET') return new Response(JSON.stringify({ app: { id: 'app-1', chatTheme: null } }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
  }

  function sentBody(suffix: string): Record<string, unknown> {
    const call = fetchSpy.mock.calls.find(([u]) => String(u).endsWith(suffix));
    expect(call).toBeDefined();
    return JSON.parse(String(call![1]?.body)) as Record<string, unknown>;
  }

  function printed(): string {
    return logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
  }

  function writeProject(deploy?: { size: string }): void {
    writeFileSync(
      join(dir, 'guuey.json'),
      JSON.stringify({ schema: '1', appId: 'app-1', agent: { mode: 'code', ...(deploy ? { deploy } : {}) } }),
    );
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'deploy-size-test-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'tsup' } }));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', '.modules.yaml'), ''); // a finished install (guuey#3280)
    writeFileSync(join(dir, 'guuey.worker.js'), '// built worker');
    packed.path = join(dir, 'source.tar.gz');
    writeFileSync(packed.path, 'tar!');
    process.chdir(dir);
    vi.mocked(resolveConfig).mockReturnValue({ host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test', appId: 'app-1' });
    vi.mocked(loadProjectConfig).mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('no --size and no agent.deploy.size: no size is sent, and the line prints the size the server answered', async () => {
    writeProject();
    mockPlatform({ buildNumber: 1, size: 'sm' });
    await deploy({ code: true });
    expect('size' in sentBody('/deploy/trigger')).toBe(false);
    expect('size' in sentBody('/deploy/upload')).toBe(false);
    expect(printed()).toContain('Size:   runtime=sm, build=md');
  });

  it('an older server that answers no size: the line says the server chose, never a guessed xs', async () => {
    writeProject();
    mockPlatform({ buildNumber: 1 });
    await deploy({ code: true });
    expect(printed()).toContain('Size:   runtime=chosen by the server');
    expect(printed()).not.toContain('runtime=xs');
  });

  it('--size is sent as given', async () => {
    writeProject();
    mockPlatform({ buildNumber: 1, size: 'md' });
    await deploy({ code: true, size: 'md' });
    expect(sentBody('/deploy/trigger').size).toBe('md');
    expect(printed()).toContain('Size:   runtime=md, build=md');
  });

  it('agent.deploy.size is sent when there is no --size', async () => {
    writeProject({ size: 'lg' });
    vi.mocked(loadProjectConfig).mockReturnValue(
      parseGuueyJson({ schema: '1', appId: 'app-1', agent: { mode: 'code', deploy: { size: 'lg' } } }),
    );
    mockPlatform({ buildNumber: 1, size: 'lg' });
    await deploy({ code: true });
    expect(sentBody('/deploy/trigger').size).toBe('lg');
  });
});

describe('the 202 size readers (guuey#3287)', () => {
  it('readTriggerSize takes a non-empty string and nothing else', () => {
    expect(readTriggerSize({ size: 'sm' })).toBe('sm');
    expect(readTriggerSize({ size: '' })).toBeUndefined();
    expect(readTriggerSize({ size: 3 })).toBeUndefined();
    expect(readTriggerSize({})).toBeUndefined();
    expect(readTriggerSize(null)).toBeUndefined();
  });

  it('runtimeSizeLabel: the server\'s word, else what was sent, else who chose', () => {
    expect(runtimeSizeLabel('md', 'md')).toBe('md');
    expect(runtimeSizeLabel(undefined, 'sm')).toBe('sm');
    expect(runtimeSizeLabel('md', undefined)).toBe('md');
    expect(runtimeSizeLabel(undefined, undefined)).toMatch(/^chosen by the server/);
  });
});
