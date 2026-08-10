/**
 * `guuey slug claim|release` — request-shape + rendering coverage
 * (guuey#137 slice 3, the un-gating of the formerly roadmap-noticed command).
 *
 * Same harness as `domains.test.ts`: `slug.ts` builds its own request from
 * `requireAuth()` + `resolveConfig()` + `fetch`, so these tests mock
 * `../auth` and `../config` and spy on `globalThis.fetch`, reading
 * `(url, init)` back into the `{ method, path, body }` shape the request
 * builder produces.
 *
 * The trailing describe block is the SYNC GUARD pinning this module's
 * hand-written mirrors — the wire types, the slug regex's SOURCE TEXT, and
 * the reserved denylist — against `backend/libs/cli-wire/slug.ts`, the
 * single source cliApi validates from. A drift in either direction means
 * the CLI refuses (or accepts) something the server does not. Read
 * `../wire-mirror-parse.ts`'s header for why the CLI mirrors instead of
 * importing (published npm package, private source package).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { slugClaim, slugRelease, type SlugClaimResponse } from './slug.js';
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

const CLAIMED: SlugClaimResponse = {
  appId: 'app1',
  slug: 'weather-bot',
  host: 'weather-bot.agents.guuey.com',
};

describe('guuey slug', () => {
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

  describe('slugClaim', () => {
    it('POSTs /apps/:id/slug with the NORMALIZED slug', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(CLAIMED), { status: 201 }));

      await slugClaim('  Weather-Bot ', { 'app-id': 'app1' });

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'POST',
        path: '/apps/app1/slug',
        body: { slug: 'weather-bot' },
      });
    });

    it("prints the SERVER's host verbatim — never a locally derived one", async () => {
      // The whole point of the response carrying `host`: the published CLI
      // has no `agentsDomain` to read, and prod's slug family differs from
      // the canonical one. Printing anything self-derived was the bug.
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(CLAIMED), { status: 201 }));

      await slugClaim('weather-bot', { 'app-id': 'app1' });

      expect(stdout()).toContain('https://weather-bot.agents.guuey.com');
      expect(stdout()).toContain('/agent/weather-bot');
    });

    it('names the replaced slug on a change', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ ...CLAIMED, previousSlug: 'old-name' }), {
          status: 200,
        }),
      );

      await slugClaim('weather-bot', { 'app-id': 'app1' });

      expect(stdout()).toContain('Previous slug: old-name');
    });

    it('a first claim mentions no previous slug', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(CLAIMED), { status: 201 }));

      await slugClaim('weather-bot', { 'app-id': 'app1' });

      expect(stdout()).not.toContain('Previous slug');
    });

    it('missing slug errors without calling the API', async () => {
      await expect(slugClaim(undefined, { 'app-id': 'app1' })).rejects.toBeInstanceOf(
        ExitSignal,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('Usage: guuey slug claim');
    });

    it.each(['ab', 'a', '-lead', 'trail-', 'has space', 'under_score'])(
      'refuses %j client-side, before any network call',
      async (candidate) => {
        await expect(slugClaim(candidate, { 'app-id': 'app1' })).rejects.toBeInstanceOf(
          ExitSignal,
        );
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(stderr()).toContain('Invalid slug');
      },
    );

    it('refuses a reserved name client-side', async () => {
      await expect(slugClaim('admin', { 'app-id': 'app1' })).rejects.toBeInstanceOf(
        ExitSignal,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('reserved');
    });

    it('a non-ok response renders the wire envelope message and exits 1', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'CONFLICT', message: 'Slug "weather-bot" is already taken.' },
          }),
          { status: 409 },
        ),
      );

      await expect(slugClaim('weather-bot', { 'app-id': 'app1' })).rejects.toBeInstanceOf(
        ExitSignal,
      );

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(stderr()).toContain('already taken');
      expect(stderr()).not.toContain('[object Object]');
    });
  });

  describe('slugRelease', () => {
    it('DELETEs /apps/:id/slug with no body', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ released: 'weather-bot' }), { status: 200 }),
      );

      await slugRelease({ 'app-id': 'app1' });

      expect(lastRequest(fetchSpy)).toEqual({
        method: 'DELETE',
        path: '/apps/app1/slug',
        body: undefined,
      });
    });

    it("prints the released slug from the wire response's `released` field", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ released: 'weather-bot' }), { status: 200 }),
      );

      await slugRelease({ 'app-id': 'app1' });

      expect(stdout()).toContain('weather-bot released');
    });

    it('a non-ok response renders the wire envelope message and exits 1', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'NOT_FOUND', message: 'App app1 has no slug to release' },
          }),
          { status: 404 },
        ),
      );

      await expect(slugRelease({ 'app-id': 'app1' })).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(stderr()).toContain('no slug to release');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// SYNC GUARD: the mirrors above vs. `backend/libs/cli-wire/slug.ts`.
// Reads both sides off disk (nothing importable — the source package is
// private, the CLI is published npm; see `../wire-mirror-parse.ts`) and
// skips when `backend/` is absent — a consumer's installed copy has no
// monorepo around it, and the monorepo is the only place drift can start.
// ─────────────────────────────────────────────────────────────────────

function repoPath(relativeToThisFile: string): string {
  return fileURLToPath(new URL(relativeToThisFile, import.meta.url));
}

const WIRE_SLUG = repoPath('../../../../../backend/libs/cli-wire/slug.ts');
const CLI_SLUG = repoPath('./slug.ts');
const haveWire = existsSync(WIRE_SLUG);

/**
 * The `SLUG_RE` literal's SOURCE TEXT. Both sides declare it on one line as
 * `const SLUG_RE = /…/;` — comparing the text (rather than two `RegExp`
 * objects, which cannot be imported across the package boundary) is what
 * makes this a guard rather than a restatement.
 */
function slugRegexSource(source: string): string {
  const match = /^\s*const SLUG_RE = (\/.+\/);\s*$/m.exec(source);
  if (match === null) {
    throw new Error('no single-line `const SLUG_RE = /…/;` declaration in source');
  }
  return match[1];
}

describe.skipIf(!haveWire)('slug mirrors — sync guard against @guuey-private/cli-wire', () => {
  // Read lazily inside the cases: at module load `backend/` may be absent
  // (consumer install), and `skipIf` only guards the cases themselves.
  const read = (path: string): string => readFileSync(path, 'utf8');

  it.each(['SlugClaimResponse', 'SlugReleaseResponse'])(
    '%s declares exactly the wire fields, with the same optionality',
    (name) => {
      expect(parseInterfaceFields(read(CLI_SLUG), name)).toEqual(
        parseInterfaceFields(read(WIRE_SLUG), name),
      );
    },
  );

  it('SLUG_RE is byte-identical to the wire rule — ONE regex, two copies', () => {
    expect(slugRegexSource(read(CLI_SLUG))).toBe(slugRegexSource(read(WIRE_SLUG)));
  });

  it('RESERVED_SLUGS is exactly the wire denylist, in order', () => {
    expect(parseStringLiterals(read(CLI_SLUG), 'RESERVED_SLUGS')).toEqual(
      parseStringLiterals(read(WIRE_SLUG), 'RESERVED_SLUGS'),
    );
  });

  it('the guard itself is not a tautology — it fails on a drifted regex', () => {
    expect(() => slugRegexSource('const SLUG_RE = // not a regex')).toThrow();
    expect(slugRegexSource('const SLUG_RE = /^x$/;')).toBe('/^x$/');
  });
});
