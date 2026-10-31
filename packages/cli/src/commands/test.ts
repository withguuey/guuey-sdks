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
 * Identity: `guuey test` speaks as ONE of two callers ({@link InvokeCaller}),
 * and the platform PAT is never either of them: it authenticates the
 * deployments lookup only. The pod verifies a `Bearer` against the app's user
 * pool (or BYO issuer) and answers 401 to anything else, never a guest
 * fallback (`nocode-runtime/src/identity.ts`), so a PAT sent there would only
 * be refused.
 *
 *   - **guest** (the default): an anonymous visitor, below. An app that has
 *     closed guest access refuses the visitor, and the refusal is printed
 *     verbatim.
 *   - **bearer** (`--bearer-stdin`, guuey#2719): a signed-in end user of the
 *     app. The user's token is read from stdin and sent as
 *     `Authorization: Bearer`, so the pod's `userId` is derived from the
 *     token's subject. WHICH token depends on how the app signs users in, and
 *     the pod decides, never this CLI (it checks only that stdin holds one JWT):
 *       - the guuey end-user pool: the ACCESS token. The pod refuses an ID token
 *         (`Token use not allowed: id`, identity.ts `tokenUse: 'access'`). A
 *         builder has no supported way to obtain one yet (guuey#3211), so the
 *         help text offers this mode for `byo` apps only;
 *       - a `byo` app: the token whose `aud` is the app's configured audience,
 *         with most IdPs (Cognito included) the ID token. The pod refuses a
 *         token without that audience (`Missing Audience …`) and a Cognito
 *         access token (`@guuey-private/byo-identity`, `token_use_not_id`).
 *     Either refusal is printed verbatim. The token never travels in argv or
 *     env (a process list shows both), and the CLI never prints it: a flag
 *     that would carry a token on the command line is refused by name, and the
 *     token is cut out of any pod reply printed on a failure. The stream is
 *     rendered by the SAME printer as a guest turn.
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
 * call — never a silent new thread. A signed-in thread needs no saved secret:
 * the pod keys it to the token's subject, so `--thread` with the same user's
 * token continues it.
 *
 * Usage:
 *   guuey test "What's the weather in Tokyo?"
 *   guuey test "And tomorrow?" --thread <threadId from the first turn>
 *   guuey test "hi" --app-id <id>   # overrides the project binding, left untouched
 *   guuey test "Show me a dashboard" --session sess_existing
 *   guuey test "hi" --url https://my-app.agents.sandbox.guuey.com
 *   guuey test "hi" --bearer-stdin < user-token.txt   # signed in (file mode 0600)
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgEvent } from '@silverprotocol/core';
import { resolveConfig, loadAmplifyOutputs } from '../config';
import { getTestThreadsDir } from '../paths';
import { requireAuth } from '../auth';
import { apiRequest } from '../deploy-shared';
import { podBearerHeader } from './pod-bearer';
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

/**
 * Who a `guuey test` turn speaks as (see the file header): an anonymous
 * visitor holding a guest secret, or a signed-in end user holding their
 * token (guuey#2719; which token, see the file header).
 */
export type InvokeCaller = { kind: 'guest'; secret: string } | { kind: 'bearer'; token: string };

/**
 * Flags that would carry a token on the command line, where any process list
 * shows it. Each is refused by name before anything else runs; the value is
 * never echoed.
 */
export const BEARER_ARGV_FLAGS = ['bearer', 'token', 'access-token', 'id-token', 'jwt', 'authorization'] as const;

/** The flag that reads the user's token from stdin. */
export const BEARER_STDIN_FLAG = 'bearer-stdin';

/** Every refusal of a token on the command line starts with this name, so a script or judge can match it. */
export const BEARER_IN_ARGV = 'bearer-in-argv';

/**
 * The refusal for a token on the command line, or `undefined` when there is
 * none. A `--bearer-stdin` that picked up a value is refused too: the parser
 * reads the word after a flag as its value, and that word may be a token (or
 * the message, put after the flag). The value is never part of the message.
 */
export function bearerArgvRefusal(flags: Record<string, string | true> | undefined): string | undefined {
  const pipeIt = `pipe the token on stdin instead: guuey test "<message>" --${BEARER_STDIN_FLAG} < <token file>`;
  for (const name of BEARER_ARGV_FLAGS) {
    if (flags?.[name] !== undefined) {
      return `${BEARER_IN_ARGV}: --${name} is refused: a token on the command line shows in the process list; ${pipeIt}`;
    }
  }
  if (typeof flags?.[BEARER_STDIN_FLAG] === 'string') {
    return (
      `${BEARER_IN_ARGV}: --${BEARER_STDIN_FLAG} takes no value; the word after it was not used and is not shown. ` +
      `Put the message first: guuey test "<message>" --${BEARER_STDIN_FLAG} < <token file>`
    );
  }
  return undefined;
}

/** A refusal of what `--bearer-stdin` read. Its message never carries the input. */
export class BearerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BearerInputError';
  }
}

