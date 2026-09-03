/**
 * guuey test -- Send a test message to the agent and stream the response.
 *
 * Speaks the pod's `POST /agent/invoke` contract — the ONE invoke contract,
 * documented in the header of `backend/services/nocode-runtime/src/
 * sse-server.ts`: body `{ input, sessionId? }` in; an SSE stream of
 * `session` / `message` (AgJSON events) / `done` / `error` frames out. The
 * Guuey Runtime Router fronts EVERY deployment (no-code and code-mode
 * alike), so there is exactly one request shape to speak (guuey#681: the
 * previous `{ message, history }` body was a define-agent-era relic every
 * pod 400s with `input: non-empty string required`, and the stream printer
 * read Anthropic-native frames the pod never sends).
 *
 * The invoke URL is resolved in this order, every branch normalised by
 * {@link toInvokeUrl}:
 *   1. `--url <https://…>` flag — a pod base or the full invoke URL
 *   2. `{appId}.{agentsDomain}` if `AGENTS_DOMAIN` or amplify_outputs carries
 *      an agents root
 *   3. The newest live deployment's `endpointUrl` from
 *      `GET /apps/:id/deployments` — already `…/agent/invoke`, exactly as the
 *      deploy-controller records it (`k8s/ingress.ts`)
 *
 * Identity: `guuey test` speaks as an anonymous visitor. The pod verifies a
 * `Bearer` against the app's user pool (or BYO issuer) and answers 401 to
 * anything else — never a guest fallback (`nocode-runtime/src/identity.ts`)
 * — so the platform PAT is NEVER sent to the pod; it authenticates the
 * deployments lookup only. An app that has closed guest access refuses the
 * visitor, and the refusal is printed verbatim.
 *
 * Usage:
 *   guuey test "What's the weather in Tokyo?"
 *   guuey test "Show me a dashboard" --session sess_existing
 *   guuey test "hi" --url https://my-app.agents.sandbox.guuey.com
 */

import { AgEvent } from '@silverprotocol/core';
import { resolveConfig, loadAmplifyOutputs } from '../config';
import { requireAuth } from '../auth';
import { apiRequest } from '../deploy-shared';
import * as out from '../output';

/**
 * The invoke request body — the CLI's hand-written mirror of the pod's
 * `InvokeRequest` (`sse-server.ts`), the subset this command sends: `input`
 * required, `sessionId` optional (explicit wins; else the pod keys the
 * session itself). A published package cannot import the private runtime,
 * so the mirror is pinned by the sync guard in `test.test.ts` — the same
 * discipline as `wire-mirror-parse.ts`.
 */
export interface InvokeBody {
  input: string;
  sessionId?: string;
}

/** SSE event parsed off the wire. */
interface SseEvent {
  event: string;
  data: string;
}

/** The pod's `event: session` payload (sse-server.ts header). */
interface SessionFrame {
  sessionId: string;
  threadId?: string;
}

/** The pod's `event: done` payload. */
interface DoneFrame {
  stopReason: string;
}

/** The pod's `event: error` payload. */
interface ErrorFrame {
  code: string;
  message: string;
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

