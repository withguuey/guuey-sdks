/**
 * guuey logs -- Fetch deployment logs for a deployed agent.
 *
 * Retrieves recent logs from the deployed agent's runtime,
 * useful for debugging production issues.
 *
 * Usage:
 *   guuey logs                     # Fetch last 1h of logs
 *   guuey logs --since 30m         # Fetch last 30 minutes
 *   guuey logs --follow            # Live tail (Ctrl+C to stop)
 *   guuey logs -f --since 5m       # Live tail starting from last 5 minutes
 *
 * NOT YET AVAILABLE: there is no `/v1/apps/:id/logs` cliApi route (runtime
 * log access is deferred — see cliApi handler.ts "Deferred to follow-up
 * slices"). The command fails fast with a roadmap notice and is
 * de-advertised from `guuey --help`. The full implementation below is kept
 * intact and re-activates by removing the `notYetAvailable` gate when the
 * route ships.
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';

interface LogEntry {
  timestamp: string;
  pod?: string;
  message: string;
}

function printEntry(entry: LogEntry): void {
  const time = new Date(entry.timestamp).toISOString().slice(11, 23);
  const podPrefix = entry.pod ? `[${entry.pod}] ` : '';
  console.log(`${time}  ${podPrefix}${entry.message}`);
}

async function fetchLogs(
  baseUrl: string,
  appId: string,
  pat: string,
  params: Record<string, string>,
): Promise<LogEntry[]> {
  const qs = new URLSearchParams(params).toString();
  const url = `${baseUrl}/apps/${appId}/logs?${qs}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${pat}` },
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }

  const data = (await res.json()) as { logs: LogEntry[] };
  return data.logs ?? [];
}

export async function logs(
  flags?: Record<string, string | true>,
): Promise<void> {
  out.notYetAvailable(
    "guuey logs isn't available yet — runtime log streaming is on the guuey launch roadmap.",
  );
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = (flags?.['app-id'] as string) ?? config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey link" or "guuey create" first.');
    process.exit(1);
  }

  const since = (flags?.since as string) ?? '1h';
  const tail = flags?.tail as string | undefined;
  const follow = flags?.follow === true || flags?.f === true;

  if (!config.apiUrl) {
    out.error('REST API URL not configured.');
    process.exit(1);
  }
  const baseUrl = config.apiUrl.replace(/\/$/, '');

  // Initial fetch
  console.log(`Fetching logs for app ${appId} (last ${since})...`);
  console.log('');

  try {
    const params: Record<string, string> = { since };
    if (tail) params.tailLines = tail;
    const entries = await fetchLogs(baseUrl, appId, auth.pat, params);

    if (entries.length === 0 && !follow) {
      console.log('No logs found.');
      return;
    }

    for (const entry of entries) {
      printEntry(entry);
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
          since: '10s',
        });

        // Filter out entries at or before cursor
        const fresh = newEntries.filter((e) => e.timestamp > cursor);

        for (const entry of fresh) {
          printEntry(entry);
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
