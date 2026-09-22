/**
 * `guuey usage export` (guuey#1393 D1): one GET, the server's CSV written
 * through untouched, `--format json` prints the export object, and every
 * bad flag is refused before any network call.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { usageExport, type UsageExportWire } from './usage.js';

vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return { ...actual, requireAuth: vi.fn(() => ({ pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' })) };
});
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, resolveConfig: vi.fn(() => ({ host: 'https://guuey.test', apiUrl: 'https://api.guuey.test', appId: 'app-1' })) };
});

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const CSV = 'app_id,month,metric,dimension,value,unit\napp-1,2026-09,llm_cost_list_price,,1.5,USD\n';
const WIRE: UsageExportWire = {
  appId: 'app-1',
  appName: 'Rep',
  month: '2026-09',
  generatedAt: '2026-09-22T22:00:00.000Z',
  hasUsage: true,
  llm: { managedCostUsd: 1.5, costByModelUsd: { 'claude-sonnet-5': 1.5 }, inputTokens: 100, outputTokens: 20 },
  renders: { total: 0, cold: 0, cacheHit: 0, byokInfra: 0 },
  answers: 3,
  sessions: { total: 1, bySurface: { widget: 1 } },
  widgetOpens: 2,
  podUnitHours: 0.5,
  storage: { fsGibHours: 0, fsBytes: 0 },
  notAttributable: ['Per end-user figures: …'],
};

describe('guuey usage export (guuey#1393 D1)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let written: string[];
  let errors: string[];
  let logs: string[];
  let dir: string;

  beforeEach(() => {
    written = [];
    errors = [];
    logs = [];
    dir = mkdtempSync(join(tmpdir(), 'guuey-usage-'));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as typeof process.exit);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('default: this project\'s app, this month, CSV — one GET, the server\'s CSV written through untouched', async () => {
    fetchSpy.mockResolvedValue(new Response(CSV, { status: 200, headers: { 'Content-Type': 'text/csv' } }));
    await usageExport({});
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.guuey.test/apps/app-1/usage/export?format=csv');
    expect(init.method).toBe('GET');
    expect(written.join('')).toBe(CSV);
  });

  it('--month + --out writes the file and says where; --app-id targets another app', async () => {
    fetchSpy.mockResolvedValue(new Response(CSV, { status: 200 }));
    const file = join(dir, 'usage.csv');
    await usageExport({ month: '2026-08', out: file, 'app-id': 'app-9' });
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('https://api.guuey.test/apps/app-9/usage/export?month=2026-08&format=csv');
    expect(readFileSync(file, 'utf8')).toBe(CSV);
    expect(logs.join('\n')).toContain(`Wrote ${file} (CSV, app app-9, 2026-08)`);
  });

  it('--format json prints the export object', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ export: WIRE }), { status: 200 }));
    await usageExport({ format: 'json' });
    expect(JSON.parse(written.join(''))).toEqual(WIRE);
  });

  it('refuses a bad month, an unknown format and a valueless flag BEFORE any network call', async () => {
    await expect(usageExport({ month: '2026-9' })).rejects.toThrow(ExitSignal);
    await expect(usageExport({ format: 'xlsx' })).rejects.toThrow(ExitSignal);
    await expect(usageExport({ out: true })).rejects.toThrow(ExitSignal);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/--month must be YYYY-MM/);
    expect(errors.join('\n')).toMatch(/--format must be csv or json/);
  });

  it('a refusal from the API is said in its own words, exit 1', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'month 2027-01 has not started yet' } }), { status: 400 }),
    );
    await expect(usageExport({ month: '2027-01' })).rejects.toThrow(ExitSignal);
    expect(errors.join('\n')).toContain('Usage export failed: VALIDATION_ERROR: month 2027-01 has not started yet');
  });
});
