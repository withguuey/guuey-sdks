/**
 * `guuey dev --serve` — the local SSE server (Task 11). Pod-parity: same
 * `POST /agent/invoke` SSE wire framing as `backend/services/nocode-runtime/
 * src/sse-server.ts` (see its module doc for the full contract), driving the
 * builder's own worker via {@link createLocalDriver} (Task 10) instead of a
 * sandboxed pod. Deliberately minimal vs. the pod: no persistence (in-memory
 * per-session history only), no render metering, no reducer/fold, no
 * ceiling timer, no JWT auth — those are platform concerns this local loop
 * doesn't need. The in-memory history IS served back over
 * `GET /threads/:id/messages` (guuey#110) in the read-plane's row shape
 * (`@guuey/agent-client`'s `fetchThreadHistory` contract), so a client
 * reload repaints against the dev server the same way it does hosted —
 * text rows only (no fold means no `kind:'card'` rows locally), and a
 * restart forgets sessions, surfacing as 404 → the client's `gone` path.
 *
 * `sendEvent`'s two-line framing (`event: <name>\ndata: <JSON>\n\n`) MUST
 * byte-match the pod's `sendEvent` (`sse-server.ts:1166`) — the chat client
 * is the same SSE parser on both legs.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerEvent } from "@guuey/worker";
import { colocatedResourceUrl, type GuueyAgent, type GuueyAgentMcpServer } from "@guuey/config";
import type { Normalizer } from "@silverprotocol/core";
import { createLocalDriver, type LocalRunInput } from "./local-driver.js";
import { makeNormalizer } from "./normalize.js";

/** Local dev-loop's default `ggui serve` MCP endpoint — mirrors the platform
 *  injecting `mcp.ggui.ai` for deployed agents (see `lowerForDev`). `ggui
 *  serve --mcp-only` (booted on :6781 by the scaffolded `pnpm dev`) mounts
 *  its MCP transport at `/mcp`, like every colocated dev MCP. */
const DEFAULT_GGUI_DEV_URL = "http://localhost:6781/mcp";
/**
 * The platform-default ggui MCP url (`DEFAULT_AGENT_MCP_SERVERS.ggui` in
 * @guuey/config) — mirrored as the string it compares against so the dev
 * server does not couple to the config package's object shape; the
 * lowerForDev test pins this mirror against the real default.
 */
const DEFAULT_GGUI_PLATFORM_URL = "https://mcp.ggui.ai";

/** 256KB request-body cap — matches the pod's `readJsonBody` (`sse-server.ts`). */
const MAX_BODY_BYTES = 256 * 1024;

export interface DevServerOptions {
  /** Port to bind. `0` binds an ephemeral port — read the actual bound port
   *  off the returned handle (tests rely on this). */
  port: number;
  framework: string;
  protocol: "silver" | "bypass";
  workerCommand: string;
  workerArgs: string[];
  /** The lowered `GuueyAgent` snapshot, JSON-stringified — injected into the
   *  worker's env as `GUUEY_AGENT_SNAPSHOT` (same env var `@guuey/host` and
   *  the pod both read). */
  agentSnapshotJson: string;
  /** Project root — `fs.app` for every invoke, and the base for per-session
   *  `.guuey-dev/sessions/<sessionId>/{home,session}` tmp dirs. */
  projectRoot: string;
  /**
   * Graceful mode: the CLI acts as the LOCAL credential broker. When set,
   * every invoke first writes `<session>/.guuey/credentials/<name>.json`
   * (the exact file contract the Router's broker writes in production) from
   * these lowered servers — the platform host sources MCP exclusively from
   * cred files and would otherwise run tool-less locally.
   */
  localCredentials?: Record<string, { url: string; transport: "http" | "sse" }>;
  /**
   * Dev-identity: which of `localCredentials`' servers were lowered FROM a
   * `colocated` entry (`lowerForDev`'s `colocatedNames`), plus the
   * `colocatedResourceUrl` `appId` segment (`guuey.json#appId` if present,
   * else `'local'`). Threaded through to {@link writeLocalCredentials} so
   * only those servers' credential files carry the unsigned dev-identity
   * bearer token.
   */
  devIdentity?: DevIdentity;
}

