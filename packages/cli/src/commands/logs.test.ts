import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseSinceSeconds,
  resolveLogsQuery,
  formatLogEntry,
  fetchLogs,
} from './logs.js';

// Coverage for the re-enabled `guuey logs` command against the REAL cliApi
// wire contract: `GET /v1/apps/:id/logs?sinceSeconds=<int>&tailLines=<int>`
// returning `{ logs: [{ timestamp, pod, message }] }` oldest-first, with the
// standard `{ error: { code, message } }` envelope on failure.

describe('parseSinceSeconds', () => {
  it('converts each duration unit to whole seconds', () => {
    expect(parseSinceSeconds('45s')).toBe(45);
    expect(parseSinceSeconds('30m')).toBe(1800);
    expect(parseSinceSeconds('2h')).toBe(7200);
    expect(parseSinceSeconds('1d')).toBe(86400);
  });

  it('rejects anything that is not <int><s|m|h|d>', () => {
    expect(parseSinceSeconds('')).toBeNull();
    expect(parseSinceSeconds('1h30m')).toBeNull();
    expect(parseSinceSeconds('10x')).toBeNull();
    expect(parseSinceSeconds('m5')).toBeNull();
    expect(parseSinceSeconds('-5m')).toBeNull();
    expect(parseSinceSeconds('1.5h')).toBeNull();
    expect(parseSinceSeconds('30')).toBeNull();
  });
});

describe('resolveLogsQuery', () => {
  it('defaults --since to 1h and omits tailLines when --tail is absent', () => {
    const result = resolveLogsQuery({});
    expect(result).toEqual({
      ok: true,
      params: { sinceSeconds: 3600 },
      sinceLabel: '1h',
    });
  });

  it('maps --since 30m / --tail 200 to sinceSeconds=1800 / tailLines=200', () => {
    const result = resolveLogsQuery({ since: '30m', tail: '200' });
    expect(result).toEqual({
      ok: true,
      params: { sinceSeconds: 1800, tailLines: 200 },
      sinceLabel: '30m',
    });
  });

  it('rejects a malformed or value-less --since', () => {
    expect(resolveLogsQuery({ since: 'yesterday' })).toEqual({
      ok: false,
      error:
        'Invalid --since value: yesterday. Use a duration like 30s, 15m, 2h, or 1d.',
    });
    expect(resolveLogsQuery({ since: true }).ok).toBe(false);
  });

  it('rejects a non-numeric or value-less --tail', () => {
    expect(resolveLogsQuery({ tail: 'many' })).toEqual({
      ok: false,
      error: 'Invalid --tail value: many. Pass a positive line count.',
    });
    expect(resolveLogsQuery({ tail: true }).ok).toBe(false);
  });
});

describe('formatLogEntry', () => {
  it('renders HH:mm:ss.SSS, a [pod] prefix, and the message', () => {
    expect(
      formatLogEntry({
        timestamp: '2026-07-08T12:34:56.789Z',
        pod: 'agent-app-1-7d9f-x2k',
        message: 'listening on :6790',
      }),
    ).toBe('12:34:56.789  [agent-app-1-7d9f-x2k] listening on :6790');
  });

  it('omits the pod prefix when pod is missing', () => {
    expect(
      formatLogEntry({
        timestamp: '2026-07-08T00:00:01.000Z',
        message: 'boot',
      }),
    ).toBe('00:00:01.000  boot');
  });
});

describe('fetchLogs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const entries = [
    { timestamp: '2026-07-08T12:00:00.000Z', pod: 'agent-app-1-a', message: 'one' },
    { timestamp: '2026-07-08T12:00:01.000Z', pod: 'agent-app-1-a', message: 'two' },
  ];

  it('GETs /apps/:id/logs with sinceSeconds + tailLines and bearer auth', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ logs: entries }), { status: 200 }),
      );

    const result = await fetchLogs(
      'https://api.guuey.test/v1',
      'app-1',
      'guuey_user_pat',
      { sinceSeconds: 1800, tailLines: 200 },
    );

    expect(result).toEqual(entries);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://api.guuey.test/v1/apps/app-1/logs?sinceSeconds=1800&tailLines=200',
    );
    expect(init?.headers).toEqual({ Authorization: 'Bearer guuey_user_pat' });
  });

  it('omits tailLines from the query when not requested', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ logs: [] }), { status: 200 }),
      );

    await fetchLogs('https://api.guuey.test/v1', 'app-1', 'guuey_user_pat', {
      sinceSeconds: 3600,
    });

    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      'https://api.guuey.test/v1/apps/app-1/logs?sinceSeconds=3600',
    );
  });

  it('surfaces the cliApi { error: { code, message } } envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'not_deployed', message: 'App has no running deployment' },
        }),
        { status: 409 },
      ),
    );

    await expect(
      fetchLogs('https://api.guuey.test/v1', 'app-1', 'guuey_user_pat', {
        sinceSeconds: 3600,
      }),
    ).rejects.toThrow('not_deployed: App has no running deployment');
  });

  it('surfaces a legacy string error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'app app-1 not found' }), {
        status: 404,
      }),
    );

    await expect(
      fetchLogs('https://api.guuey.test/v1', 'app-1', 'guuey_user_pat', {
        sinceSeconds: 3600,
      }),
    ).rejects.toThrow('app app-1 not found');
  });

  it('falls back to the HTTP status on a non-JSON error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('gateway timeout', { status: 504 }),
    );

    await expect(
      fetchLogs('https://api.guuey.test/v1', 'app-1', 'guuey_user_pat', {
        sinceSeconds: 3600,
      }),
    ).rejects.toThrow('Failed to fetch logs: HTTP 504');
  });
});
