/**
 * guuey logs -- Fetch runtime logs for a deployed agent.
 *
 * Renders the cliApi runtime-log route
 * (`GET /v1/apps/:id/logs?sinceSeconds=<int>&tailLines=<int>`, which returns
 * `{ logs: [{ timestamp, pod, message }] }` oldest-first), useful for
 * debugging production issues.
 *
 * Usage:
 *   guuey logs                     # Fetch last 1h of logs
 *   guuey logs --since 30m         # Fetch last 30 minutes
 *   guuey logs --tail 200          # Only the last 200 lines
 *   guuey logs --follow            # Live tail (Ctrl+C to stop)
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';

/** One log line of the `GET /apps/:id/logs` response. */
export interface LogEntry {
  timestamp: string;
  pod?: string;
  message: string;
}

/** Query parameters of the `GET /apps/:id/logs` route. */
export interface LogsQuery {
  sinceSeconds: number;
  tailLines?: number;
}

const SINCE_PATTERN = /^(\d+)([smhd])$/;

/**
 * Parse a human `--since` duration (`30s`, `15m`, `2h`, `1d`) into whole
 * seconds for the route's `sinceSeconds` parameter. Returns `null` for
 * anything that isn't `<int><s|m|h|d>`.
 */
export function parseSinceSeconds(since: string): number | null {
  const match = SINCE_PATTERN.exec(since);
  if (!match) return null;
  const value = parseInt(match[1]!, 10);
  switch (match[2]) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 3600;
    case 'd':
      return value * 86400;
    default:
      return null;
  }
}

/**
 * Map the raw `--since` / `--tail` flags onto the route's query parameters.
 * `--since` defaults to `1h`; `--tail` is omitted unless given (the server
 * applies its own default). `sinceLabel` is the human duration for the
 * "Fetching logs..." banner.
 */
export function resolveLogsQuery(
  flags?: Record<string, string | true>,
):
  | { ok: true; params: LogsQuery; sinceLabel: string }
  | { ok: false; error: string } {
  const sinceRaw = flags?.since ?? '1h';
  const sinceSeconds =
    typeof sinceRaw === 'string' ? parseSinceSeconds(sinceRaw) : null;
  if (typeof sinceRaw !== 'string' || sinceSeconds === null) {
    return {
      ok: false,
      error: `Invalid --since value: ${String(sinceRaw)}. Use a duration like 30s, 15m, 2h, or 1d.`,
    };
  }

  const params: LogsQuery = { sinceSeconds };

  const tailRaw = flags?.tail;
  if (tailRaw !== undefined) {
    if (typeof tailRaw !== 'string' || !/^\d+$/.test(tailRaw)) {
      return {
        ok: false,
        error: `Invalid --tail value: ${String(tailRaw)}. Pass a positive line count.`,
      };
    }
    params.tailLines = parseInt(tailRaw, 10);
  }

  return { ok: true, params, sinceLabel: sinceRaw };
}

/** Render one log entry as `HH:mm:ss.SSS  [pod] message`. */
export function formatLogEntry(entry: LogEntry): string {
  const time = new Date(entry.timestamp).toISOString().slice(11, 23);
  const podPrefix = entry.pod ? `[${entry.pod}] ` : '';
  return `${time}  ${podPrefix}${entry.message}`;
}

/**
 * Fetch one window of runtime logs from `GET /apps/:id/logs`. Throws a
 * human-readable Error (via `apiErrorMessage`) on non-2xx responses; the
 * command wrapper prints + exits.
 */
export async function fetchLogs(
  baseUrl: string,
  appId: string,
  pat: string,
  params: LogsQuery,
): Promise<LogEntry[]> {
  const qs = new URLSearchParams({ sinceSeconds: String(params.sinceSeconds) });
  if (params.tailLines !== undefined) {
    qs.set('tailLines', String(params.tailLines));
  }
  const url = `${baseUrl}/apps/${appId}/logs?${qs.toString()}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${pat}` },
  });

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw new Error(
      out.apiErrorMessage(body, `Failed to fetch logs: HTTP ${res.status}`),
    );
  }

  const data = (await res.json()) as { logs: LogEntry[] };
  return data.logs ?? [];
}

/**
 * Handle the `guuey logs` command.
 *
 * Fetches recent runtime logs for the resolved app and prints them
 * oldest-first; with `--follow`, keeps polling a short overlapping window
 * every 3s and deduplicates by timestamp until Ctrl+C.
 */
export async function logs(
  flags?: Record<string, string | true>,
): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = (flags?.['app-id'] as string) ?? config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey pull --app-id <id>" to bind an existing app, or "guuey create" to scaffold a new project first.');
    process.exit(1);
  }

  const query = resolveLogsQuery(flags);
  if (!query.ok) {
    out.error(query.error);
    process.exit(1);
  }

  const follow = flags?.follow === true;

  if (!config.apiUrl) {
    out.error('REST API URL not configured.');
    process.exit(1);
  }
  const baseUrl = config.apiUrl.replace(/\/$/, '');

  // Initial fetch
  console.log(`Fetching logs for app ${appId} (last ${query.sinceLabel})...`);
  console.log('');

  try {
    const entries = await fetchLogs(baseUrl, appId, auth.pat, query.params);

    if (entries.length === 0 && !follow) {
      console.log('No logs found.');
      return;
    }

    for (const entry of entries) {
      console.log(formatLogEntry(entry));
    }

    if (!follow) return;

    // Follow mode — poll every 3s with short window, deduplicate by timestamp
    console.log('');
    console.log('  Following logs... (Ctrl+C to stop)');
    console.log('');

    // Track the latest timestamp to avoid duplicates
    let cursor = entries.length > 0
      ? entries[entries.length - 1].timestamp
      : new Date().toISOString();

    // Graceful shutdown
    let running = true;
    const shutdown = () => {
      running = false;
      console.log('');
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    while (running) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!running) break;

      try {
        // Fetch last 10 seconds of logs (overlapping window for dedup)
        const newEntries = await fetchLogs(baseUrl, appId, auth.pat, {
          sinceSeconds: 10,
        });

        // Filter out entries at or before cursor
        const fresh = newEntries.filter((e) => e.timestamp > cursor);

        for (const entry of fresh) {
          console.log(formatLogEntry(entry));
        }

        if (fresh.length > 0) {
          cursor = fresh[fresh.length - 1].timestamp;
        }
      } catch {
        // Transient errors — keep polling
      }
    }

    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  } catch (e) {
    out.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