/** See {@link DevServerOptions.devIdentity}. */
export interface DevIdentity {
  /** Names of servers lowered FROM a `colocated` entry — see {@link LowerForDevResult.colocatedNames}. */
  colocatedNames: ReadonlySet<string>;
  /** `colocatedResourceUrl`'s `appId` segment for this project. */
  devAppId: string;
}

export interface DevServerHandle {
  /** The actual bound port (resolves `port: 0` to the OS-assigned port). */
  port: number;
  close(): Promise<void>;
}

interface SessionState {
  /** `at` rides along for the history route's row shape; the worker driver's
   *  `LocalRunInput['history']` only reads `role`/`text` (structural). */
  history: Array<{ role: "user" | "agent"; text: string; at: string }>;
}

function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export interface LowerForDevResult {
  /** The agent with every `mcpServers` entry lowered (or dropped). */
  agent: GuueyAgent;
  /**
   * Names of servers lowered FROM a `colocated` entry. Consumed by
   * `commands/dev.ts` to build the {@link DevIdentity} `writeLocalCredentials`
   * needs: colocated MCP servers are the only local servers whose handler
   * code calls `scopeFromAuthorization` (they run the guuey-managed
   * `@guuey/state` middleware pattern), so they're the only ones that need a
   * guuey-shaped bearer token — hosted/external servers are the builder's own
   * infra and get `headers: {}`, same as today.
   */
  colocatedNames: Set<string>;
}

/**
 * Lower an agent's `mcpServers` for local dev — the CLI-side mirror of what
 * the deploy-controller resolves server-side for a live pod:
 *
 * - `hosted` / `external` WITH `devPort` → rewritten to
 *   `{ kind: 'external', url: 'http://localhost:<devPort>', transport: 'http' }`
 *   (the entry is served locally by another `pnpm dev` process, e.g. a
 *   colocated MCP's own dev server).
 * - `colocated` WITH `devPort` → rewritten the same way (and its name is
 *   recorded in `colocatedNames`) — `devPort` is REQUIRED for a colocated
 *   entry to work locally, since `guuey dev` has no pod/Router to supervise
 *   it and no port to dial otherwise.
 * - `external` WITHOUT `devPort` → unchanged (already a real, reachable URL).
 * - `colocated` WITHOUT `devPort` → dropped with a console warning naming the
 *   fix (add `devPort`).
 * - `hosted` WITHOUT `devPort` carrying `server` (a registry-reuse entry —
 *   an existing MCP on the guuey fleet) → THROWS, failing the dev boot: the
 *   fleet isn't reachable from a local `guuey dev` loop, so silently
 *   dropping it would boot an agent silently missing the tools its system
 *   prompt promises. Message names both fixes (`devPort` to run a local
 *   copy, `guuey deploy` to test against the live server).
 * - `hosted` WITHOUT `devPort` and WITHOUT `server` (build-from-source —
 *   `source` only, not yet resolved to a registry id by a deploy) → dropped
 *   with an actionable console warning naming both fixes (`devPort` to run
 *   it locally now; `guuey deploy` — there's no live server to dial before
 *   that). Warns rather than throws: pre-deploy there's no live server this
 *   would silently miss, unlike the registry-reuse case above.
 * - `external` with `credential: 'oauth'` (guuey#178) → dropped with an
 *   actionable console warning: the third-party OAuth broker is a deploy-only
 *   path (the pod dials the hosted gateway route the deploy-controller lowers
 *   the entry to; there is no lowered snapshot in a local loop) — `guuey
 *   deploy` to test it.
 *
 * Also platform-injects the default local `ggui serve` endpoint when no
 * `ggui` entry is present — mirrors the platform injecting `mcp.ggui.ai` for
 * a deployed agent that never declared `mcpServers.ggui`.
 */
