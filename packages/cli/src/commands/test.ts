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
 * deployments lookup only. No Bearer of any kind goes to the pod, so the
 * pod's access-vs-ID token-use refusal (`Token use not allowed: id`) cannot
 * arise on this path. An app that has closed guest access refuses the
 * visitor, and the refusal is printed verbatim.
 *
 * The visitor is the pod's NON-BROWSER guest (guuey#1600): every request
 * carries `x-guuey-guest: <64-hex>` (identity.ts `extractGuestHeader`, the
 * header portal's RN client uses), so `userId = g_<sha256(secret)>`. A run
 * without `--thread` mints a fresh secret — a new visitor each time, exactly
 * what the pod did on its own before. The pod keys a thread to its owner and
 * MINTS A FRESH THREAD on an owner mismatch (sse-server.ts, never throws), so
 * continuing a conversation needs the SAME visitor: the secret of every
 * thread this CLI starts is saved at `~/.guuey/test-threads/<appId>/<threadId>`
 * (dir 0700, file 0600, like `auth.json`) and `--thread <id>` loads it. A
 * thread with no saved secret on this machine is refused before any network
 * call — never a silent new thread.
 *
 * Usage:
 *   guuey test "What's the weather in Tokyo?"
 *   guuey test "And tomorrow?" --thread <threadId from the first turn>
 *   guuey test "hi" --app-id <id>   # overrides the project binding, left untouched
 *   guuey test "Show me a dashboard" --session sess_existing
 *   guuey test "hi" --url https://my-app.agents.sandbox.guuey.com
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgEvent } from '@silverprotocol/core';
import { resolveConfig, loadAmplifyOutputs } from '../config';
import { getTestThreadsDir } from '../paths';
import { requireAuth } from '../auth';
import { apiRequest } from '../deploy-shared';
import * as out from '../output';

/**
 * The invoke request body — the CLI's hand-written mirror of the pod's
 * `InvokeRequest` (`invoke-request.ts`), the subset this command sends: `input`
 * required, `sessionId` optional (explicit wins; else the pod keys the
 * session itself), `threadId` optional (the durable conversation; minted by
 * the pod when absent). A published package cannot import the private
 * runtime, so the mirror is pinned by the sync guard in `test.test.ts` — the
 * same discipline as `wire-mirror-parse.ts`.
 */
export interface InvokeBody {
  input: string;
  sessionId?: string;
  threadId?: string;
}

/** MIRROR of the pod's `GUEST_HEADER_NAME` (`nocode-runtime/src/identity.ts`) — pinned in `test.test.ts`. */
export const GUEST_HEADER_NAME = 'x-guuey-guest';

