/**
 * `guuey dev --serve` — the local SSE server (Task 11). Pod-parity: same
 * `POST /agent/invoke` SSE wire framing as `backend/services/nocode-runtime/
 * src/sse-server.ts` (see its module doc for the full contract), driving the
 * builder's own worker via {@link createLocalDriver} (Task 10) instead of a
 * sandboxed pod. Deliberately minimal vs. the pod: no persistence (in-memory
 * per-session history only), no render metering, no reducer/fold, no
 * ceiling timer, no JWT auth — those are platform concerns this local loop
 * doesn't need.
 *
 * `sendEvent`'s two-line framing (`event: <name>\ndata: <JSON>\n\n`) MUST
 * byte-match the pod's `sendEvent` (`sse-server.ts:1166`) — the chat client
 * is the same SSE parser on both legs.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  history: Array<{ role: "user" | "agent"; text: string }>;
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
 * - `proxied` / `hosted` WITHOUT `devPort` → no local-dev story yet (v1) —
 *   dropped with a console warning rather than silently failing at invoke
 *   time.
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
      lowered[name] = entry;
      continue;
    }
    console.warn(
      `guuey dev: dropping MCP server "${name}" (kind: ${entry.kind}) — unsupported in local dev v1`,
    );
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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
  sendEvent(res, "session", { sessionId, userId: "dev-user", authMode: "anonymous" });

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
    state.history.push({ role: "user", text: body.input });
    if (agentText) state.history.push({ role: "agent", text: agentText });
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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DevServerOptions,
  driver: (input: LocalRunInput) => AsyncIterable<WorkerEvent>,
  sessions: Map<string, SessionState>,
): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "OPTIONS" && req.url === "/agent/invoke") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method === "POST" && req.url === "/agent/invoke") {
    await handleInvoke(req, res, opts, driver, sessions);
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

  const server = createServer((req, res) => {
    handleRequest(req, res, opts, driver, sessions).catch((err) => {
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
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err) => (err ? rej2(err) : res2()));
          }),
      });
    });
  });
}
