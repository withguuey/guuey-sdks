/**
 * `guuey usage export` — the per-app month usage export (guuey#1393 D1).
 *
 *   guuey usage export                          # this project's app, this month, CSV to stdout
 *   guuey usage export --month 2026-08 --out usage-2026-08.csv
 *   guuey usage export --app-id <id> --format json
 *
 * One call: `GET /v1/apps/:id/usage/export?month=…&format=…`. The CSV is the
 * server's one renderer (the console's download is the same bytes), written
 * through untouched; `--format json` prints the export object. The export
 * states what it cannot attribute (its `notAttributable` list) — per end-user
 * figures are not in it.
 */
import { writeFileSync } from 'node:fs';
import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import { apiRequest } from '../deploy-shared';
import * as out from '../output';

/** A cost or count split by a key the meters write (a model id, a serving surface). */
export interface UsageBreakdown {
  [key: string]: number;
}

/**
 * MIRROR of cli-wire's `UsageExportWire` (`backend/libs/cli-wire/usage-export.ts`)
 * — pinned field-for-field by `wire-sync.test.ts`.
 */
export interface UsageExportWire {
  appId: string;
  appName: string;
  month: string;
  generatedAt: string;
  hasUsage: boolean;
  llm: {
    managedCostUsd: number;
    costByModelUsd: UsageBreakdown;
    inputTokens: number;
    outputTokens: number;
  };
  renders: { total: number; cold: number; cacheHit: number; byokInfra: number };
  answers: number;
  sessions: { total: number; bySurface: UsageBreakdown };
  widgetOpens: number;
  podUnitHours: number;
  storage: { fsGibHours: number; fsBytes: number };
  notAttributable: readonly string[];
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function usageExport(flags: Record<string, string | true> = {}): Promise<void> {
  for (const name of ['month', 'format', 'out', 'app-id'] as const) {
    if (flags[name] === true) {
      out.error(`--${name} needs a value`);
      process.exit(1);
    }
  }
  const month = typeof flags['month'] === 'string' ? flags['month'] : undefined;
  if (month !== undefined && !MONTH_RE.test(month)) {
    out.error(`--month must be YYYY-MM (for example 2026-09). Received: ${month}`);
    process.exit(1);
  }
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'csv';
  if (format !== 'csv' && format !== 'json') {
    out.error(`--format must be csv or json. Received: ${format}`);
    process.exit(1);
  }
  const outFile = typeof flags['out'] === 'string' ? flags['out'] : undefined;

  const config = resolveConfig();
  const appId = typeof flags['app-id'] === 'string' ? flags['app-id'] : config.appId;
  if (!appId) {
    out.error('No app configured. Run inside a project bound to an app, or pass --app-id <id>.');
    process.exit(1);
  }

  const { pat } = requireAuth();
  const query = new URLSearchParams({ ...(month !== undefined ? { month } : {}), format });
  const res = await apiRequest(pat, config, 'GET', `/apps/${encodeURIComponent(appId)}/usage/export?${query.toString()}`);
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    out.error(`Usage export failed: ${out.apiErrorMessage(body, `HTTP ${res.status}`)}`);
    process.exit(1);
  }

  const content =
    format === 'csv'
      ? await res.text()
      : `${JSON.stringify(((await res.json()) as { export: UsageExportWire }).export, null, 2)}\n`;

  if (outFile === undefined) {
    process.stdout.write(content);
    return;
  }
  writeFileSync(outFile, content);
  out.success(`Wrote ${outFile} (${format.toUpperCase()}, app ${appId}${month !== undefined ? `, ${month}` : ', this month'})`);
}
