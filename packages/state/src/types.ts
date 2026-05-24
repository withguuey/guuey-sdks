/**
 * Public types for `@guuey/state`.
 *
 * The library is intentionally narrow — it's a KV scoped per
 * `(user, mcp)`, not a database. See `docs/principles/mcp-hosting-policy.md`
 * for the rationale: scoped primitives let MCPs hold light state
 * (idempotency, counters, small per-user prefs) without making guuey
 * a backend-as-a-service. Hard caps are the product.
 */

/**
 * Bundle of identifiers that scopes every operation to one
 * `(user, mcp)` namespace. The library never reads these from
 * env or globals at call time; consumers either pass them
 * explicitly to `createGuueyState` or set them via
 * `withGuueyContext` (see `./context`).
 *
 * `userId` is the end-user's guuey identity (Cognito sub, or
 * the anonymous-session id for guest pods). `mcpId` is the
 * MCP server's stable identifier (the deploy's app id). Both
 * are injected into the hosted pod by the deploy controller
 * via `GUUEY_USER_ID` / `GUUEY_MCP_ID` env vars + per-request
 * `X-Guuey-User-Id` / `X-Guuey-Mcp-Id` headers.
 */
export interface ScopeContext {
  readonly userId: string;
  readonly mcpId: string;
}

/**
 * Per-operation options for `set`. TTL is REQUIRED at the type
 * level — there is no "permanent" key in guuey-scoped KV. If
 * the dev wants persistence, they pick a long TTL explicitly.
 * Keeps the platform's storage costs bounded and forces the
 * dev to think about expiry.
 *
 * `ttl` is in seconds. Hard cap: 90 days (60 * 60 * 24 * 90).
 * Longer-lived data should live in the user's own SaaS via
 * mcp-proxy credential brokering — that pattern is preferred
 * for any "meaningful user data" anyway (best privacy posture).
 */
export interface SetOptions {
  /** TTL in seconds. Max 90 days. */
  readonly ttl: number;
}

/**
 * Per-key counter options. Atomic increment is the one
 * "transaction-like" operation the API offers — no MULTI/EXEC,
 * no CAS on arbitrary values. Counters cover the common case
 * (rate limits, generated-id sequences) without opening the door
 * to "build any app on guuey."
 */
export interface IncrementOptions {
  /** Amount to add (default 1). May be negative. */
  readonly by?: number;
  /** TTL in seconds for the (possibly fresh) counter key. */
  readonly ttl: number;
}

/**
 * Snapshot of the current scope's storage usage. Returned by
 * `kv.scope()`. Cheap to call; pulled from the platform on each
 * invocation (no client-side caching) so quota checks before
 * a write reflect the live state.
 */
export interface ScopeInfo {
  readonly userId: string;
  readonly mcpId: string;
  /** Bytes used in this `(user, mcp)` scope. */
  readonly usedBytes: number;
  /** Hard cap for the scope. Today: 1 MiB. */
  readonly limitBytes: number;
  /** Distinct keys in this scope. */
  readonly keyCount: number;
}

/**
 * The KV interface every binding implements (in-memory for local
 * dev, HTTP for hosted pods). Consumer code only ever sees this
 * shape — they never touch the underlying transport.
 *
 * All methods are async even when they could be sync — keeps the
 * shape stable across local-vs-hosted bindings and discourages
 * "sync KV in the hot path" patterns that hide latency.
 *
 * Type parameter `T` on `get`/`set`: a structural hint, NOT a
 * runtime check. The library JSON-serializes on write and parses
 * on read. If the read shape doesn't match the type parameter,
 * you get a wrongly-typed value with no warning. Pair with a
 * schema (zod, valibot, …) at the call site if runtime safety
 * matters.
 */
export interface Kv {
  /** Read a key. Returns `undefined` if absent or expired. */
  get<T = unknown>(key: string): Promise<T | undefined>;

  /** Write a key. TTL is required (no permanent keys). */
  set<T = unknown>(key: string, value: T, opts: SetOptions): Promise<void>;

  /** Delete a key. No-op if absent. */
  delete(key: string): Promise<void>;

  /** Cheap existence check without deserializing the value. */
  has(key: string): Promise<boolean>;

  /**
   * List keys in this scope, optionally filtered by prefix.
   * Cap: 1000 keys per call. Use this for diagnostics and small
   * housekeeping; do NOT use it as a query engine. A scope that
   * needs to "find all keys matching pattern X across millions
   * of entries" wants a real database (Case B in the hosting
   * policy).
   */
  keys(opts?: { prefix?: string; limit?: number }): Promise<string[]>;

  /**
   * Atomic increment. Creates the key (initialized to 0) if
   * missing, then adds `by` (default 1) and returns the new
   * value. Useful for rate-limit counters, generated-id
   * sequences, simple analytics.
   *
   * The TTL is reset on every increment to the value passed —
   * idle counters expire naturally.
   */
  increment(key: string, opts: IncrementOptions): Promise<number>;

  /** Inverse of `increment`. Same semantics. */
  decrement(key: string, opts: IncrementOptions): Promise<number>;

  /** Bulk read. Missing keys map to `undefined`. */
  mget<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>>;

  /**
   * Snapshot of current scope usage. Use this BEFORE a large
   * write to fail fast if you're near the quota cap rather than
   * eating a `QuotaExceededError` mid-batch.
   */
  scope(): Promise<ScopeInfo>;
}

/**
 * Options for `createGuueyState`. The library tries to pick the
 * right binding automatically:
 *
 * 1. If `bindingUrl` is set → HTTP binding against guuey's KV API.
 * 2. Else if `GUUEY_KV_URL` env is set → same.
 * 3. Else → in-memory fallback (with a one-time warning).
 *
 * The in-memory fallback exists for unit tests + local development
 * outside `guuey dev`. Never use it in production — guuey-hosted
 * pods get `GUUEY_KV_URL` injected at boot.
 */
export interface CreateGuueyStateOptions {
  /** Scope identity. Required. */
  readonly context: ScopeContext;
  /** Override the binding URL (defaults to `GUUEY_KV_URL` env). */
  readonly bindingUrl?: string;
  /** Override the auth token (defaults to `GUUEY_KV_TOKEN` env). */
  readonly authToken?: string;
}
