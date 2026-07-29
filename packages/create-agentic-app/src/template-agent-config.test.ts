/**
 * Behavioural test for the scaffolded worker's endpoint resolution
 * (`templates-src/frameworks/<fw>/src/agent-config.ts#mcpEndpoints`).
 *
 * The two framework overlays carry byte-identical copies of `agent-config.ts`
 * by design (template code must be self-contained — no cross-overlay
 * imports), so this suite exercises the claude copy and separately asserts the
 * openai copy is byte-identical to it.
 *
 * Contract under test (guuey#25 T4): the credential DIRECTORY the Router-side
 * broker writes is the source of truth — it carries federated AND
 * platform-injected servers that never appear in the declared map — unioned
 * with declared `external` entries that have no credential file.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuueyAgent } from '@guuey/config';
import type { Invoke } from '@guuey/worker';
import { mcpEndpoints } from '../templates-src/frameworks/claude-agent-sdk/src/agent-config';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'caa-agent-config-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** An `Invoke` whose session dir is `<root>/session` (cred dir written or not). */
function invokeWithCreds(creds: Record<string, unknown> | undefined): Invoke {
  const session = join(root, 'session');
  mkdirSync(session, { recursive: true });
  if (creds !== undefined) {
    const dir = join(session, '.guuey', 'credentials');
    mkdirSync(dir, { recursive: true });
    for (const [name, cred] of Object.entries(creds)) {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(cred), 'utf8');
    }
  }
  return {
    type: 'invoke',
    input: 'hello',
    identity: { userId: 'u_1', authMode: 'authenticated' },
    fs: { app: join(root, 'app'), home: join(root, 'home'), session },
    history: [],
  };
}

const agent: GuueyAgent = {
  mcpServers: {
    ggui: { kind: 'external', url: 'https://mcp.ggui.ai', transport: 'http' },
    todo: { kind: 'external', url: 'http://127.0.0.1:6782/mcp', headers: { 'x-static': 'yes' } },
  },
};

describe('template mcpEndpoints (guuey#25 T4)', () => {
  it('unions the credential directory with the declared map — incl. a name the map never declares', () => {
    const invoke = invokeWithCreds({
      ggui: {
        url: 'https://dev.mcp.ggui.ai/apps/app_42',
        transport: 'http',
        headers: { authorization: 'Bearer tok-ggui' },
      },
      'guuey-memory': {
        url: 'http://127.0.0.1:9111/mcp',
        transport: 'sse',
        headers: { authorization: 'Bearer tok-mem' },
      },
    });

    expect(mcpEndpoints(invoke, agent)).toEqual({
      // credential wins over the declared canonical URL (env-rewrite + minting)
      ggui: {
        url: 'https://dev.mcp.ggui.ai/apps/app_42',
        transport: 'http',
        headers: { authorization: 'Bearer tok-ggui' },
      },
      // platform-injected: never declared, only ever a credential file
      'guuey-memory': {
        url: 'http://127.0.0.1:9111/mcp',
        transport: 'sse',
        headers: { authorization: 'Bearer tok-mem' },
      },
      // declared-only: plain endpoint, static headers survive
      todo: { url: 'http://127.0.0.1:6782/mcp', transport: 'http', headers: { 'x-static': 'yes' } },
    });
  });

  it('no credential directory -> declared externals only (nothing invented, nothing dropped)', () => {
    expect(mcpEndpoints(invokeWithCreds(undefined), agent)).toEqual({
      ggui: { url: 'https://mcp.ggui.ai', transport: 'http', headers: {} },
      todo: { url: 'http://127.0.0.1:6782/mcp', transport: 'http', headers: { 'x-static': 'yes' } },
    });
  });

  it('skips non-external and opted-out entries', () => {
    const invoke = invokeWithCreds({});
    const mixed: GuueyAgent = {
      mcpServers: {
        ggui: false,
        api: { kind: 'external', url: 'https://mcp.example.com' },
        own: { kind: 'colocated', source: './mcps/todo' },
      },
    };
    expect(mcpEndpoints(invoke, mixed)).toEqual({
      api: { url: 'https://mcp.example.com', transport: 'http', headers: {} },
    });
  });

  it('logs both sets honestly — no silent fallback', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const invoke = invokeWithCreds({
      ggui: { url: 'https://dev.mcp.ggui.ai/apps/app_42', transport: 'http', headers: {} },
      'guuey-memory': { url: 'http://127.0.0.1:9111/mcp', transport: 'sse', headers: {} },
    });
    mcpEndpoints(invoke, agent);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('[guuey] mcp endpoints:');
    expect(line).toContain('ggui');
    expect(line).toContain('guuey-memory');
    expect(line).toMatch(/declared-only=\[todo\]/);
  });

  it('a malformed credential file does not shadow the declared entry', () => {
    const session = join(root, 'session');
    const dir = join(session, '.guuey', 'credentials');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ggui.json'), '{ not json', 'utf8');
    const invoke: Invoke = {
      type: 'invoke',
      input: 'hello',
      identity: { userId: 'u_1', authMode: 'authenticated' },
      fs: { app: join(root, 'app'), home: join(root, 'home'), session },
      history: [],
    };
    expect(mcpEndpoints(invoke, agent).ggui).toEqual({
      url: 'https://mcp.ggui.ai',
      transport: 'http',
      headers: {},
    });
  });

  it('the two framework overlays keep byte-identical agent-config.ts copies', () => {
    const read = (fw: string) =>
      readFileSync(
        join(__dirname, '..', 'templates-src', 'frameworks', fw, 'src', 'agent-config.ts'),
        'utf8'
      );
    expect(read('openai-agents-sdk')).toBe(read('claude-agent-sdk'));
  });
});