export function lowerForDev(agent: GuueyAgent): LowerForDevResult {
  const servers = agent.mcpServers ?? {};
  const lowered: Record<string, GuueyAgentMcpServer> = {};
  const colocatedNames = new Set<string>();
  let hasGgui = false;

  for (const [name, entry] of Object.entries(servers)) {
    if (name === "ggui") hasGgui = true;

    // `ggui: false` — the generative-UI opt-out (guuey#24). NOT a server: there
    // is nothing to lower, and the `hasGgui` flag above already suppresses the
    // default local `ggui serve` injection below, so `guuey dev` matches the
    // deployed behaviour (the pod's `effectiveMcpServers` drops it too).
    if (entry === false) continue;

    if ((entry.kind === "hosted" || entry.kind === "external") && entry.devPort !== undefined) {
      lowered[name] = {
        kind: "external",
        // `/mcp` is the colocated dev servers' fixed mount point (the
        // scaffolded todo MCP, `guuey mcp new`'s mcp-base, `ggui serve` all
        // serve the streamable-HTTP transport there); a bare
        // `localhost:<port>` would 404 at MCP-connect time.
        url: `http://localhost:${entry.devPort}/mcp`,
        transport: "http",
      };
      continue;
    }
    if (entry.kind === "colocated") {
      if (entry.devPort === undefined) {
        console.warn(
          `guuey dev: dropping MCP server "${name}" (kind: colocated) — add devPort to the colocated entry in guuey.json`,
        );
        continue;
      }
      lowered[name] = {
        kind: "external",
        url: `http://localhost:${entry.devPort}/mcp`,
        transport: "http",
      };
      colocatedNames.add(name);
      continue;
    }
    if (entry.kind === "external") {
      if (entry.credential === "oauth") {
        console.warn(
          `guuey dev: dropping MCP server "${name}" (credential: oauth) — third-party OAuth servers run through the hosted credential-broker gateway, which has no local-dev counterpart; run 'guuey deploy' to test it`,
        );
        continue;
      }
      // guuey#368: a ggui entry at EXACTLY the platform-default URL lowers
      // to the local `ggui serve` endpoint — early scaffolds shipped the
      // default `https://mcp.ggui.ai` verbatim in guuey.json, which passed
      // through here un-dialable (no local credentials) AND suppressed the
      // default injection below, so the out-of-box agent silently lost
      // generative UI. The platform default has a local-dev counterpart by
      // definition; a CUSTOM external ggui url stays untouched (the builder
      // pointed at a real server on purpose).
      if (
        name === "ggui" &&
        entry.url === DEFAULT_GGUI_PLATFORM_URL &&
        entry.credential === undefined
      ) {
        lowered.ggui = { kind: "external", url: DEFAULT_GGUI_DEV_URL, transport: "http" };
        continue;
      }
      lowered[name] = entry;
      continue;
    }
    if (entry.kind === "hosted" && entry.server !== undefined) {
      throw new Error(
        `hosted registry MCP "${name}" can't run in guuey dev — it runs on the guuey fleet. Add a devPort to run a local copy, or run 'guuey deploy' to test against the live server.`,
      );
    }
    if (entry.kind === "hosted" && entry.source !== undefined) {
      console.warn(
        `guuey dev: dropping MCP server "${name}" (kind: hosted) — built from source with no devPort set; add a devPort to run it locally, or run 'guuey deploy' first (nothing live to dial until then)`,
      );
      continue;
    }
  }

  if (!hasGgui) {
    lowered.ggui = { kind: "external", url: DEFAULT_GGUI_DEV_URL, transport: "http" };
  }

  return { agent: { ...agent, mcpServers: lowered }, colocatedNames };
}

/** Parse + size-cap the invoke request body. Throws a plain `Error` with a
 *  human-readable message on any violation (caller turns it into a 400). */
