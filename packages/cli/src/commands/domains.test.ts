/**
 * `guuey domains add|list|verify|remove` — request-shape + rendering coverage
 * (guuey#132 slice 1, the re-activation of the formerly gated command group).
 *
 * Same harness as `apps.test.ts`: `domains.ts` builds its own request from
 * `requireAuth()` + `resolveConfig()` + `fetch`, so these tests mock `../auth`
 * and `../config` and spy on `globalThis.fetch`, reading `(url, init)` back
 * into the `{ method, path, body }` shape the request builder produces.
 *
 * The trailing describe block is the SYNC GUARD pinning this module's
 * hand-written wire mirrors against `backend/libs/cli-wire/domains.ts` — the
 * single source cliApi serves those shapes from. Read
 * `../wire-mirror-parse.ts`'s header for why the CLI mirrors instead of
 * importing (published npm package, private source package).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  domainsAdd,
  domainsList,
  domainsRemove,
  domainsVerify,
  type DomainWire,
} from './domains.js';
import { resolveConfig } from '../config.js';
import { parseInterfaceFields, parseStringLiterals } from '../wire-mirror-parse';

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

const CNAME_TARGET = 'app1.agents.dev.sandbox.guuey.com';

/** A still-pending row, exactly as `POST /apps/:id/domains` returns it. */
const PENDING: DomainWire = {
  domain: 'chat.example.com',
  appId: 'app1',
  verified: false,
  verificationStatus: 'pending',
  cnameTarget: CNAME_TARGET,
  addedAt: '2026-08-09T00:00:00.000Z',
};

const VERIFIED: DomainWire = {
  ...PENDING,
  verified: true,
  verificationStatus: 'verified',
  verifiedAt: '2026-08-09T00:05:00.000Z',
};

/** A row whose 7-day verification window elapsed. `verified` is false exactly
 * like pending — only `verificationStatus` tells them apart (the C2 class). */
const FAILED: DomainWire = {
  ...PENDING,
  verificationStatus: 'failed',
  failedAt: '2026-08-16T00:00:00.000Z',
};