/** What `--bearer-stdin` reads: `process.stdin`, or a stand-in in tests. */
export interface BearerInput extends AsyncIterable<Buffer | string> {
  readonly isTTY?: boolean;
}

/** More than any real user token; a larger input is refused, not buffered. */
export const MAX_BEARER_BYTES = 16 * 1024;

/** A compact JWS: three base64url segments. The pod verifies nothing else (aws-jwt-verify). */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Read the user's token from stdin: one JWT, surrounding whitespace dropped.
 * A terminal is refused (a pasted token would echo on screen), as are an
 * empty input, an oversized one and anything that is not one JWT. No refusal
 * shows what was read.
 */
export async function readBearer(input: BearerInput): Promise<string> {
  if (input.isTTY === true) {
    throw new BearerInputError(
      `--${BEARER_STDIN_FLAG} reads the user's token from stdin, and stdin is a terminal. ` +
        'Redirect it from a file only you can read (chmod 600): guuey test "<message>" --bearer-stdin < <token file>',
    );
  }
  let raw = '';
  let bytes = 0;
  for await (const chunk of input) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BEARER_BYTES) {
      throw new BearerInputError(`--${BEARER_STDIN_FLAG}: stdin holds more than ${MAX_BEARER_BYTES} bytes, more than any user token.`);
    }
    raw += text;
  }
  const token = raw.trim();
  if (token === '') throw new BearerInputError(`--${BEARER_STDIN_FLAG}: stdin was empty; it must hold the user's token.`);
  if (!JWT_SHAPE.test(token)) {
    throw new BearerInputError(
      `--${BEARER_STDIN_FLAG}: stdin must hold exactly one JWT (three base64url parts joined by dots, no "Bearer " prefix); ` +
        'what it holds is not shown.',
    );
  }
  return token;
}

