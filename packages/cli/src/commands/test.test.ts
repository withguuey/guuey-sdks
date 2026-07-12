/**
 * `guuey test` — endpoint resolution (S13).
 *
 * S13 walkthrough bug: `resolveAgentEndpoint`'s last-resort fallback was
 * `config.host` — the PLATFORM host, not an agent pod — so `guuey test`
 * POSTed `/invoke` at the platform origin and got back a 404 HTML page.
 * The fix replaces that fallback with a lookup against
 * `GET /apps/:id/deployments` (the same route `commands/deployments.ts`
 * speaks): newest-first, pick the first row with a live `endpointUrl`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { resolveAgentEndpoint } from './test.js';
import type { resolveConfig } from '../config.js';

/** Thrown by the process.exit mock so execution stops like the real thing. */
class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const config: ReturnType<typeof resolveConfig> = {
  host: 'https://platform.guuey.test',
  apiUrl: 'https://api.guuey.test',
  appId: 'app-1',
};
const pat = 'pat-test';

describe('resolveAgentEndpoint', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the --url flag wins over everything, with no network call', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');

    const endpoint = await resolveAgentEndpoint(config, { url: 'https://custom.example.com/' }, pat);

    expect(endpoint).toBe('https://custom.example.com');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves the deployed endpoint from the deployments API (newest live row)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          deployments: [
            { status: 'live', endpointUrl: 'https://app-1.agents.dev.sandbox.guuey.com' },
          ],
        }),
        { status: 200 },
      ),
    );

    const endpoint = await resolveAgentEndpoint(config, {}, pat);

    expect(endpoint).toBe('https://app-1.agents.dev.sandbox.guuey.com');
    const [url] = fetchSpy.mock.calls.at(-1)!;
    expect(new URL(String(url)).pathname).toBe('/apps/app-1/deployments');
  });

  it('picks the newest row that has an endpointUrl, skipping newer rows without one', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          deployments: [
            { status: 'building', endpointUrl: null },
            { status: 'live', endpointUrl: 'https://app-1.agents.dev.sandbox.guuey.com' },
          ],
        }),
        { status: 200 },
      ),
    );

    expect(await resolveAgentEndpoint(config, {}, pat)).toBe(
      'https://app-1.agents.dev.sandbox.guuey.com',
    );
  });

  it('never falls back to config.host (the platform origin, not an agent pod)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ deployments: [] }), { status: 200 }),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(resolveAgentEndpoint(config, {}, pat)).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('No live deployment found');
    expect(printed).not.toContain('platform.guuey.test');
  });

  it('errors the same way when the deployments request itself fails', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such app' } }), {
        status: 404,
      }),
    );
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(resolveAgentEndpoint(config, {}, pat)).rejects.toBeInstanceOf(ExitSignal);

    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('No live deployment found');
  });
});