describe('guuey domains', () => {
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

  describe('domainsAdd', () => {
    it('POSTs /apps/:id/domains with { domain }', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(PENDING), { status: 201 }));

      await domainsAdd('chat.example.com', { 'app-id': 'app1' });

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'POST',
        path: '/apps/app1/domains',
        body: { domain: 'chat.example.com' },
      });
    });

    it("prints the CNAME instruction with the row's cnameTarget while pending", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(PENDING), { status: 201 }));

      await domainsAdd('chat.example.com', { 'app-id': 'app1' });

      const output = stdout();
      expect(output).toContain('DNS verification pending');
      expect(output).toContain(`chat.example.com  →  ${CNAME_TARGET}`);
      expect(output).toContain('guuey domains verify');
    });

    it('prints the verified copy on an idempotent re-add of a verified row', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(VERIFIED), { status: 200 }));

      await domainsAdd('chat.example.com', { 'app-id': 'app1' });

      expect(stdout()).toContain('added and verified');
      expect(stdout()).not.toContain('Create a CNAME record');
    });

    it('re-add of a FAILED row prints the window-expired copy, not "pending" (C2)', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(FAILED), { status: 200 }));

      await domainsAdd('chat.example.com', { 'app-id': 'app1' });

      const output = stdout();
      expect(output).not.toContain('DNS verification pending');
      expect(output).toContain('7-day');
      expect(output).toContain(`chat.example.com  →  ${CNAME_TARGET}`);
      expect(output).toContain('guuey domains verify chat.example.com');
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('missing domain errors without calling the API', async () => {
      await expect(domainsAdd(undefined, { 'app-id': 'app1' })).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('Usage: guuey domains add');
    });

    it('an invalid domain errors without calling the API', async () => {
      await expect(domainsAdd('not a domain', { 'app-id': 'app1' })).rejects.toBeInstanceOf(
        ExitSignal,
      );

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('Invalid domain');
    });

    it('falls back to resolveConfig().appId when no --app-id is given', async () => {
      vi.mocked(resolveConfig).mockReturnValueOnce({
        host: 'https://guuey.test',
        apiUrl: 'https://api.guuey.test',
        appId: 'app-from-config',
      });
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(PENDING), { status: 201 }));

      await domainsAdd('chat.example.com');

      expect(lastRequest(fetchSpy).path).toBe('/apps/app-from-config/domains');
    });

    it('no --app-id and no configured appId errors without calling the API', async () => {
      await expect(domainsAdd('chat.example.com')).rejects.toBeInstanceOf(ExitSignal);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('No app ID found');
    });

    it('a non-ok response renders the wire envelope code+message, not [object Object]', async () => {
      // Real cliApi envelope: `{ error: { code, message } }` (see
      // backend/amplify/functions/shared/response.ts#httpError).
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'FORBIDDEN', message: 'Custom domains require the Pro plan' },
          }),
          { status: 403 },
        ),
      );

      await expect(
        domainsAdd('chat.example.com', { 'app-id': 'app1' }),
      ).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(stderr()).toContain('FORBIDDEN');
      expect(stderr()).toContain('Custom domains require the Pro plan');
      expect(stderr()).not.toContain('[object Object]');
    });
  });

  describe('domainsList', () => {
    it('GETs /apps/:id/domains', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ domains: [], defaultDomain: CNAME_TARGET }), {
          status: 200,
        }),
      );

      await domainsList({ 'app-id': 'app1' });

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'GET',
        path: '/apps/app1/domains',
        body: undefined,
      });
    });

    it('prints the default-domain line and the empty-state message', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ domains: [], defaultDomain: CNAME_TARGET }), {
          status: 200,
        }),
      );

      await domainsList({ 'app-id': 'app1' });

      expect(stdout()).toContain(`Default: ${CNAME_TARGET}`);
      expect(stdout()).toContain('No custom domains configured.');
    });

    it('renders per-row status from verificationStatus — failed is ✗, not pending', async () => {
      // The failed row also has `verified: false`, so a renderer that infers
      // from the boolean would print it as pending. The wire carries
      // `verificationStatus` exactly so the CLI does not have to guess.
      const rows: DomainWire[] = [
        { ...VERIFIED, domain: 'a.example.com' },
        { ...PENDING, domain: 'b.example.com' },
        {
          ...PENDING,
          domain: 'c.example.com',
          verificationStatus: 'failed',
          failedAt: '2026-08-16T00:00:00.000Z',
        },
      ];
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ domains: rows, defaultDomain: CNAME_TARGET }), {
          status: 200,
        }),
      );

      await domainsList({ 'app-id': 'app1' });

      const output = stdout();
      expect(output).toContain('a.example.com  ✓ verified');
      expect(output).toContain('b.example.com  ⏳ pending');
      expect(output).toContain('c.example.com  ✗ failed');
    });

    it('renders the serving/TLS state when the wire carries servingStatus — and no serving column when absent', async () => {
      const rows: DomainWire[] = [
        { ...VERIFIED, domain: 'a.example.com', servingStatus: 'active' },
        { ...VERIFIED, domain: 'b.example.com', servingStatus: 'provisioning' },
        { ...VERIFIED, domain: 'c.example.com', servingStatus: 'failed' },
        // Pre-edge row (reconciler hasn't converged): verification only.
        { ...VERIFIED, domain: 'd.example.com' },
      ];
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ domains: rows, defaultDomain: CNAME_TARGET }), {
          status: 200,
        }),
      );

      await domainsList({ 'app-id': 'app1' });

      const output = stdout();
      expect(output).toContain('a.example.com  ✓ verified  🔒 serving  →');
      expect(output).toContain('b.example.com  ✓ verified  ⏳ TLS provisioning  →');
      expect(output).toContain('c.example.com  ✓ verified  ✗ TLS failed  →');
      expect(output).toContain(`d.example.com  ✓ verified  →  ${CNAME_TARGET}`);
    });

    it('a non-ok response renders the wire envelope message and exits 1', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'App app1 not found' } }),
          { status: 404 },
        ),
      );

      await expect(domainsList({ 'app-id': 'app1' })).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(stderr()).toContain('App app1 not found');
      expect(stderr()).not.toContain('[object Object]');
    });
  });

  describe('domainsVerify', () => {
    it('POSTs /apps/:id/domains/verify with { domain }', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(VERIFIED), { status: 200 }));

      await domainsVerify('chat.example.com', { 'app-id': 'app1' });

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'POST',
        path: '/apps/app1/domains/verify',
        body: { domain: 'chat.example.com' },
      });
    });

    it('prints the serving-aware success copy and exits 0 when the row was promoted', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(VERIFIED), { status: 200 }));

      await domainsVerify('chat.example.com', { 'app-id': 'app1' });

      // The spec copy (component 5): verification is done, serving/TLS is
      // the edge's asynchronous half — the success message says so.
      expect(stdout()).toContain(
        'chat.example.com verified — TLS is provisioning, usually live in minutes',
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("still pending → prints the CNAME instruction and exits 1 (C18)", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(PENDING), { status: 200 }));

      await expect(
        domainsVerify('chat.example.com', { 'app-id': 'app1' }),
      ).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(stderr()).toContain('CNAME not found yet');
      expect(stdout()).toContain(`chat.example.com  →  ${CNAME_TARGET}`);
    });

    it('FAILED row → prints the window-expired re-arm copy and exits 1 (C2+C18)', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(FAILED), { status: 200 }));

      await expect(
        domainsVerify('chat.example.com', { 'app-id': 'app1' }),
      ).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(stderr()).toContain('7-day');
      expect(stderr()).not.toContain('CNAME not found yet');
      expect(stdout()).toContain(`chat.example.com  →  ${CNAME_TARGET}`);
      expect(stdout()).toContain('guuey domains verify chat.example.com');
    });

    it('missing domain errors without calling the API', async () => {
      await expect(domainsVerify(undefined, { 'app-id': 'app1' })).rejects.toBeInstanceOf(
        ExitSignal,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('Usage: guuey domains verify');
    });
  });

  describe('domainsRemove', () => {
    it('DELETEs /apps/:id/domains with { domain }', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ removed: 'chat.example.com' }), { status: 200 }),
      );

      await domainsRemove('chat.example.com', { 'app-id': 'app1' });

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'DELETE',
        path: '/apps/app1/domains',
        body: { domain: 'chat.example.com' },
      });
    });

    it("prints the removed hostname from the wire response's `removed` field", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ removed: 'chat.example.com' }), { status: 200 }),
      );

      await domainsRemove('chat.example.com', { 'app-id': 'app1' });

      expect(stdout()).toContain('chat.example.com removed');
    });

    it('missing domain errors without calling the API', async () => {
      await expect(domainsRemove(undefined, { 'app-id': 'app1' })).rejects.toBeInstanceOf(
        ExitSignal,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('Usage: guuey domains remove');
    });

    it('a non-ok response renders the wire envelope message and exits 1', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'chat.example.com is not registered' } }),
          { status: 404 },
        ),
      );

      await expect(
        domainsRemove('chat.example.com', { 'app-id': 'app1' }),
      ).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(stderr()).toContain('chat.example.com is not registered');
      expect(stderr()).not.toContain('[object Object]');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// SYNC GUARD: the wire mirrors above vs. `backend/libs/cli-wire/domains.ts`.
