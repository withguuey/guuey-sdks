/**
 * Hosted HTTP binding — {@link ThreadPersistencePort} over guuey's thread
 * API, `POST <base>/v1/thread-store/<op>` (guuey#208). The "eject the code,
 * keep your memory" leg of the ejected ladder: point a `ThreadStore` at
 * this binding with an end-user token and your self-hosted agent reads and
 * writes the SAME conversation rows guuey's hosted runtime does.
 *
 * Wire protocol (the `@guuey/state` `HttpKv` shape):
 * - Request: JSON body `{ context: { appId }, args: {...} }`, header
 *   `Authorization: Bearer <token>`.
 * - Success: `200 { result }`.
 * - Failure: `4xx/5xx { code, message }` → {@link HttpThreadStoreError}.
 *
 * Auth + tenancy: the token is an END-USER token for the app — one the
 * app's configured identity issuer minted (your own IdP, or guuey's per-app
 * widget issuer via `@guuey/widget-auth`). The server verifies it against
 * that issuer, derives the same `byo_…` userId the hosted runtime would, and
 * scopes every op to `(appId, userId)`: rows you write must carry that
 * userId, threads you touch must belong to it. `context` on the wire is
 * advisory — the token is authoritative. Call {@link scope} to learn the
 * derived userId (and the API's region) before `ensureThread`.
 *
 * Retry policy: reads (`getThread`/`listRecentMessages`/
 * `findByClientMessageId`/`getSnapshot`/`scope`) are idempotent and retried
 * once on a network failure or a 5xx. Writes (`createThread`/`incrementSeq`/
 * `putMessage`/`putSnapshot`) are NEVER retried automatically —
 * `incrementSeq` is not idempotent, and a blind retry after a server-side
 * apply would double-allocate a seq.
 */
import type {
  ThreadMessageRow,
  ThreadPersistencePort,
  ThreadRow,
  ThreadSnapshotRow,
} from "./rows.js";

/** What the token resolves to server-side — the scope every op is bound to. */
export interface ThreadScope {
  appId: string;
  /** The derived end-user id (`byo_…`) — the `userId` to build rows with. */
  userId: string;
  /** The API's serving region — the `region` to mint fresh threads with. */
  region: string;
}

export interface HttpThreadPersistenceOptions {
  /** API origin, e.g. `https://api.us-east-1.guuey.com` (no `/v1`). */
  baseUrl: string;
  /** The guuey app whose conversations these are. */
  appId: string;
  /** The end-user's bearer token (see the module doc). */
  token: string;
  /** Injection seam for tests / custom transports. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Shape of a `4xx/5xx` error response body. */
interface ErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
}

/** Shape of a `200` success response body. */
interface ResultEnvelope<R> {
  readonly result: R;
}

/**
 * Thrown for every non-2xx response and every exhausted network failure.
 * `code` is the server's flat error code (`UNAUTHORIZED`, `FORBIDDEN`,
 * `INVALID_ARGUMENT`, `INVALID_CONTEXT`, `THREAD_NOT_FOUND`, `CONFLICT`,
 * `NOT_FOUND`, `TRANSPORT`); `status` is the HTTP status (`0` for a network
 * failure that never produced a response).
 */
export class HttpThreadStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "HttpThreadStoreError";
  }
}

async function toError(res: Response): Promise<HttpThreadStoreError> {
  let body: ErrorEnvelope;
  try {
    body = (await res.json()) as ErrorEnvelope;
  } catch {
    body = {};
  }
  return new HttpThreadStoreError(
    res.status,
    body.code ?? "TRANSPORT",
    body.message ?? `guuey thread API error (HTTP ${res.status})`,
  );
}

export class HttpThreadPersistence implements ThreadPersistencePort {
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpThreadPersistenceOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.appId = opts.appId;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The `(appId, userId, region)` the server bound this token to. */
  async scope(): Promise<ThreadScope> {
    return this.call<ThreadScope>("scope", {}, true);
  }

  async getThread(threadId: string): Promise<ThreadRow | undefined> {
    return (await this.call<ThreadRow | null>("getThread", { threadId }, true)) ?? undefined;
  }

  async createThread(row: ThreadRow): Promise<void> {
    await this.call<null>("createThread", { row }, false);
  }

  async incrementSeq(threadId: string, preview: string | null, atIso: string): Promise<number> {
    return this.call<number>("incrementSeq", { threadId, preview, atIso }, false);
  }

  async putMessage(row: ThreadMessageRow): Promise<void> {
    await this.call<null>("putMessage", { row }, false);
  }

  async listRecentMessages(threadId: string, limit: number): Promise<ThreadMessageRow[]> {
    return this.call<ThreadMessageRow[]>("listRecentMessages", { threadId, limit }, true);
  }

  async findByClientMessageId(
    threadId: string,
    clientMessageId: string,
  ): Promise<ThreadMessageRow | undefined> {
    return (
      (await this.call<ThreadMessageRow | null>(
        "findByClientMessageId",
        { threadId, clientMessageId },
        true,
      )) ?? undefined
    );
  }

  async getSnapshot(threadId: string): Promise<ThreadSnapshotRow | undefined> {
    return (await this.call<ThreadSnapshotRow | null>("getSnapshot", { threadId }, true)) ?? undefined;
  }

  async putSnapshot(row: ThreadSnapshotRow): Promise<void> {
    await this.call<null>("putSnapshot", { row }, false);
  }

  // ── internals ──────────────────────────────────────────────────────

  /**
   * One shared retry budget (`retried`) covers BOTH retry triggers — a
   * network failure and a 5xx response — so a retryable op makes at most
   * 2 total requests, never 3.
   */
  private async call<R>(op: string, args: object, retryable: boolean): Promise<R> {
    const doOnce = async (): Promise<Response> =>
      this.fetchImpl(`${this.baseUrl}/v1/thread-store/${op}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ context: { appId: this.appId }, args }),
      });
    let res: Response;
    let retried = false;
    for (;;) {
      try {
        res = await doOnce();
      } catch (err) {
        if (!retryable || retried) {
          throw new HttpThreadStoreError(
            0,
            "TRANSPORT",
            `network failure calling guuey thread API${retried ? " (after retry)" : ""}`,
            { cause: err },
          );
        }
        retried = true;
        continue;
      }
      if (res.status >= 500 && retryable && !retried) {
        retried = true;
        continue;
      }
      break;
    }
    if (!res.ok) throw await toError(res);
    const body = (await res.json()) as ResultEnvelope<R>;
    return body.result;
  }
}
