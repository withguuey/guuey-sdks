/**
 * Hosted HTTP binding — talks to the guuey KV API over
 * `POST <base>/v1/state/<op>`.
 *
 * Wire protocol (server side lands in a later slice):
 * - Request: JSON body `{ context: { userId, mcpId }, args: {...} }`,
 *   header `Authorization: Bearer <token>`.
 * - Success: `200 { result }`.
 * - Failure: `4xx/5xx { code, message, ...fields }` — `code` maps
 *   1:1 onto this package's typed error classes (see `toTypedError`).
 *
 * Retry policy: reads (`get`/`has`/`keys`/`mget`/`scope`) are
 * idempotent and retried once — on a network failure, or on a 5xx
 * response. Writes (`set`/`delete`/`increment`/`decrement`) are
 * NEVER retried automatically: a network failure after the server
 * applied the write would make a blind retry double-apply it (worst
 * case for `increment`/`decrement`, which are not naturally
 * idempotent).
 */
import {
  GuueyStateError,
  InvalidArgumentError,
  InvalidContextError,
  InvalidKeyError,
  InvalidTtlError,
  MissingContextError,
  QuotaExceededError,
  TransportError,
  TypeMismatchError,
  ValueTooLargeError,
} from "./errors.js";
import type {
  IncrementOptions,
  KeysPage,
  Kv,
  ScopeContext,
  ScopeInfo,
  SetOptions,
} from "./types.js";
import { VALUE_LIMIT_BYTES, encodeValue, validateKey, validateTtl } from "./validate.js";

/** Shape of a `4xx/5xx` error response body. Fields are op-specific. */
interface ErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
  readonly usedBytes?: number;
  readonly limitBytes?: number;
  readonly valueBytes?: number;
  readonly key?: string;
  readonly reason?: string;
  readonly ttl?: unknown;
  readonly actualType?: string;
  readonly field?: string;
}

/** Shape of a `200` success response body. */
interface ResultEnvelope<R> {
  readonly result: R;
}

/**
 * Map a non-ok `Response` to the exact typed error the caller should
 * see. `401`/`403` (auth-layer rejection, not a KV-level error) and
 * any code this client doesn't recognize both fall back to
 * `TransportError` — better an honest "the transport failed" than a
 * misleading typed error built from fields that may not exist.
 */
async function toTypedError(res: Response): Promise<GuueyStateError> {
  let body: ErrorEnvelope;
  try {
    body = (await res.json()) as ErrorEnvelope;
  } catch {
    body = {};
  }
  const message = body.message ?? `guuey state API error (HTTP ${res.status})`;
  if (res.status === 401 || res.status === 403) {
    return new TransportError(`${message} (HTTP ${res.status})`);
  }
  switch (body.code) {
    case "QUOTA_EXCEEDED":
      return new QuotaExceededError(body.usedBytes ?? 0, body.limitBytes ?? 0);
    case "VALUE_TOO_LARGE":
      return new ValueTooLargeError(body.valueBytes ?? 0, body.limitBytes ?? 0);
    case "INVALID_KEY":
      return new InvalidKeyError(body.key ?? "", body.reason ?? message);
    case "INVALID_TTL":
      return new InvalidTtlError(body.ttl, body.reason ?? message);
    case "TYPE_MISMATCH":
      return new TypeMismatchError(body.key ?? "", body.actualType ?? "unknown");
    case "INVALID_ARGUMENT":
      return new InvalidArgumentError(body.reason ?? message);
    case "INVALID_CONTEXT":
      return new InvalidContextError(
        body.field === "mcpId" ? "mcpId" : "userId",
        body.reason ?? message,
      );
    case "MISSING_CONTEXT":
      return new MissingContextError();
    default:
      return new TransportError(`${message} (HTTP ${res.status})`);
  }
}

export class HttpKv implements Kv {
  constructor(
    private readonly baseUrl: string,
    private readonly context: ScopeContext,
    private readonly authToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    validateKey(key);
    return this.call<T | undefined>("get", { key }, true);
  }

  async set<T = unknown>(key: string, value: T, opts: SetOptions): Promise<void> {
    validateKey(key);
    validateTtl(opts.ttl);
    const json = encodeValue(key, value);
    const valueBytes = Buffer.byteLength(json, "utf8");
    if (valueBytes > VALUE_LIMIT_BYTES) {
      throw new ValueTooLargeError(valueBytes, VALUE_LIMIT_BYTES);
    }
    await this.call<undefined>("set", { key, value, ttl: opts.ttl }, false);
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    await this.call<undefined>("delete", { key }, false);
  }

  async has(key: string): Promise<boolean> {
    validateKey(key);
    return this.call<boolean>("has", { key }, true);
  }

  async keys(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<KeysPage> {
    return this.call<KeysPage>(
      "keys",
      { prefix: opts?.prefix, limit: opts?.limit, cursor: opts?.cursor },
      true,
    );
  }

  async increment(key: string, opts: IncrementOptions): Promise<number> {
    validateKey(key);
    validateTtl(opts.ttl);
    return this.call<number>("increment", { key, by: opts.by, ttl: opts.ttl }, false);
  }

  async decrement(key: string, opts: IncrementOptions): Promise<number> {
    validateKey(key);
    validateTtl(opts.ttl);
    return this.call<number>("decrement", { key, by: opts.by, ttl: opts.ttl }, false);
  }

  async mget<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>> {
    for (const key of keys) validateKey(key);
    return this.call<Record<string, T | undefined>>("mget", { keys }, true);
  }

  async scope(): Promise<ScopeInfo> {
    return this.call<ScopeInfo>("scope", {}, true);
  }

  // ── internals ──────────────────────────────────────────────────────

  private async call<R>(op: string, args: object, retryable: boolean): Promise<R> {
    const doOnce = async (): Promise<Response> =>
      this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/v1/state/${op}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({
          context: { userId: this.context.userId, mcpId: this.context.mcpId },
          args,
        }),
      });
    let res: Response;
    try {
      res = await doOnce();
    } catch (err) {
      if (!retryable) throw new TransportError("network failure calling guuey state API", err);
      res = await doOnce().catch((err2: unknown) => {
        throw new TransportError("network failure calling guuey state API (after retry)", err2);
      });
    }
    if (res.status >= 500 && retryable) res = await doOnce();
    if (!res.ok) throw await toTypedError(res);
    const body = (await res.json()) as ResultEnvelope<R>;
    return body.result;
  }
}