// Reads both sides off disk (nothing importable — the source package is
// private, the CLI is published npm; see `../wire-mirror-parse.ts`) and
// skips when `backend/` is absent — a consumer's installed copy has no
// monorepo around it, and the monorepo is the only place drift can start.
// ─────────────────────────────────────────────────────────────────────

function repoPath(relativeToThisFile: string): string {
  return fileURLToPath(new URL(relativeToThisFile, import.meta.url));
}

const WIRE_DOMAINS = repoPath('../../../../../backend/libs/cli-wire/domains.ts');
const CLI_DOMAINS = repoPath('./domains.ts');
const haveWire = existsSync(WIRE_DOMAINS);

describe.skipIf(!haveWire)('domains wire mirrors — sync guard against @guuey-private/cli-wire', () => {
  // Read lazily inside the cases: at module load `backend/` may be absent
  // (consumer install), and `skipIf` only guards the cases themselves.
  const read = (path: string): string => readFileSync(path, 'utf8');

  it.each(['DomainWire', 'DomainsListResponse', 'DomainRemoveResponse'])(
    '%s declares exactly the wire fields, with the same optionality',
    (name) => {
      expect(parseInterfaceFields(read(CLI_DOMAINS), name)).toEqual(
        parseInterfaceFields(read(WIRE_DOMAINS), name),
      );
    },
  );

  it('DomainVerificationStatus is exactly the wire union, in order', () => {
    expect(parseStringLiterals(read(CLI_DOMAINS), 'DomainVerificationStatus')).toEqual(
      parseStringLiterals(read(WIRE_DOMAINS), 'DomainVerificationStatus'),
    );
  });
});
