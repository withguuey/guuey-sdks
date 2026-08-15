/**
 * Tests for `guuey tokens` (`commands/tokens.ts`, guuey#217).
 *
 * The trailing describe block is the SYNC GUARD pinning this module's
 * hand-written wire mirrors against
 * `backend/libs/cli-wire/service-tokens.ts` — the single source cliApi
 * serves those shapes from. Read `../wire-mirror-parse.ts`'s header for
 * why the CLI mirrors instead of importing (published npm package,
 * private source package).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  tokensCreate,
  tokensList,
  tokensRevoke,
  type ServiceTokenCreateResponse,
  type ServiceTokenListResponse,
  type ServiceTokenRevokeResponse,
} from './tokens.js';
import { parseInterfaceFields } from '../wire-mirror-parse';

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
      appId: 'app-1',
    })),
  };
});

/** Thrown by the process.exit mock so execution stops like the real thing. */
class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ITEM = {
  id: 'st-1',
  appId: 'app-1',
  tokenPrefix: 'guuey_svc_abcd',
  label: 'ggui CI',
  createdAt: '2026-08-16T00:00:00.000Z',
};

let fetchMock: MockInstance;
let logs: string[];

beforeEach(() => {
  logs = [];
  fetchMock = vi.spyOn(globalThis, 'fetch');
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tokensCreate', () => {
  it('POSTs the label and prints the plaintext-once secret + revoke recipe', async () => {
    const wire: ServiceTokenCreateResponse = {
      token: 'guuey_svc_raw-secret-once',
      item: ITEM,
    };
    fetchMock.mockResolvedValue(jsonResponse(201, wire));

    await tokensCreate({ label: 'ggui CI' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.guuey.test/apps/app-1/service-tokens');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ label: 'ggui CI' });
    const output = logs.join('\n');
    expect(output).toContain('guuey_svc_raw-secret-once');
    expect(output).toContain('guuey tokens revoke st-1');
  });

  it('exits 1 with usage when --label is missing', async () => {
    await expect(tokensCreate({})).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tokensList', () => {
  it('renders prefix/label/lifecycle and never expects a secret field', async () => {
    const wire: ServiceTokenListResponse = {
      items: [
        { ...ITEM, lastUsedAt: '2026-08-16T01:00:00.000Z' },
        { ...ITEM, id: 'st-2', label: 'old key', revokedAt: '2026-08-10T00:00:00.000Z' },
      ],
    };
    fetchMock.mockResolvedValue(jsonResponse(200, wire));

    await tokensList({});

    const output = logs.join('\n');
    expect(output).toContain('guuey_svc_abcd…');
    expect(output).toContain('active, last used');
    expect(output).toContain('revoked');
  });
});

describe('tokensRevoke', () => {
  it('DELETEs the token path and reports the stamp', async () => {
    const wire: ServiceTokenRevokeResponse = {
      id: 'st-1',
      revokedAt: '2026-08-16T02:00:00.000Z',
    };
    fetchMock.mockResolvedValue(jsonResponse(200, wire));

    await tokensRevoke('st-1', {});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.guuey.test/apps/app-1/service-tokens/st-1');
    expect(init.method).toBe('DELETE');
  });

  it('exits 1 with usage when the tokenId is missing', async () => {
    await expect(tokensRevoke(undefined, {})).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// SYNC GUARD: the wire mirrors above vs.
// `backend/libs/cli-wire/service-tokens.ts`. Reads both sides off disk
// (nothing importable — the source package is private, the CLI is
// published npm; see `../wire-mirror-parse.ts`) and skips when
// `backend/` is absent — a consumer's installed copy has no monorepo
// around it, and the monorepo is the only place drift can start.
// ─────────────────────────────────────────────────────────────────────

function repoPath(relativeToThisFile: string): string {
  return fileURLToPath(new URL(relativeToThisFile, import.meta.url));
}

const WIRE_TOKENS = repoPath('../../../../../backend/libs/cli-wire/service-tokens.ts');
const CLI_TOKENS = repoPath('./tokens.ts');
const haveWire = existsSync(WIRE_TOKENS);

describe.skipIf(!haveWire)('tokens wire mirrors — sync guard against @guuey-private/cli-wire', () => {
  const read = (path: string): string => readFileSync(path, 'utf8');

  it.each([
    'ServiceTokenItem',
    'ServiceTokenCreateResponse',
    'ServiceTokenListResponse',
    'ServiceTokenRevokeResponse',
  ])('%s declares exactly the wire fields, with the same optionality', (name) => {
    expect(parseInterfaceFields(read(CLI_TOKENS), name)).toEqual(
      parseInterfaceFields(read(WIRE_TOKENS), name),
    );
  });
});