  const { url, init } = buildInvokeRequest(endpoint, { input: message, sessionId });
  const res = await fetch(url, init);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    out.error(`Invoke failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 400)}` : ''}`);
    process.exit(1);
  }
  if (!res.body) {
    out.error('Invoke returned empty body');
    process.exit(1);
  }

  const { stopReason, errored } = await streamToStdout(res.body);
  console.log('');
  if (stopReason !== undefined) console.log(`  [done] ${stopReason}`);
  if (errored) process.exit(1);
}

/**
 * Normalise an agent endpoint to its invoke URL: accepts a pod base
 * (`https://host`) or the full invoke URL the deploy-controller records
 * (`https://host/agent/invoke`) and returns exactly one `/agent/invoke`,
 * trailing slashes dropped. The twin of `@guuey/agent-client`'s
 * `toInvokeUrl` (guuey#186 G3) — same rule, re-stated here because that
 * package carries a React peer the CLI must not take.
 */
export function toInvokeUrl(endpointUrl: string): string {
  const base = endpointUrl.replace(/\/+$/, '');
  return base.endsWith('/agent/invoke') ? base : `${base}/agent/invoke`;
}

/**
 * The invoke request: the normalised URL plus a fetch init carrying ONLY
 * the content-type/accept pair and the JSON body. No identity header — see
 * the file header for why the PAT never reaches the pod.
 */
export function buildInvokeRequest(
  endpoint: string,
  body: InvokeBody,
): { url: string; init: RequestInit } {
  return {
    url: toInvokeUrl(endpoint),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    },
  };
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function isSessionFrame(v: unknown): v is SessionFrame {
  return (
    typeof v === 'object' &&
    v !== null &&
    'sessionId' in v &&
    typeof v.sessionId === 'string' &&
    (!('threadId' in v) || typeof v.threadId === 'string')
  );
}

function isDoneFrame(v: unknown): v is DoneFrame {
  return (
    typeof v === 'object' && v !== null && 'stopReason' in v && typeof v.stopReason === 'string'
  );
}

function isErrorFrame(v: unknown): v is ErrorFrame {
  return (
    typeof v === 'object' &&
    v !== null &&
    'code' in v &&
    typeof v.code === 'string' &&
    'message' in v &&
    typeof v.message === 'string'
  );
}

/**
 * Pipe the pod's SSE stream to stdout. `message` frames carry AgJSON
 * (silver mode, the default): text deltas print as they arrive, tool
 * start/done get marker lines so the reader can tell what phase the agent
 * is in; every other AgJSON event (folds, artifacts, ext.*) and a
 * bypass-mode pod's raw native frames are skipped, never mis-rendered.
 * Exported for unit test.
 */
export async function streamToStdout(
  body: ReadableStream<Uint8Array>,
): Promise<{ stopReason: string | undefined; errored: boolean }> {
  let stopReason: string | undefined;
  let errored = false;
  for await (const ev of parseSse(body)) {
    const payload = parseJson(ev.data);
    if (payload === undefined) continue;
    switch (ev.event) {
      case 'session':
        if (isSessionFrame(payload)) {
          console.log(
            `  [session] ${payload.sessionId}${payload.threadId ? ` · thread ${payload.threadId}` : ''}`,
          );
        }
        break;
      case 'message':
        printAgEvent(payload);
        break;
      case 'done':
        if (isDoneFrame(payload)) stopReason = payload.stopReason;
        break;
      case 'error':
        if (isErrorFrame(payload)) {
          errored = true;
          out.error(`\n[error] ${payload.code}: ${payload.message}`);
        }
        break;
      default:
        // Informational frames (e.g. `profile-link-needed`) — nothing to print.
        break;
    }
  }
  return { stopReason, errored };
}

function printAgEvent(payload: unknown): void {
  const parsed = AgEvent.safeParse(payload);
  if (!parsed.success) return;
  // AgEvent's last union member is the forward-compat catch-all (`type:
  // string`), so a `case` narrows to "this variant OR the catch-all" — the
  // `typeof` checks below finish the narrowing on the fields we print.
  const e = parsed.data;
  switch (e.type) {
    case 'text.delta':
      if (typeof e.delta === 'string') process.stdout.write(e.delta);
      break;
    case 'text.end':
      process.stdout.write('\n');
      break;
    case 'tool.start':
      if (typeof e.name === 'string') console.log(`\n  [tool.start] ${e.name}`);
      break;
    case 'tool.done':
      console.log(`  [tool.done]${e.isError === true || e.outcome === 'error' ? ' error' : ''}`);
      break;
    default:
      break;
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
 * Resolve the agent's INVOKE URL. Priority:
 *   1. `--url <https://…>` flag (pod base or full invoke URL)
 *   2. `{appId}.{agentsDomain}` via amplify outputs / `$AGENTS_DOMAIN`
 *   3. The newest deployment with a live `endpointUrl`, read from
 *      `GET /apps/:id/deployments` (the same route `commands/deployments.ts`
 *      speaks — newest-first per the backend's GSI query). That URL is the
 *      full `…/agent/invoke` the deploy-controller wrote; it passes through
 *      {@link toInvokeUrl} untouched.
 *
 * The old fallback here (`config.host` — the PLATFORM host, not an agent
 * pod) was S13: it silently POSTed at the platform origin and got back a
 * 404 HTML page. There is no safe URL to fall back to once the deployments
 * lookup comes up empty — this errors out instead of guessing.
 */
export async function resolveAgentEndpoint(
  config: ReturnType<typeof resolveConfig>,
  flags: Record<string, string | true> | undefined,
  pat: string,
): Promise<string> {
  const override = flags?.url as string | undefined;
  if (override) return toInvokeUrl(override);

  const amplify = loadAmplifyOutputs() as Record<string, string | undefined>;
  const agentsDomain = amplify.agentsDomain ?? process.env.AGENTS_DOMAIN;
  if (agentsDomain && config.appId) {
    return toInvokeUrl(`https://${config.appId}.${agentsDomain}`);
  }

  if (config.appId) {
    const res = await apiRequest(pat, config, 'GET', `/apps/${config.appId}/deployments`);
    if (res.ok) {
      const data = (await res.json()) as {
        deployments: Array<{ endpointUrl: string | null }>;
      };
      const live = data.deployments.find((d) => d.endpointUrl);
      if (live?.endpointUrl) return toInvokeUrl(live.endpointUrl);
    }
  }

  out.error('No live deployment found — run "guuey deploy" first.');
  process.exit(1);
}
