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
  BEARER_ARGV_FLAGS,
  BEARER_IN_ARGV,
  bearerArgvRefusal,
  BearerInputError,
  buildInvokeRequest,
  GUEST_HEADER_NAME,
  MAX_BEARER_BYTES,
  POD_STREAM_EVENTS,
  readBearer,
  redactCaller,
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
import type { BearerInput } from './test.js';
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
const GUEST = { kind: 'guest', secret: SECRET } as const;

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
    }, GUEST);
    expect(url).toBe('https://pod.example/agent/invoke');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ input: 'hello', sessionId: 'sess-1' });
  });

  it('never sends the retired { message, history } shape', () => {
    const { init } = buildInvokeRequest('https://pod.example', { input: 'hello' }, GUEST);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ input: 'hello' });
    expect(body).not.toHaveProperty('message');
    expect(body).not.toHaveProperty('history');
  });

  it('carries the visitor guest header and NO Authorization — the PAT authenticates the platform API, never the pod (guuey#1600)', () => {
    const { init } = buildInvokeRequest('https://pod.example', { input: 'hello' }, GUEST);
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(['accept', 'content-type', 'x-guuey-guest']);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get(GUEST_HEADER_NAME)).toBe(SECRET);
    // No Bearer of any kind, so the pod's `Token use not allowed: id` (access-vs-ID) refusal cannot arise here.
    expect(headers.has('authorization')).toBe(false);
  });

  it('refuses a guest secret the pod would ignore (not 64 hex)', () => {
    expect(() => buildInvokeRequest('https://pod.example', { input: 'hi' }, { kind: 'guest', secret: 'short' })).toThrow(/64 hex/);
  });

  it('carries threadId when continuing a conversation', () => {
    const { init } = buildInvokeRequest('https://pod.example', { input: 'hi', threadId: 't-1' }, GUEST);
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
  const base = { appId: 'app-1', appIdFlag: undefined, caller: GUEST, errored: false } as const;

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
    expect(logged()).toContain('[tool.done] weather');
    expect(result).toEqual({ stopReason: 'end_turn', errored: false, threadId: 't-9' });
    expect(errSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it('names each tool.done by its call id, so interleaved calls pair by name, not by order', async () => {
    const { logged } = capture();
    await streamToStdout(
      sseStream([
        frame('message', { type: 'tool.start', toolCallId: 'c1', name: 'weather', seq: 1 }),
        frame('message', { type: 'tool.start', toolCallId: 'c2', name: 'render', seq: 2 }),
        frame('message', { type: 'tool.done', toolCallId: 'c2', content: [], isError: true, seq: 3 }),
        frame('message', { type: 'tool.done', toolCallId: 'c1', content: [], seq: 4 }),
        frame('message', { type: 'tool.done', toolCallId: 'c9', content: [], seq: 5 }),
        frame('done', { stopReason: 'end_turn' }),
      ]),
    );

    const lines = logged()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('[tool.'));
    expect(lines).toEqual([
      '[tool.start] weather',
      '[tool.start] render',
      '[tool.done] render error',
      '[tool.done] weather',
      '[tool.done]',
    ]);
  });

  it('a preliminary tool.done (more: true) keeps the name for the call\'s final done', async () => {
    const { logged } = capture();
    await streamToStdout(
      sseStream([
        frame('message', { type: 'tool.start', toolCallId: 'c1', name: 'research', seq: 1 }),
        frame('message', { type: 'tool.done', toolCallId: 'c1', content: [], more: true, seq: 2 }),
        frame('message', { type: 'tool.done', toolCallId: 'c1', content: [], seq: 3 }),
        frame('done', { stopReason: 'end_turn' }),
      ]),
    );

    const done = logged()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('[tool.done'));
    expect(done).toEqual(['[tool.done] research', '[tool.done] research']);
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

  it('turn 1 (no --thread): a fresh visitor, NO sessionId (the pod keys the session to the thread it mints), and the thread\'s secret is saved', async () => {
    fetchSpy.mockResolvedValueOnce(podAnswer('t-new'));
    await testCommand('hello', { url: 'https://pod.example' });
    const req = sent();
    expect(req.url).toBe('https://pod.example/agent/invoke');
    expect(isGuestSecret(req.headers.get(GUEST_HEADER_NAME) ?? '')).toBe(true);
    expect(req.body['threadId']).toBeUndefined();
    // Turn 1 and the --thread turns after it must share ONE session (one session.ended).
    expect(req.body).not.toHaveProperty('sessionId');
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

  it('an explicit --session still wins, on turn 1 and on a --thread turn', async () => {
    fetchSpy.mockResolvedValueOnce(podAnswer('t-s'));
    await testCommand('hello', { url: 'https://pod.example', session: 'sess-explicit' });
    expect(sent().body['sessionId']).toBe('sess-explicit');
    saveThreadSecret('app-1', 't-s', SECRET, threadsDir.current);
    fetchSpy.mockResolvedValueOnce(podAnswer('t-s'));
    await testCommand('again', { url: 'https://pod.example', thread: 't-s', session: 'sess-explicit' });
    expect(sent(1).body).toEqual({ input: 'again', sessionId: 'sess-explicit', threadId: 't-s' });
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

// ─── guuey#2719: the signed-in mode (`--bearer-stdin`) ──────────────────────

/** A JWT-shaped plant: never a real credential, only a string every output is searched for. */
const PLANT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJwbGFudGVkLTI3MTkifQ.cGxhbnRlZC1zaWduYXR1cmUtMjcxOQ';
const BEARER = { kind: 'bearer', token: PLANT } as const;

/** A stand-in for `process.stdin`: the given chunks, optionally a terminal. */
function stdinOf(chunks: Array<string | Buffer>, isTTY?: boolean): BearerInput {
  return {
    ...(isTTY === undefined ? {} : { isTTY }),
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

describe('buildInvokeRequest — a signed-in caller sends its token, and nothing of a guest (guuey#2719)', () => {
  it('carries Authorization: Bearer <token> and NO guest header', () => {
    const { init } = buildInvokeRequest('https://pod.example', { input: 'hello' }, BEARER);
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(['accept', 'authorization', 'content-type']);
    expect(headers.get('authorization')).toBe(`Bearer ${PLANT}`);
    expect(headers.has(GUEST_HEADER_NAME)).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ input: 'hello' });
  });

  it('refuses a token that is not one JWT, without echoing it', () => {
    expect(() => buildInvokeRequest('https://pod.example', { input: 'hi' }, { kind: 'bearer', token: 'not a jwt' })).toThrow(
      BearerInputError,
    );
  });
});

describe('bearerArgvRefusal — a token on the command line is refused by name, never echoed (guuey#2719)', () => {
  it.each(BEARER_ARGV_FLAGS)('--%s <value> is refused; the message names the flag and not the value', (name) => {
    const message = bearerArgvRefusal({ [name]: PLANT });
    expect(message).toMatch(new RegExp(`^${BEARER_IN_ARGV}: --${name} is refused`));
    expect(message).toContain('--bearer-stdin');
    expect(message).not.toContain(PLANT);
  });

  it('a valueless token flag is refused too: it says the caller meant to pass one there', () => {
    expect(bearerArgvRefusal({ bearer: true })).toMatch(/^bearer-in-argv: --bearer is refused/);
  });

  it('--bearer-stdin that picked up a value is refused, and the value is not shown', () => {
    const message = bearerArgvRefusal({ 'bearer-stdin': PLANT });
    expect(message).toMatch(/^bearer-in-argv: --bearer-stdin takes no value/);
    expect(message).not.toContain(PLANT);
  });

  it('a bare --bearer-stdin, or no token flag at all, is no refusal', () => {
    expect(bearerArgvRefusal({ 'bearer-stdin': true })).toBeUndefined();
    expect(bearerArgvRefusal({ thread: 't-1' })).toBeUndefined();
    expect(bearerArgvRefusal(undefined)).toBeUndefined();
  });
});

describe('readBearer — one JWT from stdin, and no refusal shows what was read (guuey#2719)', () => {
  it('reads the token across chunks (string or Buffer) and drops the trailing newline', async () => {
    const half = PLANT.length >> 1;
    await expect(readBearer(stdinOf([PLANT.slice(0, half), Buffer.from(`${PLANT.slice(half)}\n`)]))).resolves.toBe(PLANT);
  });

  it('refuses a terminal before reading a byte (a pasted token would echo on screen)', async () => {
    let read = false;
    const tty: BearerInput = {
      isTTY: true,
      async *[Symbol.asyncIterator]() {
        read = true;
        yield PLANT;
      },
    };
    await expect(readBearer(tty)).rejects.toThrow(/stdin is a terminal/);
    expect(read).toBe(false);
  });

  it('refuses an empty input', async () => {
    await expect(readBearer(stdinOf(['  \n']))).rejects.toThrow(/stdin was empty/);
  });

  it('refuses an input larger than any user token', async () => {
    await expect(readBearer(stdinOf(['a'.repeat(MAX_BEARER_BYTES + 1)]))).rejects.toThrow(/more than 16384 bytes/);
  });

  it.each([
    ['a "Bearer " prefix', `Bearer ${PLANT}`],
    ['two tokens', `${PLANT}\n${PLANT}`],
    ['a two-part string', 'abc.def'],
    ['a JSON token response', `{"access_token":"${PLANT}"}`],
  ])('refuses %s, and the refusal carries none of it', async (_label, input) => {
    const err = await readBearer(stdinOf([input])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BearerInputError);
    expect((err as BearerInputError).message).toMatch(/exactly one JWT/);
    expect((err as BearerInputError).message).not.toContain(PLANT);
  });
});

describe('redactCaller — the token is cut out of any text the CLI prints (guuey#2719)', () => {
  it('replaces every occurrence for a signed-in caller', () => {
    expect(redactCaller(`a ${PLANT} b ${PLANT}`, BEARER)).toBe('a [token redacted] b [token redacted]');
  });
  it("leaves a guest's text as it is", () => {
    expect(redactCaller(`a ${SECRET}`, GUEST)).toBe(`a ${SECRET}`);
  });
});

describe('streamToStdout — the [user] line names who the pod resolved the caller to (guuey#2719)', () => {
  afterEach(() => vi.restoreAllMocks());

  async function render(session: Record<string, string>): Promise<string[]> {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await streamToStdout(sseStream([frame('session', session), frame('done', { stopReason: 'end_turn' })]));
    return logs;
  }

  it('a signed-in turn: the session line is unchanged, then the subject and authMode', async () => {
    const logs = await render({ sessionId: 's-1', threadId: 't-1', userId: 'sub-123', authMode: 'authenticated' });
    expect(logs).toEqual(['  [session] s-1 · thread t-1', '  [user] sub-123 · authenticated']);
  });

  it('a guest turn renders the same two lines, with its g_ id', async () => {
    const logs = await render({ sessionId: 's-1', userId: 'g_abc', authMode: 'anonymous' });
    expect(logs).toEqual(['  [session] s-1', '  [user] g_abc · anonymous']);
  });

  it('a session frame without a userId prints no [user] line', async () => {
    expect(await render({ sessionId: 's-1' })).toEqual(['  [session] s-1']);
  });
});

describe('guuey test --bearer-stdin — the command end to end (guuey#2719)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let printed: string[];

  beforeEach(() => {
    threadsDir.current = mkdtempSync(join(tmpdir(), 'guuey-test-threads-'));
    printed = [];
    const keep = (...a: unknown[]) => void printed.push(a.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(keep);
    vi.spyOn(console, 'error').mockImplementation(keep);
    vi.spyOn(console, 'warn').mockImplementation(keep);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      printed.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      printed.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as typeof process.exit);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    rmSync(threadsDir.current, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const signedInAnswer = (threadId: string) =>
    new Response(
      sseStream([
        frame('session', { sessionId: threadId, userId: 'sub-123', authMode: 'authenticated', threadId }),
        frame('message', { type: 'text.delta', id: 'm1', delta: 'hello, signed-in user', seq: 1 }),
        frame('message', { type: 'text.end', id: 'm1', seq: 2 }),
        frame('done', { stopReason: 'end_turn', threadId }),
      ]),
      { status: 200 },
    );
  const sent = (i = 0) => {
    const [url, init] = fetchSpy.mock.calls[i] as [string, RequestInit];
    return { url, headers: new Headers(init.headers), body: String(init.body) };
  };

  it('sends the token as the Bearer, no guest header, saves no visitor secret, and renders the same lines as a guest turn', async () => {
    fetchSpy.mockResolvedValueOnce(signedInAnswer('t-s1'));
    await testCommand('hello', { url: 'https://pod.example', 'bearer-stdin': true }, { stdin: stdinOf([`${PLANT}\n`]) });
    const req = sent();
    expect(req.headers.get('authorization')).toBe(`Bearer ${PLANT}`);
    expect(req.headers.has(GUEST_HEADER_NAME)).toBe(false);
    expect(JSON.parse(req.body)).toEqual({ input: 'hello' });
    expect(existsSync(join(threadsDir.current, 'app-1'))).toBe(false);
    const all = printed.join('\n');
    expect(all).toContain('  Auth:     bearer (user token from stdin)');
    expect(all).toContain('  [session] t-s1 · thread t-s1');
    expect(all).toContain('  [user] sub-123 · authenticated');
    expect(all).toContain('hello, signed-in user');
    expect(all).toContain('  [done] end_turn');
    expect(all).toContain('guuey test "<message>" --thread t-s1 --bearer-stdin < <token file>');
  });

  it('--thread needs no saved visitor: the pod keys a signed-in thread to the subject', async () => {
    fetchSpy.mockResolvedValueOnce(signedInAnswer('t-s1'));
    await testCommand('again', { url: 'https://pod.example', thread: 't-s1', 'bearer-stdin': true }, { stdin: stdinOf([PLANT]) });
    expect(JSON.parse(sent().body)).toEqual({ input: 'again', threadId: 't-s1' });
    expect(printed.join('\n')).not.toContain('No visitor identity saved');
  });

  it("the wrong kind of token (an ID token on the guuey pool): the pod's refusal is printed verbatim and the run exits 1", async () => {
    const refusal = { code: 'UNAUTHORIZED', message: 'Invalid or unverifiable bearer token: Token use not allowed: id' };
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(refusal), { status: 401, statusText: 'Unauthorized' }));
    await expect(
      testCommand('hello', { url: 'https://pod.example', 'bearer-stdin': true }, { stdin: stdinOf([PLANT]) }),
    ).rejects.toThrow(ExitSignal);
    expect(printed.join('\n')).toContain(`Invoke failed: HTTP 401 Unauthorized — ${JSON.stringify(refusal)}`);
  });

  it('a terminal on stdin is refused before any network call', async () => {
    await expect(
      testCommand('hello', { url: 'https://pod.example', 'bearer-stdin': true }, { stdin: stdinOf([PLANT], true) }),
    ).rejects.toThrow(ExitSignal);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(printed.join('\n')).toMatch(/stdin is a terminal/);
  });

  it('a token flag is refused before the usage check, any read of stdin or any network call', async () => {
    let read = false;
    const stdin: BearerInput = {
      async *[Symbol.asyncIterator]() {
        read = true;
        yield PLANT;
      },
    };
    // `guuey test --bearer <token>` with no message: the refusal, not the usage line.
    await expect(testCommand(undefined, { bearer: PLANT }, { stdin })).rejects.toThrow(ExitSignal);
    expect(printed.join('\n')).toMatch(/bearer-in-argv: --bearer is refused/);
    expect(read).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('NO ESCAPE: across every path a planted JWT reaches only the Authorization header — 0 hits in output, argv, env, URL or body', async () => {
    // 1. A good turn, then a failure whose body echoes the token (a misbehaving proxy): it prints redacted.
    fetchSpy.mockResolvedValueOnce(signedInAnswer('t-n1'));
    await testCommand('hello', { url: 'https://pod.example', 'bearer-stdin': true }, { stdin: stdinOf([`${PLANT}\n`]) });
    fetchSpy.mockResolvedValueOnce(
      new Response(`upstream rejected Authorization: Bearer ${PLANT}`, { status: 502, statusText: 'Bad Gateway' }),
    );
    await expect(
      testCommand('hello', { url: 'https://pod.example', 'bearer-stdin': true }, { stdin: stdinOf([PLANT]) }),
    ).rejects.toThrow(ExitSignal);
    // 2. The argv refusals and a malformed stdin.
    const argvFlags: Array<Record<string, string | true>> = [{ bearer: PLANT }, { token: PLANT }, { 'bearer-stdin': PLANT }];
    for (const flags of argvFlags) {
      await expect(testCommand('hello', { url: 'https://pod.example', ...flags }, { stdin: stdinOf([]) })).rejects.toThrow(
        ExitSignal,
      );
    }
    await expect(
      testCommand('hello', { url: 'https://pod.example', 'bearer-stdin': true }, { stdin: stdinOf([`Bearer ${PLANT}`]) }),
    ).rejects.toThrow(ExitSignal);

    const all = printed.join('\n');
    expect(all).toContain('[token redacted]');
    expect(all.split(PLANT).length - 1).toBe(0);
    expect(process.argv.join(' ').split(PLANT).length - 1).toBe(0);
    expect(JSON.stringify(process.env).split(PLANT).length - 1).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      const req = sent(i);
      expect(req.url).not.toContain(PLANT);
      expect(req.body).not.toContain(PLANT);
      expect(req.headers.get('authorization')).toBe(`Bearer ${PLANT}`);
    }
  });
});

// cto's term on guuey#2719: the event names the renderer handles are pinned from the runtime EMITTER, never from this
// renderer, so a signed-in turn and a guest turn render the same frames. Read off disk; skip outside the monorepo.
const POD_SSE_SERVER = fileURLToPath(
  new URL('../../../../../backend/services/nocode-runtime/src/sse-server.ts', import.meta.url),
);

describe.skipIf(!existsSync(POD_SSE_SERVER) || !existsSync(POD_IDENTITY))(
  'pod stream + Bearer sync guard — the emitter sends what the renderer handles, and the pod reads the Bearer the CLI sends (guuey#2719)',
  () => {
    it('every rendered event name is one the emitter sends, and the renderer has a case for each', () => {
      const emitter = readFileSync(POD_SSE_SERVER, 'utf8');
      const renderer = readFileSync(CLI_TEST_COMMAND, 'utf8');
      for (const name of POD_STREAM_EVENTS) {
        expect(emitter, `sse-server.ts sends no '${name}' event`).toContain(`pauseCapture.send('${name}',`);
        expect(renderer, `streamToStdout has no case for '${name}'`).toContain(`case '${name}':`);
      }
    });

    it('the session frame carries the userId and authMode the [user] line prints', () => {
      const emitter = readFileSync(POD_SSE_SERVER, 'utf8');
      expect(emitter).toContain('userId: identity.userId,');
      expect(emitter).toContain('authMode: identity.authMode,');
    });

    it('the pod reads `Authorization: Bearer`, takes only ACCESS tokens from the guuey pool, and 401s with { code, message }', () => {
      const identity = readFileSync(POD_IDENTITY, 'utf8');
      expect(identity).toContain("const auth = req.headers['authorization'];");
      expect(identity).toContain("auth.toLowerCase().startsWith('bearer ')");
      expect(identity).toContain("tokenUse: 'access'");
      const emitter = readFileSync(POD_SSE_SERVER, 'utf8');
      expect(emitter).toContain('res.end(JSON.stringify({ code: ERROR_CODES.UNAUTHORIZED, message: err.message }));');
    });
  },
);

// The help text's per-mode rule (guuey#2719, docs' read): a `byo` app's pod takes the token whose `aud` is the app's
// audience and refuses a Cognito ACCESS token (`token_use` not `id`), the opposite of the guuey pool. Pinned from the
// verifier the pod calls; skipped outside the monorepo. The help wording itself is pinned in cli-help-copy.test.ts,
// which reads no private path: the help text is copy, not a mirrored wire shape.
const BYO_VERIFY = fileURLToPath(new URL('../../../../../backend/libs/byo-identity/src/verify.ts', import.meta.url));

describe.skipIf(!existsSync(BYO_VERIFY))('byo token sync guard — a byo app takes an ID-type token, as the help says (guuey#2719)', () => {
  it('the byo verifier enforces token_use_not_id', () => {
    const verify = readFileSync(BYO_VERIFY, 'utf8');
    expect(verify).toContain("token_use_not_id: 'enforce',");
    expect(verify).toContain("if (payload.token_use !== undefined && payload.token_use !== 'id') {");
  });
});