async function readInvokeBody(
  req: IncomingMessage,
): Promise<{ input: string; sessionId: string | undefined }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `body is not valid JSON: ${cause instanceof Error ? cause.message : "parse error"}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("body must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.input !== "string") {
    throw new Error("body.input must be a string");
  }
  const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : undefined;
  return { input: obj.input, sessionId };
}

/**
 * Build the unsigned dev-identity JWT `@guuey/state`'s `scopeFromAuthorization`
 * decodes (see its doc comment: decodes WITHOUT verifying, the KV API is the
 * verifier — DX only). `alg: 'none'`, empty signature segment (the token
 * still has the 3 dot-separated parts `scopeFromAuthorization` requires; the
 * 3rd is just `''`) — honest about being unsigned rather than faking a sig.
 * `aud` is the same `colocatedResourceUrl(devAppId, serverName)` production's
 * `lowerColocated` mints against, so the decoded `mcpId` matches what a
 * deployed colocated MCP would see for the same `(appId, name)`.
 */
function buildDevToken(devAppId: string, serverName: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: "dev-user",
      aud: colocatedResourceUrl(devAppId, serverName),
      iat,
      exp: iat + 86400,
    }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}

/**
 * Write the local broker's credential files (see
 * {@link DevServerOptions.localCredentials}) into a session dir. Idempotent
 * per invoke.
 *
 * Servers named in `devIdentity.colocatedNames` (colocated-derived — see
 * {@link LowerForDevResult.colocatedNames}) get `headers: { authorization:
 * 'Bearer <dev token>' }` so their `scopeFromAuthorization` middleware yields
 * a real scope locally. Every other server keeps `headers: {}` (unchanged —
 * no tokens locally for builder-hosted infra).
 */
export function writeLocalCredentials(
  sessionDir: string,
  servers: Record<string, { url: string; transport: "http" | "sse" }>,
  devIdentity?: DevIdentity,
): void {
  const dir = join(sessionDir, ".guuey", "credentials");
  mkdirSync(dir, { recursive: true });
  for (const [name, s] of Object.entries(servers)) {
    const headers = devIdentity?.colocatedNames.has(name)
      ? { authorization: `Bearer ${buildDevToken(devIdentity.devAppId, name)}` }
      : {};
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ url: s.url, transport: s.transport, headers }));
  }
}

/** mkdir-ing per-session `{home,session}` dirs under `<projectRoot>/.guuey-dev/sessions/<sessionId>`. */
function sessionFs(projectRoot: string, sessionId: string): LocalRunInput["fs"] {
  const base = join(projectRoot, ".guuey-dev", "sessions", sessionId);
  const home = join(base, "home");
  const session = join(base, "session");
  mkdirSync(home, { recursive: true });
  mkdirSync(session, { recursive: true });
  return { app: projectRoot, home, session };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // Authorization / x-guuey-guest: the client's history reader attaches its
  // host identity headers unconditionally (`fetchThreadHistory` requestInit);
  // the dev server ignores them, but the browser preflight must not.
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-guuey-guest",
};

/** `GET /threads/:id/messages` — the read-plane route the dev server mirrors. */
const THREAD_MESSAGES_ROUTE = /^\/threads\/([^/]+)\/messages$/;

/** Page size cap, matching the client's `HISTORY_PAGE_LIMIT`. */
const HISTORY_MAX_LIMIT = 100;

/**
 * Serve a session's in-memory history in the public read-plane's wire shape
 * (guuey#110): `{ rows, nextToken }`, rows ascending by seq, `nextToken` a
 * plain offset. Thread id = the `sessionId` the first SSE `session` frame
 * handed the client. Unknown ids 404 — a restarted dev server forgot its
 * sessions, and the client's `gone` handling (drop the stale id, start
 * fresh) is exactly the right local behavior.
 */
function handleThreadMessages(
  res: ServerResponse,
  sessions: Map<string, SessionState>,
  threadId: string,
  searchParams: URLSearchParams,
): void {
  const state = sessions.get(threadId);
  if (!state) {
    res.writeHead(404, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: "unknown thread" }));
    return;
  }
  const limitRaw = Number(searchParams.get("limit") ?? String(HISTORY_MAX_LIMIT));
  const limit =
    Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, HISTORY_MAX_LIMIT) : HISTORY_MAX_LIMIT;
  const tokenRaw = searchParams.get("nextToken");
  const offset = tokenRaw === null ? 0 : Number(tokenRaw);
  if (!Number.isInteger(offset) || offset < 0) {
    res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: "nextToken must be a non-negative integer offset" }));
    return;
  }
  const rows = state.history.slice(offset, offset + limit).map((entry, i) => ({
    seq: offset + i + 1,
    at: entry.at,
    kind: "text",
    authorRole: entry.role,
    text: entry.text,
  }));
  const consumed = offset + rows.length;
  const nextToken = consumed < state.history.length ? String(consumed) : null;
  res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify({ rows, nextToken }));
}

async function handleInvoke(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DevServerOptions,
  driver: (input: LocalRunInput) => AsyncIterable<WorkerEvent>,
  sessions: Map<string, SessionState>,
): Promise<void> {
  let body: { input: string; sessionId: string | undefined };
  try {
    body = await readInvokeBody(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return;
  }

  const sessionId = body.sessionId ?? randomUUID();
  const state = sessions.get(sessionId) ?? { history: [] };
  sessions.set(sessionId, state);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...CORS_HEADERS,
  });
  // guuey#368: the frame TELLS the client its thread identity — the id is
  // the same one this server already keys /threads/:id/messages by. The
  // client's hook stores it, history rehydrates across page reloads (of a
  // living server; a restart's in-memory loss surfaces through the kit's
  // honest gone-notice), and the reader's platform arm gets its scope.
  // Without it the hook's threadId stayed null for the scaffold's whole
  // life — half of the zero-requests face the docs lab located.
  sendEvent(res, "session", {
    sessionId,
    threadId: sessionId,
    userId: "dev-user",
    authMode: "anonymous",
  });

  const abortController = new AbortController();
  req.on("close", () => {
    if (!abortController.signal.aborted) abortController.abort();
  });

  let stopReason: "end_turn" | "max_turns" | "error" = "end_turn";
  let agentText = "";

  try {
    // Inside the try so an unknown-framework throw (`AGJSON_NO_NORMALIZER:*`)
    // still terminates the stream with the standard `event: error` frame —
    // every invoke that emitted a `session` frame MUST end in `done`/`error`,
    // even for callers that bypass commands/dev.ts's framework gate.
    const normalizer: Normalizer | undefined =
      opts.protocol === "silver" ? makeNormalizer(opts.framework) : undefined;

    const fs = sessionFs(opts.projectRoot, sessionId);
    if (opts.localCredentials) writeLocalCredentials(fs.session, opts.localCredentials, opts.devIdentity);
    for await (const ev of driver({
      input: body.input,
      history: state.history,
      fs,
      env: { ...process.env, GUUEY_AGENT_SNAPSHOT: opts.agentSnapshotJson },
      abortSignal: abortController.signal,
    })) {
      if (ev.type === "hello") {
        // Router-plane only — never forwarded to SSE, never fed to a normalizer.
        continue;
      }
      if (ev.type === "error") {
        throw new Error(ev.message);
      }
      if (ev.type === "done") {
        stopReason = ev.stopReason;
        agentText = ev.result;
        break;
      }
      if (ev.type === "native" && normalizer) {
        const batch = normalizer.push(ev.event);
        if (batch.length > 0) sendEvent(res, "message", batch);
        continue;
      }
      // bypass mode (any event type), OR a `text` event in silver mode (no
      // native SDKMessage to push — relay verbatim rather than drop it).
      // PARITY GAP (tracked): the pod's F3 path instead SYNTHESIZES an
      // assistant SDKMessage from a `text` event and runs it through the full
      // normalize path so the turn folds (`backend/services/nocode-runtime/
      // src/sse-server.ts` ~299-320, `assistantMessage()` + the `text` arm).
      // Revisit if hand-authored `serve()`-based workers (text-only, no
      // native events) are supported in local dev — until then verbatim
      // relay is the honest minimal behavior.
      sendEvent(res, "message", ev);
    }
    if (normalizer) {
      const flushed = normalizer.flush();
      if (flushed.length > 0) sendEvent(res, "message", flushed);
    }
    state.history.push({ role: "user", text: body.input, at: new Date().toISOString() });
    if (agentText) {
      state.history.push({ role: "agent", text: agentText, at: new Date().toISOString() });
    }
    sendEvent(res, "done", { stopReason });
  } catch (err) {
    sendEvent(res, "error", {
      code: "WORKER_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    res.end();
  }
}

/**
 * The LOCAL pod door (guuey#368 residual, docs' re-capture find): the kit's
 * default reader dials `GET <pod>/agent/ui-resource?uri=` on every live
 * locator — in production the pod runtime answers it; locally NOTHING did,
 * so every generative card rendered "This view expired" while the tool
 * layer reported success. The dev server answers the same contract the
 * production door speaks: resolve the producing MCP server from the
 * locator's authority segment (`ui://<server>/…` — the producers' own
 * convention; ggui's `ui://ggui/render/…` is the platform default), one
 * fresh `resources/read` over the SAME lowered endpoint the agent talks
 * to, first `contents[]` entry out as `{uri, mimeType?, text?|blob?,
 * _meta?}`. Misses are 404 (the reader treats every non-OK as a miss and
 * falls through). Loopback-only like every route here; identity headers
 * are ignored — local dev has one user.
 */
function uiResourceServerMap(agentSnapshotJson: string): Map<string, string> {
  const servers = new Map<string, string>();
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(agentSnapshotJson);
  } catch {
    return servers; // an unparseable snapshot already fails the invoke path loudly
  }
  if (typeof snapshot !== "object" || snapshot === null || !("mcpServers" in snapshot)) {
    return servers;
  }
  const entries: unknown = snapshot.mcpServers;
  if (typeof entries !== "object" || entries === null) return servers;
  for (const [name, entry] of Object.entries(entries)) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!("url" in entry) || typeof entry.url !== "string") continue;
    servers.set(name, entry.url);
  }
  return servers;
}