/** A guest secret the pod accepts: exactly 32 bytes as 64 hex chars (identity.ts `isValidGuestSecret`). */
export function isGuestSecret(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

/** A fresh visitor: 32 random bytes, hex — the same shape the pod mints for a cookie. */
export function mintGuestSecret(): string {
  return randomBytes(32).toString('hex');
}

/** One path segment, never a traversal: the appId / threadId that name a secret file. */
function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

/** `<dir>/<appId>/<threadId>`. Throws on a segment that could leave the directory. */
export function threadSecretPath(appId: string, threadId: string, dir: string = getTestThreadsDir()): string {
  if (!isSafeSegment(appId)) throw new Error(`Not a usable app id: ${JSON.stringify(appId)}`);
  if (!isSafeSegment(threadId)) throw new Error(`Not a usable thread id: ${JSON.stringify(threadId)}`);
  return join(dir, appId, threadId);
}

/** Save the visitor secret a thread was started with (dir 0700, file 0600). */
export function saveThreadSecret(
  appId: string,
  threadId: string,
  secret: string,
  dir: string = getTestThreadsDir(),
): void {
  const file = threadSecretPath(appId, threadId, dir);
  mkdirSync(join(dir, appId), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
}

/** The saved visitor secret for a thread, or `undefined` when none (or a malformed one) is on this machine. */
export function loadThreadSecret(
  appId: string,
  threadId: string,
  dir: string = getTestThreadsDir(),
): string | undefined {
  const file = threadSecretPath(appId, threadId, dir);
  if (!existsSync(file)) return undefined;
  const value = readFileSync(file, 'utf8').trim();
  return isGuestSecret(value) ? value : undefined;
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

  for (const name of ['thread', 'app-id', 'session'] as const) {
    if (flags?.[name] === true) {
      out.error(`--${name} needs a value: --${name} <id>`);
      process.exit(1);
    }
  }
  const resolved = resolveConfig();
  // `--app-id` targets another app for this call; the project binding is left untouched.
  const appIdFlag = typeof flags?.['app-id'] === 'string' ? flags['app-id'] : undefined;
  const config = { ...resolved, appId: appIdFlag ?? resolved.appId };
  if (!config.appId) {
    out.error('No app configured. Run: guuey create, set app-id in config, or pass --app-id <id>.');
    process.exit(1);
  }
  const appId = config.appId;

  const threadFlag = typeof flags?.thread === 'string' ? flags.thread : undefined;
  let guestSecret: string;
  if (threadFlag !== undefined) {
    const saved = loadThreadSecret(appId, threadFlag);
    if (saved === undefined) {
      out.error(
        `No visitor identity saved for thread ${threadFlag} of app ${appId} on this machine. ` +
          'Only a thread `guuey test` started here can be continued — start one without --thread, ' +
          'then pass the thread id it prints.',
      );
      process.exit(1);
    }
    guestSecret = saved;
  } else {
    guestSecret = mintGuestSecret();
  }

  const { pat } = requireAuth();
  // No default sessionId, on ANY turn (guuey#1600, QA's dev read): the pod keys
  // the session to the thread (`sessionId = body.sessionId ?? threadId`), so turn
  // 1 and every `--thread` turn after it are ONE session — one `session.ended`
  // for the conversation. The old `test-<ts>` default made turn 1 a session of
  // its own. An explicit --session still wins.
  const sessionId = typeof flags?.session === 'string' ? flags.session : undefined;
  const endpoint = await resolveAgentEndpoint(config, flags, pat);

  console.log(`  App:      ${appId}`);
  console.log(`  Thread:   ${threadFlag ?? 'new'}`);
  console.log(`  Session:  ${sessionId ?? '(keyed to the thread)'}`);
  console.log(`  Endpoint: ${endpoint}`);
  console.log(`  Message:  ${message}`);
  console.log('');

  const body: InvokeBody = {
    input: message,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(threadFlag !== undefined ? { threadId: threadFlag } : {}),
  };
  const { url, init } = buildInvokeRequest(endpoint, body, guestSecret);
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

  const { stopReason, errored, threadId } = await streamToStdout(res.body);
  console.log('');
  if (stopReason !== undefined) console.log(`  [done] ${stopReason}`);
  for (const line of threadFollowUp({ appId, appIdFlag, threadFlag, threadId, guestSecret, errored })) console.log(line);
  if (errored) process.exit(1);
}

/**
 * After the stream: save the visitor secret of the thread the pod named, and
 * say how to continue it. A requested thread the pod did NOT continue (thread
 * persistence off, or the owner check minted a fresh one) is a warning, never
 * silent. Exported for unit test.
 */
export function threadFollowUp(args: {
  appId: string;
  appIdFlag: string | undefined;
  threadFlag: string | undefined;
  threadId: string | undefined;
  guestSecret: string;
  errored: boolean;
  dir?: string;
}): string[] {
  const { appId, appIdFlag, threadFlag, threadId, guestSecret, errored, dir } = args;
  if (threadId === undefined) {
    // An invoke that failed before its session frame already printed why.
    if (errored) return [];
    const why = 'the app keeps no thread history, or the thread store was unavailable for this turn';
    return threadFlag === undefined
      ? [`  (the pod named no thread — ${why}; there is nothing to continue)`]
      : [`  ! the pod named no thread — ${why}; thread ${threadFlag} was not continued`];
  }
  saveThreadSecret(appId, threadId, guestSecret, dir);
  const lines: string[] = [];
  if (threadFlag !== undefined && threadFlag !== threadId) {
    lines.push(`  ! the pod started a NEW thread ${threadId} instead of continuing ${threadFlag}`);
  }
  lines.push(
    `  Continue this conversation: guuey test "<message>" --thread ${threadId}${appIdFlag !== undefined ? ` --app-id ${appIdFlag}` : ''}`,
  );
  return lines;
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
 * The invoke request: the normalised URL plus a fetch init carrying the
 * content-type/accept pair, the visitor's guest header and the JSON body.
 * Never an `Authorization` header — see the file header for why the PAT
 * never reaches the pod.
 */
export function buildInvokeRequest(
  endpoint: string,
  body: InvokeBody,
  guestSecret: string,
): { url: string; init: RequestInit } {
  if (!isGuestSecret(guestSecret)) throw new Error('guest secret must be 64 hex chars');
  return {
    url: toInvokeUrl(endpoint),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        [GUEST_HEADER_NAME]: guestSecret,
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
): Promise<{ stopReason: string | undefined; errored: boolean; threadId: string | undefined }> {
  let stopReason: string | undefined;
  let errored = false;
  let threadId: string | undefined;
  for await (const ev of parseSse(body)) {
    const payload = parseJson(ev.data);
    if (payload === undefined) continue;
    switch (ev.event) {
      case 'session':
        if (isSessionFrame(payload)) {
          if (payload.threadId) threadId = payload.threadId;
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
  return { stopReason, errored, threadId };
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
