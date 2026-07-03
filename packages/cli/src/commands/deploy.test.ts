import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollDeployStatus } from './deploy.js';
import type { apiRequest } from '../deploy-shared.js';

// Regression coverage for the "polls a nonexistent route with the wrong
// field names" bug: the real backend route is
// `GET /apps/:id/deployments/:n/status` (NOT `/deploy/status/:n`), and its
// projection (`handlers/deploy.ts#handleGetDeploymentStatus`) returns
// `endpointUrl`/`errorMessage` (NOT `url`/`error`). Every stub here uses that
// REAL shape.
describe('pollDeployStatus', () => {
  const auth = { pat: 'pat-test' };
  const config = { apiUrl: 'https://api.guuey.test' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'polls GET /apps/:id/deployments/:n/status and maps endpointUrl -> url once status is live',
    async () => {
      const calls: { method: string; path: string }[] = [];
      const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path) => {
        calls.push({ method, path });
        return new Response(
          JSON.stringify({
            appId: 'app-1',
            buildNumber: 4,
            status: 'live',
            endpointUrl: 'https://app-1.guuey.app',
            errorMessage: null,
            updatedAt: '2026-07-03T00:00:00.000Z',
            deployedAt: '2026-07-03T00:00:00.000Z',
          }),
          { status: 200 },
        );
      });

      const result = await pollDeployStatus(
        { auth, config, appId: 'app-1', buildNumber: 4, timeoutMs: 60_000 },
        { api },
      );

      expect(result).toEqual({ status: 'live', url: 'https://app-1.guuey.app' });
      expect(calls).toEqual([{ method: 'GET', path: '/apps/app-1/deployments/4/status' }]);
    },
    10_000,
  );

  it(
    'progresses through queued -> live, printing each distinct `message`',
    async () => {
      const responses = [
        { status: 'queued', endpointUrl: null, errorMessage: null, message: undefined },
        { status: 'building', endpointUrl: null, errorMessage: null, message: 'Building image...' },
        { status: 'live', endpointUrl: 'https://app-1.guuey.app', errorMessage: null, message: undefined },
      ];
      let call = 0;
      const api: typeof apiRequest = vi.fn(async () => {
        const body = responses[Math.min(call, responses.length - 1)];
        call += 1;
        return new Response(JSON.stringify(body), { status: 200 });
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await pollDeployStatus(
        { auth, config, appId: 'app-1', buildNumber: 4, timeoutMs: 60_000 },
        { api },
      );

      expect(result.status).toBe('live');
      expect(logSpy.mock.calls.flat()).toContain('  Building image...');
    },
    15_000,
  );

  it(
    'reads errorMessage (not error) from the real projection shape, prints it, and exits 1',
    async () => {
      const api: typeof apiRequest = vi.fn(async () =>
        new Response(
          JSON.stringify({
            appId: 'app-1',
            buildNumber: 4,
            status: 'failed',
            endpointUrl: null,
            errorMessage: 'Kaniko build failed: exit 1',
            updatedAt: '2026-07-03T00:00:00.000Z',
            deployedAt: null,
          }),
          { status: 200 },
        ),
      );
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => {
          throw new Error('__process_exit__');
        });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        pollDeployStatus(
          { auth, config, appId: 'app-1', buildNumber: 4, timeoutMs: 60_000 },
          { api },
        ),
      ).rejects.toThrow('__process_exit__');

      expect(errorSpy.mock.calls.flat()).toContain('✗ Kaniko build failed: exit 1');
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
    10_000,
  );
});
