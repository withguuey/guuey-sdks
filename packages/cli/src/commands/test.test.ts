/**
 * `guuey test` — the pod's invoke contract (guuey#681) + endpoint
 * resolution (S13).
 *
 * guuey#681: the command POSTed `{ message, history: [] }` at `<base>/invoke`
 * with the platform PAT as a Bearer — a define-agent-era relic. The pod's
 * ONE contract (`nocode-runtime/src/sse-server.ts`) is `{ input,
 * sessionId? }` at `/agent/invoke`, no PAT (the pod 401s any non-Cognito
 * Bearer, never a guest fallback), and its stream is AgJSON, not
 * Anthropic-native frames. These assertions pin every one of those.
 *
 * S13: `resolveAgentEndpoint`'s last-resort fallback was `config.host` — the
 * PLATFORM host, not an agent pod. The fix looks up
 * `GET /apps/:id/deployments` (newest-first, first row with a live
 * `endpointUrl`) and never guesses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  buildInvokeRequest,
  resolveAgentEndpoint,
  streamToStdout,
  toInvokeUrl,
} from './test.js';
import type { resolveConfig } from '../config.js';
import { parseInterfaceFields } from '../wire-mirror-parse';

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
    });
    expect(url).toBe('https://pod.example/agent/invoke');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ input: 'hello', sessionId: 'sess-1' });
  });

  it('never sends the retired { message, history } shape', () => {
    const { init } = buildInvokeRequest('https://pod.example', { input: 'hello' });
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ input: 'hello' });
    expect(body).not.toHaveProperty('message');
    expect(body).not.toHaveProperty('history');
  });

  it('carries no identity header — the PAT authenticates the platform API, never the pod', () => {
    const { init } = buildInvokeRequest('https://pod.example', { input: 'hello' });
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(['accept', 'content-type']);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.has('authorization')).toBe(false);
  });
});

// The pod's InvokeRequest lives in the private runtime; the CLI mirrors the
// subset it sends. Read both off disk (same pattern as wire-sync.test.ts),
// skip outside the monorepo.
const POD_SSE_SERVER = fileURLToPath(
  new URL('../../../../../backend/services/nocode-runtime/src/sse-server.ts', import.meta.url),
);
const CLI_TEST_COMMAND = fileURLToPath(new URL('./test.ts', import.meta.url));

describe.skipIf(!existsSync(POD_SSE_SERVER))(
  'InvokeBody sync guard — every CLI field is a pod InvokeRequest field with the same optionality',
  () => {
    it('input (required) and sessionId (optional) match sse-server.ts', () => {
      const pod = parseInterfaceFields(readFileSync(POD_SSE_SERVER, 'utf8'), 'InvokeRequest');
      const cli = parseInterfaceFields(readFileSync(CLI_TEST_COMMAND, 'utf8'), 'InvokeBody');
      expect(cli.map((f) => f.name)).toEqual(['input', 'sessionId']);
      for (const field of cli) {
        const podField = pod.find((f) => f.name === field.name);
        expect(podField, `pod InvokeRequest lacks ${field.name}`).toBeDefined();
        expect(podField?.optional, `${field.name} optionality`).toBe(field.optional);
      }
    });
  },
);

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
    expect(result).toEqual({ stopReason: 'end_turn', errored: false });
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