/** `text` with every occurrence of the caller's token cut out; a guest's text is returned as is. */
export function redactCaller(text: string, caller: InvokeCaller): string {
  return caller.kind === 'bearer' ? text.split(caller.token).join('[token redacted]') : text;
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

/**
 * The `event:` names the renderer handles, one `case` each in
 * {@link streamToStdout}. Pinned against the runtime EMITTER
 * (`nocode-runtime/src/sse-server.ts`), never against this renderer, by the
 * sync guard in `test.test.ts`.
 */
export const POD_STREAM_EVENTS = ['session', 'message', 'done', 'error'] as const;

/**
 * The pod's `event: session` payload (sse-server.ts header). `userId` and
 * `authMode` are who the pod resolved the caller to: `g_<hash>` +
 * `anonymous` for a guest, the token's subject + `authenticated` for a
 * signed-in caller. Optional, so a frame without them still renders.
 */
interface SessionFrame {
  sessionId: string;
  threadId?: string;
  userId?: string;
  authMode?: string;
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
  io: { stdin: BearerInput } = { stdin: process.stdin },
): Promise<void> {
  // First, before the usage check: a token on the command line is refused even
  // when the parser took the message as that flag's value.
  const argvRefusal = bearerArgvRefusal(flags);
  if (argvRefusal !== undefined) {
    out.error(argvRefusal);
    process.exit(1);
  }
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
  let caller: InvokeCaller;
  if (flags?.[BEARER_STDIN_FLAG] === true) {
    try {
      caller = { kind: 'bearer', token: await readBearer(io.stdin) };
    } catch (err) {
      if (!(err instanceof BearerInputError)) throw err;
      out.error(err.message);
      process.exit(1);
    }
  } else if (threadFlag !== undefined) {
    const saved = loadThreadSecret(appId, threadFlag);
    if (saved === undefined) {
      out.error(
        `No visitor identity saved for thread ${threadFlag} of app ${appId} on this machine. ` +
          'Only a thread `guuey test` started here can be continued — start one without --thread, ' +
          'then pass the thread id it prints.',
      );
      process.exit(1);
    }
    caller = { kind: 'guest', secret: saved };
  } else {
    caller = { kind: 'guest', secret: mintGuestSecret() };
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
  console.log(`  Auth:     ${caller.kind === 'bearer' ? 'bearer (user token from stdin)' : 'guest'}`);
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
  const { url, init } = buildInvokeRequest(endpoint, body, caller);
  const res = await fetch(url, init);

  if (!res.ok) {
    // Redact BEFORE the cut, so a token straddling the 400-char edge is never half-printed.
    const body = redactCaller(await res.text().catch(() => ''), caller);
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
  for (const line of threadFollowUp({ appId, appIdFlag, threadFlag, threadId, caller, errored })) console.log(line);
  if (errored) process.exit(1);
}

/**
 * After the stream: save the visitor secret of the thread the pod named (a
 * guest's; a signed-in thread is keyed to the token's subject and needs none),
 * and say how to continue it. A requested thread the pod did NOT continue
 * (thread persistence off, or the owner check minted a fresh one) is a
 * warning, never silent. Exported for unit test.
 */
export function threadFollowUp(args: {
  appId: string;
  appIdFlag: string | undefined;
  threadFlag: string | undefined;
  threadId: string | undefined;
  caller: InvokeCaller;
  errored: boolean;
  dir?: string;
}): string[] {
  const { appId, appIdFlag, threadFlag, threadId, caller, errored, dir } = args;
  if (threadId === undefined) {
    // An invoke that failed before its session frame already printed why.
    if (errored) return [];
    const why = 'the app keeps no thread history, or the thread store was unavailable for this turn';
    return threadFlag === undefined
      ? [`  (the pod named no thread — ${why}; there is nothing to continue)`]
      : [`  ! the pod named no thread — ${why}; thread ${threadFlag} was not continued`];
  }
  if (caller.kind === 'guest') saveThreadSecret(appId, threadId, caller.secret, dir);
  const lines: string[] = [];
  if (threadFlag !== undefined && threadFlag !== threadId) {
    lines.push(`  ! the pod started a NEW thread ${threadId} instead of continuing ${threadFlag}`);
  }
  const appIdPart = appIdFlag !== undefined ? ` --app-id ${appIdFlag}` : '';
  const signedInPart = caller.kind === 'bearer' ? ` --${BEARER_STDIN_FLAG} < <token file>` : '';
  lines.push(`  Continue this conversation: guuey test "<message>" --thread ${threadId}${appIdPart}${signedInPart}`);
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
 * content-type/accept pair, the caller's ONE credential and the JSON body.
 * A guest sends its guest header and no `Authorization`; a signed-in caller
 * sends `Authorization: Bearer <user token>` and no guest header. The PAT
 * is never either (see the file header).
 */
export function buildInvokeRequest(
  endpoint: string,
  body: InvokeBody,
  caller: InvokeCaller,
): { url: string; init: RequestInit } {
  let credential: Record<string, string>;
  if (caller.kind === 'guest') {
    if (!isGuestSecret(caller.secret)) throw new Error('guest secret must be 64 hex chars');
    credential = { [GUEST_HEADER_NAME]: caller.secret };
  } else {
    if (!JWT_SHAPE.test(caller.token)) throw new BearerInputError('the user token must be one JWT');
    credential = podBearerHeader(caller.token);
  }
  return {
    url: toInvokeUrl(endpoint),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...credential,
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
    (!('threadId' in v) || typeof v.threadId === 'string') &&
    (!('userId' in v) || typeof v.userId === 'string') &&
    (!('authMode' in v) || typeof v.authMode === 'string')
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
 * is in (each done line names its tool, so interleaved calls pair by name,
 * not by adjacency); every other AgJSON event (folds, artifacts, ext.*) and a
 * bypass-mode pod's raw native frames are skipped, never mis-rendered.
 * Exported for unit test.
 */
export async function streamToStdout(
  body: ReadableStream<Uint8Array>,
): Promise<{ stopReason: string | undefined; errored: boolean; threadId: string | undefined }> {
  let stopReason: string | undefined;
  let errored = false;
  let threadId: string | undefined;
  // tool.done carries only the call's id; its name came on the matching tool.start.
  const toolNames = new Map<string, string>();
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
          // Who the pod resolved the caller to: the proof a signed-in turn ran as the token's subject.
          if (payload.userId) {
            console.log(`  [user] ${payload.userId}${payload.authMode ? ` · ${payload.authMode}` : ''}`);
          }
        }
        break;
      case 'message':
        printAgEvent(payload, toolNames);
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

function printAgEvent(payload: unknown, toolNames: Map<string, string>): void {
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
      if (typeof e.name === 'string') {
        if (typeof e.toolCallId === 'string') toolNames.set(e.toolCallId, e.name);
        console.log(`\n  [tool.start] ${e.name}`);
      }
      break;
    case 'tool.done': {
      const name = typeof e.toolCallId === 'string' ? toolNames.get(e.toolCallId) : undefined;
      // A preliminary done (`more: true`) is followed by the call's final done, which needs the name too.
      if (typeof e.toolCallId === 'string' && e.more !== true) toolNames.delete(e.toolCallId);
      const error = e.isError === true || e.outcome === 'error' ? ' error' : '';
      console.log(`  [tool.done]${name === undefined ? '' : ` ${name}`}${error}`);
      break;
    }
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
