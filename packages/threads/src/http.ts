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
 * - Every body is parsed to `unknown` and read through `http-read.ts`; a 2xx
 *   whose body is not an envelope, or whose `result` is not what the op
 *   answers, is an {@link HttpThreadStoreError} with code `BAD_RESPONSE`.
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
import { DYNAMODB_ROW_BUDGET } from "./item-size.js";
import { ThreadClosedError } from "./closed.js";
import {
  isWireObject,
  readAllocatedSeq,
  readThreadMessageRow,
  readThreadMessageRows,
  readThreadRow,
  readThreadScope,
  readThreadSnapshotRow,
} from "./http-read.js";
import type {
  RowBudget,
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

/**
 * Thrown for every non-2xx response and every exhausted network failure.
 * `code` is the server's flat error code (`UNAUTHORIZED`, `FORBIDDEN`,
 * `INVALID_ARGUMENT`, `INVALID_CONTEXT`, `THREAD_NOT_FOUND`, `CONFLICT`,
 * `NOT_FOUND`, `TRANSPORT`, and the client's own `BAD_RESPONSE` for a 2xx body
 * it cannot read; `incrementSeq`'s `THREAD_CLOSED` is thrown as
 * `ThreadClosedError` instead); `status` is the HTTP status (`0` for a network
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

/** A response body: the parsed JSON (`unknown` until read), or why it did not parse. */
type ParsedBody = { readonly parsed: true; readonly value: unknown } | { readonly parsed: false; readonly cause: unknown };

async function parsedBody(res: Response): Promise<ParsedBody> {
  try {
    const value: unknown = await res.json();
    return { parsed: true, value };
  } catch (cause) {
    return { parsed: false, cause };
  }
}

async function toError(res: Response): Promise<HttpThreadStoreError> {
  // `{ code, message }`, each read only when it is a string: a body that is
  // not one (not JSON, a gateway's HTML page) keeps the transport defaults.
  const body = await parsedBody(res);
  const env = body.parsed && isWireObject(body.value) ? body.value : undefined;
  return new HttpThreadStoreError(
    res.status,
    typeof env?.code === "string" ? env.code : "TRANSPORT",
    typeof env?.message === "string" ? env.message : `guuey thread API error (HTTP ${res.status})`,
    body.parsed ? undefined : { cause: body.cause },
  );
}

/** The refusal for a 2xx whose body the op cannot read. */
function badResponse(res: Response, op: string, what: string, cause?: unknown): HttpThreadStoreError {
  return new HttpThreadStoreError(
    res.status,
    "BAD_RESPONSE",
    `guuey thread API ${op}: ${what} (HTTP ${res.status})`,
    cause !== undefined ? { cause } : undefined,
  );
}

export class HttpThreadPersistence implements ThreadPersistencePort {
  /**
   * guuey#1794: the server stores the rows this binding sends in DynamoDB, so
   * the store sizes them by DynamoDB's own item rules before it sends any.
   */
  readonly rowBudget: RowBudget = DYNAMODB_ROW_BUDGET;

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
    return this.call("scope", {}, true, readThreadScope);
  }

  async getThread(threadId: string): Promise<ThreadRow | undefined> {
    return this.pointRead("getThread", { threadId }, readThreadRow);
  }

  async createThread(row: ThreadRow): Promise<void> {
    await this.write("createThread", { row });
  }

  async incrementSeq(threadId: string, preview: string | null, atIso: string): Promise<number> {
    try {
      return await this.call("incrementSeq", { threadId, preview, atIso }, false, readAllocatedSeq);
    } catch (err) {
      // The server's word for a closed thread (guuey#2355) becomes the typed
      // refusal every binding gives, so a ThreadStore reads it the same way.
      if (err instanceof HttpThreadStoreError && err.code === "THREAD_CLOSED") {
        throw new ThreadClosedError(threadId);
      }
      throw err;
    }
  }

  async putMessage(row: ThreadMessageRow): Promise<void> {
    await this.write("putMessage", { row });
  }

  async listRecentMessages(threadId: string, limit: number): Promise<ThreadMessageRow[]> {
    return this.call("listRecentMessages", { threadId, limit }, true, readThreadMessageRows);
  }

  async findByClientMessageId(
    threadId: string,
    clientMessageId: string,
  ): Promise<ThreadMessageRow | undefined> {
    return this.pointRead("findByClientMessageId", { threadId, clientMessageId }, readThreadMessageRow);
  }

  async getSnapshot(threadId: string): Promise<ThreadSnapshotRow | undefined> {
    return this.pointRead("getSnapshot", { threadId }, readThreadSnapshotRow);
  }

  async putSnapshot(row: ThreadSnapshotRow): Promise<void> {
    await this.write("putSnapshot", { row });
  }

  // ── internals ──────────────────────────────────────────────────────

  /** A write: never retried, and its `result` (the server's `null`) is not read. */
  private async write(op: string, args: object): Promise<void> {
    await this.send(op, args, false);
  }

  /** A point read: `null` (the port's `undefined`) or the row `read` proves. */
  private async pointRead<R>(op: string, args: object, read: (value: unknown) => R | undefined): Promise<R | undefined> {
    const row = await this.call(op, args, true, (value) => (value === null ? null : read(value)));
    return row ?? undefined;
  }

  /**
   * The op's `{ result }` envelope, its `result` read by `read`. `undefined`
   * from `read` (the result is not this op's answer) is `BAD_RESPONSE`.
   */
  private async call<R>(
    op: string,
    args: object,
    retryable: boolean,
    read: (value: unknown) => R | undefined,
  ): Promise<R> {
    const { res, body } = await this.send(op, args, retryable);
    if (!isWireObject(body) || !("result" in body)) throw badResponse(res, op, "the body is not a { result } envelope");
    const value = read(body.result);
    if (value === undefined) throw badResponse(res, op, "the result does not read as this op's answer");
    return value;
  }

  /**
   * One op on the wire: the 2xx response and its parsed body (`unknown`), or
   * the typed error. One shared retry budget (`retried`) covers BOTH retry
   * triggers — a network failure and a 5xx response — so a retryable op makes
   * at most 2 total requests, never 3.
   */
  private async send(op: string, args: object, retryable: boolean): Promise<{ res: Response; body: unknown }> {
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
    const body = await parsedBody(res);
    if (!body.parsed) throw badResponse(res, op, "the body is not JSON", body.cause);
    return { res, body: body.value };
  }
}