/**
 * One MCP client per lowered server url, connected lazily and kept for the
 * dev server's life (a streamable-HTTP session per producer is the normal
 * shape). A failed connect/read drops the cache entry so the NEXT read
 * reconnects fresh — no retry loop, the miss surfaces immediately.
 */
type UiClientCache = Map<string, Promise<Client>>;

async function uiClientFor(cache: UiClientCache, url: string): Promise<Client> {
  const cached = cache.get(url);
  if (cached !== undefined) return cached;
  const connecting = (async () => {
    const client = new Client({ name: "guuey-dev-ui-door", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  })();
  cache.set(url, connecting);
  try {
    return await connecting;
  } catch (err) {
    cache.delete(url);
    throw err;
  }
}

/**
 * The LOCAL action door (guuey#477) — the read door's twin (guuey#222's
 * pod contract): `POST /agent/ui-action` with `{uri, name, arguments?}`
 * relays the in-card click as a real `tools/call` to the PRODUCING MCP
 * server (same authority-segment routing and client cache as the read
 * door). 2xx = the tool result verbatim (an `isError` result is still a
 * RESULT); 404 = miss (unknown authority, bad body — the relay's
 * deny==miss contract); 502 = the call itself failed transport-side.
 * Production pods additionally enforce the locator's session binding —
 * local dev has one user, so the door skips auth like every route here
 * (loopback-only).
 */
async function handleUiAction(
  req: IncomingMessage,
  res: ServerResponse,
  servers: Map<string, string>,
  clients: UiClientCache,
): Promise<void> {
  const miss = (why: string): void => {
    res.writeHead(404, { "Content-Type": "text/plain", ...CORS_HEADERS });
    res.end(why);
  };
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    miss("body is not JSON");
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    miss("body is not an object");
    return;
  }
  const uri = "uri" in parsed && typeof parsed.uri === "string" ? parsed.uri : null;
  const name = "name" in parsed && typeof parsed.name === "string" ? parsed.name : null;
  const args =
    "arguments" in parsed && typeof parsed.arguments === "object" && parsed.arguments !== null
      ? (parsed.arguments as Record<string, unknown>)
      : undefined;
  if (uri === null || !uri.startsWith("ui://") || name === null) {
    miss("missing uri/name or non-ui:// uri");
    return;
  }
  let authority: string;
  try {
    authority = new URL(uri).host;
  } catch {
    miss("unparseable uri");
    return;
  }
  const serverUrl = servers.get(authority);
  if (serverUrl === undefined) {
    miss(`no local MCP server named "${authority}"`);
    return;
  }
  let result: unknown;
  try {
    const client = await uiClientFor(clients, serverUrl);
    result = await client.callTool({ name, arguments: args });
  } catch (err) {
    clients.delete(serverUrl); // next call reconnects fresh
    console.warn(
      `[guuey dev] ui-action ${name} failed via ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: "tool call failed" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(result));
}

async function handleUiResource(
  res: ServerResponse,
  searchParams: URLSearchParams,
  servers: Map<string, string>,
  clients: UiClientCache,
): Promise<void> {
  const miss = (why: string): void => {
    res.writeHead(404, { "Content-Type": "text/plain", ...CORS_HEADERS });
    res.end(why);
  };
  const uri = searchParams.get("uri");
  if (uri === null || !uri.startsWith("ui://")) {
    miss("missing or non-ui:// uri");
    return;
  }
  let authority: string;
  try {
    authority = new URL(uri).host;
  } catch {
    miss("unparseable uri");
    return;
  }
  const serverUrl = servers.get(authority);
  if (serverUrl === undefined) {
    miss(`no local MCP server named "${authority}"`);
    return;
  }
  let contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string; _meta?: unknown }>;
  try {
    const client = await uiClientFor(clients, serverUrl);
    const read = await client.readResource({ uri });
    contents = read.contents;
  } catch (err) {
    clients.delete(serverUrl); // next read reconnects fresh
    console.warn(
      `[guuey dev] ui-resource read failed for ${uri} via ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    miss("read failed");
    return;
  }
  const entry = contents[0];
  if (entry === undefined || (typeof entry.text !== "string" && typeof entry.blob !== "string")) {
    miss("no readable contents");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(
    JSON.stringify({
      uri: entry.uri,
      ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
      ...(typeof entry.text === "string" ? { text: entry.text } : {}),
      ...(typeof entry.blob === "string" ? { blob: entry.blob } : {}),
      ...(entry._meta !== undefined ? { _meta: entry._meta } : {}),
    }),
  );
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DevServerOptions,
  driver: (input: LocalRunInput) => AsyncIterable<WorkerEvent>,
  sessions: Map<string, SessionState>,
  uiServers: Map<string, string>,
  uiClients: UiClientCache,
): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    // CORS so a browser frontend (the scaffolded web app on another port)
    // can probe liveness — every other route already carries these.
    res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
    res.end("ok");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const threadMatch = THREAD_MESSAGES_ROUTE.exec(url.pathname);
  if (req.method === "GET" && url.pathname === "/agent/ui-resource") {
    await handleUiResource(res, url.searchParams, uiServers, uiClients);
    return;
  }
  if (req.method === "POST" && url.pathname === "/agent/ui-action") {
    await handleUiAction(req, res, uiServers, uiClients);
    return;
  }
  if (
    req.method === "OPTIONS" &&
    (req.url === "/agent/invoke" ||
      url.pathname === "/agent/ui-resource" ||
      url.pathname === "/agent/ui-action" ||
      threadMatch !== null)
  ) {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method === "POST" && req.url === "/agent/invoke") {
    await handleInvoke(req, res, opts, driver, sessions);
    return;
  }
  if (req.method === "GET" && threadMatch !== null) {
    handleThreadMessages(res, sessions, decodeURIComponent(threadMatch[1]!), url.searchParams);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

/** Boot the local dev SSE server. Resolves once the server is listening,
 *  with the ACTUAL bound port (so `port: 0` callers can read the ephemeral
 *  port the OS assigned). */
export function startDevServer(opts: DevServerOptions): Promise<DevServerHandle> {
  const driver = createLocalDriver({ command: opts.workerCommand, args: opts.workerArgs });
  const sessions = new Map<string, SessionState>();
  // The local pod door's routing table + per-producer client cache
  // (guuey#368 residual — see handleUiResource).
  const uiServers = uiResourceServerMap(opts.agentSnapshotJson);
  const uiClients: UiClientCache = new Map();

  const server = createServer((req, res) => {
    handleRequest(req, res, opts, driver, sessions, uiServers, uiClients).catch((err) => {
      console.error(
        `[guuey dev] request handler error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`internal error: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        res.end();
      }
    });
  });

  return new Promise((resolve) => {
    // Bind loopback-only (mirrors sandbox-proxy.ts) — this server proxies
    // invokes straight to the dev's LLM key; binding all interfaces would
    // let anything on the LAN spend it.
    server.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr !== null ? addr.port : opts.port;
      resolve({
        port: boundPort,
        close: async () => {
          // Close the door's cached MCP clients FIRST: each holds a
          // standing streamable-HTTP session (an SSE GET) against its
          // producer — left open, both this server's close and the
          // producer's would wait on the socket forever (the test-suite
          // hang that found this). Best-effort: a producer that already
          // vanished must not fail shutdown.
          await Promise.all(
            [...uiClients.values()].map((p) =>
              p.then((client) => client.close()).catch(() => undefined),
            ),
          );
          uiClients.clear();
          await new Promise<void>((res2, rej2) => {
            server.close((err) => (err ? rej2(err) : res2()));
          });
        },
      });
    });
  });
}
