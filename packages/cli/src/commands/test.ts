/**
 * guuey test -- Send a test message to the agent and stream the response.
 *
 * POSTs `{ message, history }` to the agent's `/invoke` endpoint and
 * streams the SSE response to stdout. The agent URL is resolved in this
 * order:
 *   1. `--url <https://…>` flag
 *   2. `{appId}.{agentsDomain}` if `AGENTS_DOMAIN` or amplify_outputs
 *      carries an agents root
 *   3. The newest live deployment's `endpointUrl`, from
 *      `GET /apps/:id/deployments`
 *
 * Usage:
 *   guuey test "What's the weather in Tokyo?"
 *   guuey test "Show me a dashboard" --session sess_existing
 *   guuey test "hi" --url https://my-app.agents.sandbox.guuey.com
 */

import { resolveConfig, loadAmplifyOutputs } from '../config';
import { requireAuth } from '../auth';
import { apiRequest } from '../deploy-shared';
import * as out from '../output';

// Streamable invoke protocol version — distinct from the MCP wire-protocol
// constant in @ggui-ai/protocol. Pinned to '1' per the invoke spec; server
// (define-agent.ts) will reject anything else.
const INVOKE_PROTOCOL_VERSION = '1';

/** SSE event parsed off the wire. */
interface SseEvent {
  event: string;
  data: string;
}

export async function test(
  message: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (!message) {
    out.error('Usage: guuey test <message>');
    process.exit(1);
  }

  const config = resolveConfig();
  if (!config.appId) {
    out.error('No app configured. Run: guuey create or set app-id in config.');
    process.exit(1);
  }

  const { pat } = requireAuth();
  const sessionId = (flags?.session as string) ?? `test-${Date.now()}`;
  const endpoint = await resolveAgentEndpoint(config, flags, pat);

  console.log(`  App:      ${config.appId}`);
  console.log(`  Session:  ${sessionId}`);
  console.log(`  Endpoint: ${endpoint}`);
  console.log(`  Message:  ${message}`);
  console.log('');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-Ggui-Protocol-Version': INVOKE_PROTOCOL_VERSION,
    'X-Ggui-App-Id': config.appId,
    'X-Ggui-Session-Id': sessionId,
    Authorization: `Bearer ${pat}`,
  };

  const res = await fetch(`${endpoint}/invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, history: [] }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    out.error(`Invoke failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 400)}` : ''}`);
    process.exit(1);
  }
  if (!res.body) {
    out.error('Invoke returned empty body');
    process.exit(1);
  }

  await streamToStdout(res.body);
  console.log('');
}

/**
 * Pipe an SSE stream to stdout. Prints every text delta as it arrives;
 * tool use / tool result / message boundaries get marker lines so the
 * reader can tell what phase the agent is in.
 */
async function streamToStdout(body: ReadableStream<Uint8Array>): Promise<void> {
  let inAssistantBlock = false;
  for await (const ev of parseSse(body)) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = ev.event || (payload.type as string | undefined) || '';

    switch (t) {
      case 'message_start':
        inAssistantBlock = true;
        break;
      case 'content_block_delta': {
        const delta = (payload.delta as { type?: string; text?: string } | undefined) ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          process.stdout.write(delta.text);
        }
        break;
      }
      case 'content_block_stop':
        if (inAssistantBlock) process.stdout.write('\n');
        break;
      case 'tool_use': {
        const name = (payload.name as string | undefined) ?? 'tool';
        console.log(`\n  [tool_use] ${name}`);
        break;
      }
      case 'tool_result': {
        const isError = payload.is_error === true;
        console.log(`  [tool_result]${isError ? ' error' : ''}`);
        break;
      }
      case 'message_stop':
        inAssistantBlock = false;
        break;
      case 'error': {
        const err = payload.error as { code?: string; message?: string } | undefined;
        out.error(`\n[error] ${err?.code ?? 'unknown'}: ${err?.message ?? JSON.stringify(payload)}`);
        break;
      }
      default:
        // quietly skip unknown event types — protocol may add more over time
        break;
    }
  }
}

/**
 * Minimal SSE parser. Yields each `event: …\ndata: …\n\n` frame. Handles
 * multi-line data via the standard SSE concatenation rule.
 */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      yield parseFrame(frame);
    }
  }
  if (buf.trim().length > 0) yield parseFrame(buf);
}

function parseFrame(frame: string): SseEvent {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  return { event, data: dataLines.join('\n') };
}

/**
 * Resolve the agent base URL. Priority:
 *   1. `--url <https://…>` flag
 *   2. `{appId}.{agentsDomain}` via amplify outputs / `$AGENTS_DOMAIN`
 *   3. The newest deployment with a live `endpointUrl`, read from
 *      `GET /apps/:id/deployments` (the same route `commands/deployments.ts`
 *      speaks — newest-first per the backend's GSI query).
 *
 * The old fallback here (`config.host` — the PLATFORM host, not an agent
 * pod) was S13: it silently POSTed `/invoke` at the platform origin and
 * got back a 404 HTML page. There is no safe URL to fall back to once the
 * deployments lookup comes up empty — this errors out instead of guessing.
 */
export async function resolveAgentEndpoint(
  config: ReturnType<typeof resolveConfig>,
  flags: Record<string, string | true> | undefined,
  pat: string,
): Promise<string> {
  const override = flags?.url as string | undefined;
  if (override) return override.replace(/\/$/, '');

  const amplify = loadAmplifyOutputs() as Record<string, string | undefined>;
  const agentsDomain = amplify.agentsDomain ?? process.env.AGENTS_DOMAIN;
  if (agentsDomain && config.appId) {
    return `https://${config.appId}.${agentsDomain}`;
  }

  if (config.appId) {
    const res = await apiRequest(pat, config, 'GET', `/apps/${config.appId}/deployments`);
    if (res.ok) {
      const data = (await res.json()) as {
        deployments: Array<{ endpointUrl: string | null }>;
      };
      const live = data.deployments.find((d) => d.endpointUrl);
      if (live?.endpointUrl) return live.endpointUrl.replace(/\/$/, '');
    }
  }

  out.error('No live deployment found — run "guuey deploy" first.');
  process.exit(1);
}
