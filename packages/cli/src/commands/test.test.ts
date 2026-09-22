/**
 * `guuey test` — the pod's invoke contract (guuey#681) + endpoint
 * resolution (S13).
 *
 * guuey#681: the command POSTed `{ message, history: [] }` at `<base>/invoke`
 * with the platform PAT as a Bearer — a define-agent-era relic. The pod's
 * ONE contract (`nocode-runtime/src/invoke-request.ts`, served by
 * `sse-server.ts`) is `{ input, sessionId? }` at `/agent/invoke`, no PAT (the pod 401s any non-Cognito
 * Bearer, never a guest fallback), and its stream is AgJSON, not
 * Anthropic-native frames. These assertions pin every one of those.
 *
 * S13: `resolveAgentEndpoint`'s last-resort fallback was `config.host` — the
 * PLATFORM host, not an agent pod. The fix looks up
 * `GET /apps/:id/deployments` (newest-first, first row with a live
 * `endpointUrl`) and never guesses.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  buildInvokeRequest,
  GUEST_HEADER_NAME,
  isGuestSecret,
  loadThreadSecret,
  mintGuestSecret,
  resolveAgentEndpoint,
  saveThreadSecret,
  streamToStdout,
  test as testCommand,
  threadFollowUp,
  threadSecretPath,
  toInvokeUrl,
} from './test.js';
import type { resolveConfig } from '../config.js';
import { parseInterfaceFields } from '../wire-mirror-parse';

// guuey#1600: the command saves visitor secrets under ~/.guuey — every test
// points that at a throwaway directory instead (set per test below).
const threadsDir = vi.hoisted(() => ({ current: '' }));
vi.mock('../paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../paths.js')>();
  return { ...actual, getTestThreadsDir: vi.fn(() => threadsDir.current) };
});
vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return { ...actual, requireAuth: vi.fn(() => ({ pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' })) };
});
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    resolveConfig: vi.fn(() => ({ host: 'https://platform.guuey.test', apiUrl: 'https://api.guuey.test', appId: 'app-1' })),
  };
});

const SECRET = 'a'.repeat(64);

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

describe('toInvokeUrl — one `/agent/invoke`, whatever shape the caller holds', () => {
  it('appends /agent/invoke to a pod base URL', () => {
    expect(toInvokeUrl('https://app-1.agents.dev.sandbox.guuey.com')).toBe(
      'https://app-1.agents.dev.sandbox.guuey.com/agent/invoke',
    );
  });

  it('passes a full invoke URL (the deploy-controller record) through verbatim', () => {
    expect(toInvokeUrl('https://app-1.agents.dev.sandbox.guuey.com/agent/invoke')).toBe(
      'https://app-1.agents.dev.sandbox.guuey.com/agent/invoke',
    );
  });

  it('drops trailing slashes before deciding', () => {
    expect(toInvokeUrl('https://custom.example.com/')).toBe('https://custom.example.com/agent/invoke');
    expect(toInvokeUrl('https://custom.example.com/agent/invoke/')).toBe(
      'https://custom.example.com/agent/invoke',
    );
  });
});

describe('buildInvokeRequest — the pod contract, not the retired one', () => {
  it('sends { input, sessionId } as JSON to the invoke URL', () => {
    const { url, init } = buildInvokeRequest('https://pod.example', {
      input: 'hello',
      sessionId: 'sess-1',
    }, SECRET);
    expect(url).toBe('https://pod.example/agent/invoke');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ input: 'hello', sessionId: 'sess-1' });
  });

  it('never sends the retired { message, history } shape', () => {
    const { init } = buildInvokeRequest('https://pod.example', { input: 'hello' }, SECRET);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ input: 'hello' });
    expect(body).not.toHaveProperty('message');
    expect(body).not.toHaveProperty('history');
  });

  it('carries the visitor guest header and NO Authorization — the PAT authenticates the platform API, never the pod (guuey#1600)', () => {
    const { init } = buildInvokeRequest('https://pod.example', { input: 'hello' }, SECRET);
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(['accept', 'content-type', 'x-guuey-guest']);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get(GUEST_HEADER_NAME)).toBe(SECRET);
    // No Bearer of any kind, so the pod's `Token use not allowed: id` (access-vs-ID) refusal cannot arise here.
    expect(headers.has('authorization')).toBe(false);
  });

  it('refuses a guest secret the pod would ignore (not 64 hex)', () => {
    expect(() => buildInvokeRequest('https://pod.example', { input: 'hi' }, 'short')).toThrow(/64 hex/);
  });

  it('carries threadId when continuing a conversation', () => {
    const { init } = buildInvokeRequest('https://pod.example', { input: 'hi', threadId: 't-1' }, SECRET);
    expect(JSON.parse(String(init.body))).toEqual({ input: 'hi', threadId: 't-1' });
  });
});

// The pod's InvokeRequest lives in the private runtime; the CLI mirrors the
// subset it sends. Read both off disk (same pattern as wire-sync.test.ts),
// skip outside the monorepo.
const POD_INVOKE_REQUEST = fileURLToPath(
  new URL('../../../../../backend/services/nocode-runtime/src/invoke-request.ts', import.meta.url),
);
const CLI_TEST_COMMAND = fileURLToPath(new URL('./test.ts', import.meta.url));

describe.skipIf(!existsSync(POD_INVOKE_REQUEST))(
  'InvokeBody sync guard — every CLI field is a pod InvokeRequest field with the same optionality',
  () => {
    it('input (required), sessionId and threadId (optional) match invoke-request.ts', () => {
      const pod = parseInterfaceFields(readFileSync(POD_INVOKE_REQUEST, 'utf8'), 'InvokeRequest');
      const cli = parseInterfaceFields(readFileSync(CLI_TEST_COMMAND, 'utf8'), 'InvokeBody');
      expect(cli.map((f) => f.name)).toEqual(['input', 'sessionId', 'threadId']);
      for (const field of cli) {
        const podField = pod.find((f) => f.name === field.name);
        expect(podField, `pod InvokeRequest lacks ${field.name}`).toBeDefined();
        expect(podField?.optional, `${field.name} optionality`).toBe(field.optional);
      }
    });
  },
);

const POD_IDENTITY = fileURLToPath(
  new URL('../../../../../backend/services/nocode-runtime/src/identity.ts', import.meta.url),
);

describe.skipIf(!existsSync(POD_IDENTITY))('guest header sync guard (guuey#1600)', () => {
  it("GUEST_HEADER_NAME and the 64-hex secret shape match the pod's identity.ts", () => {
    const pod = readFileSync(POD_IDENTITY, 'utf8');
    expect(pod).toContain(`export const GUEST_HEADER_NAME = '${GUEST_HEADER_NAME}';`);
    expect(pod).toContain('return /^[a-f0-9]{64}$/i.test(value);');
  });
});

describe('the visitor secret store (guuey#1600)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guuey-test-threads-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('mints a fresh 64-hex visitor each time', () => {
    const a = mintGuestSecret();
    const b = mintGuestSecret();
    expect(isGuestSecret(a)).toBe(true);
    expect(isGuestSecret(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('saves at <dir>/<appId>/<threadId> (dir 0700, file 0600) and loads it back', () => {
    saveThreadSecret('app-1', 'thread-1', SECRET, dir);
    const file = threadSecretPath('app-1', 'thread-1', dir);
    expect(file).toBe(join(dir, 'app-1', 'thread-1'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'app-1')).mode & 0o777).toBe(0o700);
    expect(loadThreadSecret('app-1', 'thread-1', dir)).toBe(SECRET);
  });

  it('a thread with no saved secret, or a malformed one, loads as undefined', () => {
    expect(loadThreadSecret('app-1', 'nope', dir)).toBeUndefined();
    mkdirSync(join(dir, 'app-1'), { recursive: true });
    writeFileSync(join(dir, 'app-1', 'bad'), 'not-a-secret\n');
    expect(loadThreadSecret('app-1', 'bad', dir)).toBeUndefined();
  });

  it('never builds a path that leaves the directory', () => {
    expect(() => threadSecretPath('app-1', '../escape', dir)).toThrow(/thread id/);
    expect(() => threadSecretPath('app-1', '..', dir)).toThrow(/thread id/);
    expect(() => threadSecretPath('a/b', 't', dir)).toThrow(/app id/);
  });
});

describe("threadFollowUp — save the thread's visitor, say how to continue (guuey#1600)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guuey-test-threads-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const base = { appId: 'app-1', appIdFlag: undefined, guestSecret: SECRET, errored: false } as const;

  it('a new thread: saves its secret and prints the exact next command', () => {
    const lines = threadFollowUp({ ...base, threadFlag: undefined, threadId: 't-9', dir });
    expect(loadThreadSecret('app-1', 't-9', dir)).toBe(SECRET);
    expect(lines).toEqual(['  Continue this conversation: guuey test "<message>" --thread t-9']);
  });

  it('carries --app-id into the printed command when it was passed', () => {
    const lines = threadFollowUp({ ...base, appIdFlag: 'app-1', threadFlag: undefined, threadId: 't-9', dir });
    expect(lines.at(-1)).toBe('  Continue this conversation: guuey test "<message>" --thread t-9 --app-id app-1');
  });

  it('a requested thread the pod did NOT continue is a warning line, never silent', () => {
    const lines = threadFollowUp({ ...base, threadFlag: 't-1', threadId: 't-2', dir });
    expect(lines[0]).toBe('  ! the pod started a NEW thread t-2 instead of continuing t-1');
  });

  it('no thread named: a note (or a warning when --thread was asked); an errored turn adds nothing', () => {
    expect(threadFollowUp({ ...base, threadFlag: undefined, threadId: undefined, dir })[0]).toMatch(/named no thread/);
    expect(threadFollowUp({ ...base, threadFlag: 't-1', threadId: undefined, dir })[0]).toMatch(/^ {2}! .*t-1 was not continued/);
    expect(threadFollowUp({ ...base, threadFlag: undefined, threadId: undefined, errored: true, dir })).toEqual([]);
  });
});

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('streamToStdout — renders the pod stream (AgJSON), not Anthropic-native frames', () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture(): { written: () => string; logged: () => string } {
    const chunks: string[] = [];
    const logs: string[] = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { written: () => chunks.join(''), logged: () => logs.join('\n') };
  }

  it('prints text deltas as they arrive, tool markers, and returns the done stopReason', async () => {
    const { written, logged } = capture();
    const result = await streamToStdout(
      sseStream([
        frame('session', { sessionId: 'sess-1', userId: 'g_x', authMode: 'anonymous', threadId: 't-9' }),
        frame('message', { type: 'tool.start', toolCallId: 'c1', name: 'weather', seq: 1 }),
        frame('message', { type: 'tool.done', toolCallId: 'c1', content: [], seq: 2 }),
        frame('message', { type: 'text.delta', id: 'm1', delta: 'Sunny ', seq: 3 }),
        frame('message', { type: 'text.delta', id: 'm1', delta: 'in Tokyo', seq: 4 }),
        frame('message', { type: 'text.end', id: 'm1', seq: 5 }),
        frame('done', { stopReason: 'end_turn', threadId: 't-9' }),
      ]),
    );

    expect(written()).toBe('Sunny in Tokyo\n');
    expect(logged()).toContain('[session] sess-1 · thread t-9');
    expect(logged()).toContain('[tool.start] weather');
    expect(logged()).toContain('[tool.done]');
    expect(result).toEqual({ stopReason: 'end_turn', errored: false, threadId: 't-9' });
    expect(errSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it('surfaces an error frame and reports errored', async () => {
    const { written } = capture();
    const result = await streamToStdout(
      sseStream([
        frame('error', { code: 'TIMEOUT', message: 'invoke exceeded the 30-minute ceiling' }),
        frame('done', { stopReason: 'aborted' }),
      ]),
    );
    expect(result).toEqual({ stopReason: 'aborted', errored: true });
    expect(written()).toBe('');
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('TIMEOUT');
    expect(printed).toContain('invoke exceeded');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('ignores Anthropic-native frames — the pod never sends them, so they print nothing', async () => {
    const { written } = capture();
    await streamToStdout(
      sseStream([
        frame('message', {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'never rendered' },
        }),
        frame('done', { stopReason: 'end_turn' }),
      ]),
    );
    expect(written()).toBe('');
  });
});

describe('resolveAgentEndpoint', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the --url flag wins over everything, with no network call, normalised to the invoke URL', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');

    const endpoint = await resolveAgentEndpoint(config, { url: 'https://custom.example.com/' }, pat);

    expect(endpoint).toBe('https://custom.example.com/agent/invoke');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the deployed endpointUrl VERBATIM — it is already the full invoke URL the controller wrote', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          deployments: [
            {
              status: 'live',
              endpointUrl: 'https://app-1.agents.dev.sandbox.guuey.com/agent/invoke',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const endpoint = await resolveAgentEndpoint(config, {}, pat);

    expect(endpoint).toBe('https://app-1.agents.dev.sandbox.guuey.com/agent/invoke');
    const [url] = fetchSpy.mock.calls.at(-1)!;
    expect(new URL(String(url)).pathname).toBe('/apps/app-1/deployments');
  });

  it('picks the newest row that has an endpointUrl, skipping newer rows without one', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          deployments: [
            { status: 'building', endpointUrl: null },
            { status: 'live', endpointUrl: 'https://app-1.agents.dev.sandbox.guuey.com/agent/invoke' },
          ],
        }),
        { status: 200 },
      ),
    );

    expect(await resolveAgentEndpoint(config, {}, pat)).toBe(
      'https://app-1.agents.dev.sandbox.guuey.com/agent/invoke',
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

describe('guuey test --thread / --app-id — the command end to end (guuey#1600)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let exitSpy: MockInstance<typeof process.exit>;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    threadsDir.current = mkdtempSync(join(tmpdir(), 'guuey-test-threads-'));
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as typeof process.exit);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    rmSync(threadsDir.current, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const podAnswer = (threadId: string) =>
    new Response(
      sseStream([
        frame('session', { sessionId: threadId, threadId }),
        frame('message', { type: 'text.delta', delta: 'ok' }),
        frame('done', { stopReason: 'end_turn' }),
      ]),
      { status: 200 },
    );
  const sent = (i = 0) => {
    const [url, init] = fetchSpy.mock.calls[i] as [string, RequestInit];
    return { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) as Record<string, unknown> };
  };

  it('turn 1 (no --thread): a fresh visitor, today\'s test-* session, and the minted thread\'s secret is saved', async () => {
    fetchSpy.mockResolvedValueOnce(podAnswer('t-new'));
    await testCommand('hello', { url: 'https://pod.example' });
    const req = sent();
    expect(req.url).toBe('https://pod.example/agent/invoke');
    expect(isGuestSecret(req.headers.get(GUEST_HEADER_NAME) ?? '')).toBe(true);
    expect(req.body['threadId']).toBeUndefined();
    expect(String(req.body['sessionId'])).toMatch(/^test-\d+$/);
    expect(loadThreadSecret('app-1', 't-new', threadsDir.current)).toBe(req.headers.get(GUEST_HEADER_NAME));
    expect(logs.join('\n')).toContain('--thread t-new');
  });

  it('turn 2 (--thread): the SAME visitor, threadId sent, no sessionId (the pod keys the session to the thread)', async () => {
    saveThreadSecret('app-1', 't-new', SECRET, threadsDir.current);
    fetchSpy.mockResolvedValueOnce(podAnswer('t-new'));
    await testCommand('and again', { url: 'https://pod.example', thread: 't-new' });
    const req = sent();
    expect(req.headers.get(GUEST_HEADER_NAME)).toBe(SECRET);
    expect(req.body).toEqual({ input: 'and again', threadId: 't-new' });
    expect(logs.join('\n')).not.toContain('NEW thread');
  });

  it('--thread with no saved visitor on this machine is refused BEFORE any network call', async () => {
    await expect(testCommand('hi', { url: 'https://pod.example', thread: 'someone-elses' })).rejects.toThrow(ExitSignal);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/No visitor identity saved for thread someone-elses/);
  });

  it('a valueless --thread / --app-id / --session is refused, never read as "no thread"', async () => {
    for (const name of ['thread', 'app-id', 'session']) {
      await expect(testCommand('hi', { url: 'https://pod.example', [name]: true })).rejects.toThrow(ExitSignal);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('--app-id overrides the binding for this call: the secret is filed under that app', async () => {
    fetchSpy.mockResolvedValueOnce(podAnswer('t-x'));
    await testCommand('hello', { url: 'https://pod.example', 'app-id': 'app-2' });
    expect(loadThreadSecret('app-2', 't-x', threadsDir.current)).toBeDefined();
    expect(loadThreadSecret('app-1', 't-x', threadsDir.current)).toBeUndefined();
    expect(logs.join('\n')).toContain('App:      app-2');
    expect(logs.join('\n')).toContain('--thread t-x --app-id app-2');
  });
});
