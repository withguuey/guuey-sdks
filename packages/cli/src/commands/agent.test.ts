/**
 * `guuey agent config` — request-shape + rendering coverage (scaling S1-F4,
 * guuey#162, the re-activation of the formerly `notYetAvailable`-gated
 * command; its pin left `unshipped.test.ts` in the same slice).
 *
 * Same harness as `domains.test.ts`: the command builds its request from
 * `requireAuth()` + `resolveConfig()` + `fetch` (via `apiRequest`), so these
 * mock `../auth` and `../config` and spy on `globalThis.fetch`, reading
 * `(url, init)` back into `{ method, path, body }`.
 *
 * The wire mirror itself (`AgentConfig` vs `AgentConfigWire`) is pinned by
 * `wire-sync.test.ts`, alongside the other cliApi mirrors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { agentConfig, type AgentConfig } from './agent.js';
import { resolveConfig } from '../config.js';

vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return {
    ...actual,
    requireAuth: vi.fn(() => ({
      pat: 'pat-test',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })),
  };
});

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    resolveConfig: vi.fn(() => ({
      host: 'https://guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app1',
    })),
  };
});

/** Thrown by the process.exit mock so execution stops like the real thing. */
class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

/** Reads the most recent `fetch(url, init)` call back into wire-request shape. */
function lastRequest(fetchSpy: MockInstance<typeof fetch>): CapturedRequest {
  const call = fetchSpy.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  const [url, init] = call;
  const parsed = new URL(String(url));
  return {
    method: String(init?.method),
    path: parsed.pathname + parsed.search,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

/** An app on the default (unset) knob — `maxPods: null`, NOT 0 or 1. */
const UNSET: AgentConfig = {
  appId: 'app1',
  maxPods: null,
  maxPodsCeiling: 1,
  tier: 'free',
  runtimeAutoUpdate: true,
  runtimeImageDigest: null,
};

const SCALED: AgentConfig = {
  appId: 'app1',
  maxPods: 3,
  maxPodsCeiling: 5,
  tier: 'pro',
  runtimeAutoUpdate: true,
  runtimeImageDigest: 'sha256:abc123',
};

/**
 * A write the platform did NOT make: the knob is still 1 after a PATCH that
 * asked for more (the absent-`AppBilling`-row persist is a documented no-op).
 * Deliberately differs from every requested value in the tests that use it —
 * a fixture whose readback equals the request cannot tell an echo apart from
 * a readback.
 */
const NO_OP: AgentConfig = {
  appId: 'app1',
  maxPods: 1,
  maxPodsCeiling: 5,
  tier: 'pro',
  runtimeAutoUpdate: true,
  runtimeImageDigest: null,
};

describe('guuey agent config', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let exitSpy: MockInstance<typeof process.exit>;
  let errSpy: MockInstance<typeof console.error>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stdout = (): string => logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
  const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

  describe('read mode (no flags)', () => {
    it('GETs /apps/:id/config — NOT the deployments list the pre-revival code read', async () => {
      // The dormant implementation read `latest.maxPods` off
      // `GET /apps/:id/deployments`, a field that projection never sends, so
      // it printed the `?? 1` default for every app including scaled ones.
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SCALED), { status: 200 }));

      await agentConfig({});

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'GET',
        path: '/apps/app1/config',
        body: undefined,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('renders the knob, the ceiling, and the plan', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SCALED), { status: 200 }));

      await agentConfig({});

      const output = stdout();
      expect(output).toContain('Max Pods:        3');
      expect(output).toContain('Ceiling:         5');
      expect(output).toContain('Plan:            pro');
    });

    it('prints an unset knob as "1 (default)" — never a bare 1 that reads as set', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(UNSET), { status: 200 }));

      await agentConfig({});

      expect(stdout()).toContain('Max Pods:        1 (default)');
    });

    it('--json emits the wire verbatim', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SCALED), { status: 200 }));

      await agentConfig({ json: true });

      expect(JSON.parse(stdout())).toEqual(SCALED);
    });

    it('a failed GET renders the envelope message and exits 1', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'App app1 not found' } }),
          { status: 404 },
        ),
      );

      await expect(agentConfig({})).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(stderr()).toContain('[NOT_FOUND] App app1 not found');
    });
  });

  describe('write mode (--max-pods)', () => {
    it('PATCHes /apps/:id/config with { maxPods }', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SCALED), { status: 200 }));

      await agentConfig({ 'max-pods': '3' });

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'PATCH',
        path: '/apps/app1/config',
        body: { maxPods: 3 },
      });
    });

    it("reports the server's readback, not the requested number", async () => {
      // Ask for 3, get 1 back: the readback is what actually persisted, and
      // echoing the request would claim a write the platform did not make.
      // The two numbers MUST differ here — that is the whole test.
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(NO_OP), { status: 200 }));

      await agentConfig({ 'max-pods': '3' });

      expect(stdout()).toContain('Max pods set to 1.');
      expect(stdout()).toContain('Max Pods:        1');
      expect(stdout()).not.toContain('Max pods set to 3.');
      expect(stdout()).not.toContain('Max Pods:        3');
    });

    it('prints that the change needs no redeploy', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SCALED), { status: 200 }));

      await agentConfig({ 'max-pods': '3' });

      expect(stdout()).toContain('without a redeploy');
    });

    it('--json emits the readback wire', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SCALED), { status: 200 }));

      await agentConfig({ 'max-pods': '3', json: true });

      expect(JSON.parse(stdout())).toEqual(SCALED);
    });

    it('renders the AGENT_MAX_PODS 409 with its code and the real ceiling', async () => {
      // The server names the ceiling; the CLI does not guess one (the old
      // dormant body's hardcoded 1..10 matched no tier).
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'AGENT_MAX_PODS',
              message: "maxPods 9 exceeds this app's ceiling of 5 (the Pro plan's limit).",
            },
          }),
          { status: 409 },
        ),
      );

      await expect(agentConfig({ 'max-pods': '9' })).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(stderr()).toContain('[AGENT_MAX_PODS]');
      expect(stderr()).toContain("ceiling of 5");
    });

    it('renders the COLOCATED_STATE_UNARMED 409 with its code', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'COLOCATED_STATE_UNARMED',
              message: 'maxPods > 1 requires durable state, which is not armed on this environment',
            },
          }),
          { status: 409 },
        ),
      );

      await expect(agentConfig({ 'max-pods': '2' })).rejects.toBeInstanceOf(ExitSignal);

      expect(stderr()).toContain('[COLOCATED_STATE_UNARMED]');
      expect(stderr()).toContain('durable state');
    });

    it.each(['0', '-1', '2.5', 'three', ''])(
      'rejects --max-pods %j client-side, before any network call',
      async (value) => {
        await expect(agentConfig({ 'max-pods': value })).rejects.toBeInstanceOf(ExitSignal);

        expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(stderr()).toContain('--max-pods must be a positive integer');
      },
    );

    it('rejects a valueless --max-pods (parsed as `true`) rather than sending NaN', async () => {
      await expect(agentConfig({ 'max-pods': true })).rejects.toBeInstanceOf(ExitSignal);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('--max-pods must be a positive integer');
    });
  });

  describe('write mode (--runtime-auto-update)', () => {
    /** The readback for a successful pin — `runtimeAutoUpdate: false`. */
    const PINNED: AgentConfig = {
      appId: 'app1',
      maxPods: 3,
      maxPodsCeiling: 5,
      tier: 'pro',
      runtimeAutoUpdate: false,
      runtimeImageDigest: 'sha256:abc123',
    };

    it('PATCHes /apps/:id/config with { runtimeAutoUpdate: false } for "off"', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(PINNED), { status: 200 }));

      await agentConfig({ 'runtime-auto-update': 'off' });

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'PATCH',
        path: '/apps/app1/config',
        body: { runtimeAutoUpdate: false },
      });
    });

    it('PATCHes { runtimeAutoUpdate: true } for "on" and prints the automatic copy', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SCALED), { status: 200 }));

      await agentConfig({ 'runtime-auto-update': 'on' });

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'PATCH',
        path: '/apps/app1/config',
        body: { runtimeAutoUpdate: true },
      });
      expect(stdout()).toContain('Runtime updates: automatic');
    });

    it("reports the server's readback for a pin — the pinned copy + the pinned config line", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(PINNED), { status: 200 }));

      await agentConfig({ 'runtime-auto-update': 'off' });

      expect(stdout()).toContain('Runtime updates: pinned');
      expect(stdout()).toContain('pinned to deploy');
      expect(stdout()).toContain('Runtime digest:  sha256:abc123');
    });

    it.each(['true', 'false', '1', true])(
      'rejects --runtime-auto-update %j client-side, before any network call',
      async (value) => {
        await expect(
          agentConfig({ 'runtime-auto-update': value as string | true }),
        ).rejects.toBeInstanceOf(ExitSignal);

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
        expect(stderr()).toContain('--runtime-auto-update takes "on" or "off"');
      },
    );

    it('combines with --max-pods into ONE PATCH carrying both knobs', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(PINNED), { status: 200 }));

      await agentConfig({ 'max-pods': '3', 'runtime-auto-update': 'off' });

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'PATCH',
        path: '/apps/app1/config',
        body: { maxPods: 3, runtimeAutoUpdate: false },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(stdout()).toContain('Max pods set to 3.');
      expect(stdout()).toContain('Runtime updates: pinned');
    });
  });

  it('no configured appId errors without calling the API', async () => {
    vi.mocked(resolveConfig).mockReturnValueOnce({
      host: 'https://guuey.test',
      apiUrl: 'https://api.guuey.test',
    });

    await expect(agentConfig({})).rejects.toBeInstanceOf(ExitSignal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderr()).toContain('No app ID found');
  });

  describe('--app-id targeting (guuey#183)', () => {
    // The flag was silently swallowed: the command resolved only
    // `config.appId`, so `--app-id <id>` read as broken auth/binding
    // (the staging multi-pod walk fell back to GGUI_APP_ID=<id>).
    it('--app-id wins over the bound config.appId', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SCALED), { status: 200 }));

      await agentConfig({ 'app-id': 'app-override' });

      expect(lastRequest(fetchSpy).path).toBe('/apps/app-override/config');
    });

    it('--app-id targets writes too, not just reads', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SCALED), { status: 200 }));

      await agentConfig({ 'app-id': 'app-override', 'max-pods': '3' });

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'PATCH',
        path: '/apps/app-override/config',
        body: { maxPods: 3 },
      });
    });

    it('--app-id works with NO bound project at all', async () => {
      vi.mocked(resolveConfig).mockReturnValueOnce({
        host: 'https://guuey.test',
        apiUrl: 'https://api.guuey.test',
      });
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SCALED), { status: 200 }));

      await agentConfig({ 'app-id': 'app-override' });

      expect(lastRequest(fetchSpy).path).toBe('/apps/app-override/config');
    });
  });
});
