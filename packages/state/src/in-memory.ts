/**
 * In-memory KV binding for local development + unit tests.
 *
 * Used automatically when `GUUEY_KV_URL` is unset (typical for
 * `pnpm test` and `guuey dev` runs without the bridge). Logs a
 * one-time `console.warn` so a forgotten in-memory binding in
 * production doesn't silently swallow data.
 *
 * Behavior mirrors what the real HTTP binding will do:
 * - Bytes counted as UTF-8 bytes of `JSON.stringify(value)` — the
 *   same accounting any real storage backend uses. (NOT string
 *   `.length`, which counts UTF-16 code units and under-counts
 *   non-ASCII values up to ~3×.)
 * - TTL enforced on read (expired keys return `undefined` and
 *   are evicted lazily)
 * - Per-scope quota enforcement
 * - Same error shapes
 */
import {
  InvalidArgumentError,
  InvalidKeyError,
  InvalidTtlError,
  QuotaExceededError,
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

const SCOPE_LIMIT_BYTES = 1 * 1024 * 1024; // 1 MiB
const VALUE_LIMIT_BYTES = 64 * 1024; // 64 KiB
const KEY_LIMIT_BYTES = 1024;
const TTL_MAX_SECONDS = 60 * 60 * 24 * 90; // 90 days
const MGET_LIMIT = 100;
const VALID_KEY = /^[A-Za-z0-9_.:\-/]+$/;

interface Entry {
  /** JSON-encoded value. */
  jsonValue: string;
  /**
   * UTF-8 byte size of the KEY plus `jsonValue` (computed once at
   * write). Keys count toward the scope quota too — otherwise a
   * scope full of 1 KiB keys with 1-byte values would report as
   * nearly empty while holding megabytes.
   */
  bytes: number;
  /** Epoch ms when this key expires. */
  expiresAt: number;
}

/**
 * JSON-encode a value for storage, converting every serialization
 * failure into the library's typed error. `JSON.stringify` returns
 * the VALUE `undefined` (not a string) for top-level `undefined`,
 * functions, and symbols, and throws natively for circular
 * structures and `BigInt` — none of which may escape as a bare
 * `TypeError` (the error contract promises `GuueyStateError`
 * subclasses from every failable operation).
 */
function encodeValue(key: string, value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new InvalidArgumentError(
      `value for key ${JSON.stringify(key)} is not JSON-serializable ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (json === undefined) {
    throw new InvalidArgumentError(
      `value for key ${JSON.stringify(key)} is not JSON-serializable ` +
        `(top-level undefined, function, or symbol)`,
    );
  }
  return json;
}

/**
 * Process-wide store shared across every `InMemoryKv` instance.
 * Scope isolation lives in the key (`userId`, NUL, `mcpId`), not in
 * the instance — two `createGuueyState` calls with the same context
 * read each other's data, which matches the production HTTP binding's
 * behavior + matches the implicit-via-AsyncLocalStorage `kv` barrel
 * that constructs a fresh binding per call.
 */
const sharedStore = new Map<string, Map<string, Entry>>();

/**
 * Test-only helper: wipe the process-wide store. NOT exported from
 * the package barrel — consumers should never touch this. Tests
 * import it directly from `./in-memory.js`.
 */
export function __resetInMemoryStoreForTests(): void {
  sharedStore.clear();
}

let warnedOnce = false;

function emitOneTimeWarning(): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(
    "[@guuey/state] Using the in-memory KV binding. Data is " +
      "per-process and non-durable (lost on restart, not shared " +
      "across pods). No hosted binding exists yet — this is " +
      "currently the only implementation.",
  );
}

export class InMemoryKv implements Kv {
  private readonly context: ScopeContext;

  constructor(context: ScopeContext) {
    this.context = context;
    emitOneTimeWarning();
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    validateKey(key);
    const entry = this.scopeMap().get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.scopeMap().delete(key);
      return undefined;
    }
    return JSON.parse(entry.jsonValue) as T;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    opts: SetOptions,
  ): Promise<void> {
    validateKey(key);
    validateTtl(opts.ttl);
    const json = encodeValue(key, value);
    const valueBytes = Buffer.byteLength(json, "utf8");
    if (valueBytes > VALUE_LIMIT_BYTES) {
      throw new ValueTooLargeError(valueBytes, VALUE_LIMIT_BYTES);
    }
    const bytes = Buffer.byteLength(key, "utf8") + valueBytes;
    const scope = this.scopeMap();
    const existing = scope.get(key);
    const projectedBytes = this.usedBytes() - (existing?.bytes ?? 0) + bytes;
    if (projectedBytes > SCOPE_LIMIT_BYTES) {
      throw new QuotaExceededError(projectedBytes, SCOPE_LIMIT_BYTES);
    }
    scope.set(key, {
      jsonValue: json,
      bytes,
      expiresAt: Date.now() + opts.ttl * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    this.scopeMap().delete(key);
  }

  async has(key: string): Promise<boolean> {
    validateKey(key);
    const entry = this.scopeMap().get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.scopeMap().delete(key);
      return false;
    }
    return true;
  }

  async keys(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<KeysPage> {
    const prefix = opts?.prefix ?? "";
    const limit = opts?.limit ?? 1000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new InvalidArgumentError(
        `keys() limit must be an integer in 1..1000 (got ${limit})`,
      );
    }
    // Lexicographic pagination: sort matching live keys, resume
    // strictly after the cursor. Deterministic and binding-portable
    // (any sorted-key store paginates the same way); O(n log n) per
    // page is fine for a dev binding capped at 1 MiB per scope.
    const now = Date.now();
    const live: string[] = [];
    for (const [k, entry] of this.scopeMap()) {
      if (entry.expiresAt <= now) {
        this.scopeMap().delete(k);
        continue;
      }
      if (!k.startsWith(prefix)) continue;
      if (opts?.cursor !== undefined && k <= opts.cursor) continue;
      live.push(k);
    }
    live.sort();
    const page = live.slice(0, limit);
    const last = page[page.length - 1];
    if (live.length > limit && last !== undefined) {
      return { keys: page, cursor: last };
    }
    return { keys: page };
  }

  async increment(key: string, opts: IncrementOptions): Promise<number> {
    validateKey(key);
    validateTtl(opts.ttl);
    const by = opts.by ?? 1;
    if (!Number.isSafeInteger(by)) {
      throw new InvalidArgumentError(
        `increment/decrement 'by' must be a safe integer (got ${by}) — ` +
          `counters are integer-only`,
      );
    }
    // The whole read-modify-write is SYNCHRONOUS — no `await` between
    // the read and the write. Routing through get()/set() (async) let
    // two concurrent increments interleave at the await points and
    // both read the same base value (lost update). JS's single thread
    // makes an uninterrupted sync block genuinely atomic, which is the
    // contract the real counter op must honor (conditional-update on
    // the backend).
    const scope = this.scopeMap();
    const entry = scope.get(key);
    let current = 0;
    let liveEntryBytes = 0;
    if (entry && entry.expiresAt > Date.now()) {
      const parsed: unknown = JSON.parse(entry.jsonValue);
      if (typeof parsed !== "number") {
        throw new TypeMismatchError(key, typeof parsed);
      }
      current = parsed;
      liveEntryBytes = entry.bytes;
    }
    const next = current + by;
    if (!Number.isSafeInteger(next)) {
      throw new InvalidArgumentError(
        `counter ${JSON.stringify(key)} would leave the safe-integer ` +
          `range (${current} + ${by})`,
      );
    }
    const json = JSON.stringify(next);
    const bytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(json, "utf8");
    const projectedBytes = this.usedBytes() - liveEntryBytes + bytes;
    if (projectedBytes > SCOPE_LIMIT_BYTES) {
      throw new QuotaExceededError(projectedBytes, SCOPE_LIMIT_BYTES);
    }
    scope.set(key, {
      jsonValue: json,
      bytes,
      expiresAt: Date.now() + opts.ttl * 1000,
    });
    return next;
  }

  async decrement(key: string, opts: IncrementOptions): Promise<number> {
    return this.increment(key, { ...opts, by: -(opts.by ?? 1) });
  }

  async mget<T = unknown>(
    keys: string[],
  ): Promise<Record<string, T | undefined>> {
    if (keys.length > MGET_LIMIT) {
      throw new InvalidArgumentError(
        `mget() accepts at most ${MGET_LIMIT} keys per call (got ` +
          `${keys.length}) — split into batches`,
      );
    }
    // Null-prototype accumulator: a plain `{}` inherits the
    // `Object.prototype.__proto__` accessor, so a key literally named
    // "__proto__" (legal under VALID_KEY) would either vanish from the
    // result (primitive value) or REPLACE the result's prototype
    // (object value). `Object.create(null)` has no such accessor.
    const out: Record<string, T | undefined> = Object.create(null) as Record<
      string,
      T | undefined
    >;
    for (const k of keys) {
      out[k] = await this.get<T>(k);
    }
    return out;
  }

  async scope(): Promise<ScopeInfo> {
    return {
      userId: this.context.userId,
      mcpId: this.context.mcpId,
      usedBytes: this.usedBytes(),
      limitBytes: SCOPE_LIMIT_BYTES,
      keyCount: this.scopeMap().size,
    };
  }

  // ── internals ──────────────────────────────────────────────────────

  private scopeKey(): string {
    // NUL delimiter: unlike a printable separator it cannot collide
    // with id content (`validateContext` rejects control characters,
    // so no context field can ever contain U+0000).
    return `${this.context.userId}\u0000${this.context.mcpId}`;
  }

  private scopeMap(): Map<string, Entry> {
    const key = this.scopeKey();
    let map = sharedStore.get(key);
    if (!map) {
      map = new Map();
      sharedStore.set(key, map);
    }
    return map;
  }

  private usedBytes(): number {
    // Expired entries don't count toward the quota (and are evicted on
    // the way) — otherwise a scope full of dead keys rejects fresh
    // writes with QuotaExceededError until each corpse is individually
    // read. Mirrors what any real TTL store's accounting does.
    const scope = this.scopeMap();
    const now = Date.now();
    let total = 0;
    for (const [k, entry] of scope) {
      if (entry.expiresAt <= now) {
        scope.delete(k);
        continue;
      }
      total += entry.bytes;
    }
    return total;
  }
}

function validateKey(key: string): void {
  if (key.length === 0) {
    throw new InvalidKeyError(key, "must be non-empty");
  }
  if (Buffer.byteLength(key, "utf8") > KEY_LIMIT_BYTES) {
    throw new InvalidKeyError(key, `must be <= ${KEY_LIMIT_BYTES} bytes`);
  }
  if (!VALID_KEY.test(key)) {
    throw new InvalidKeyError(
      key,
      "may only contain ASCII letters, digits, and `_.:-/`",
    );
  }
}

function validateTtl(ttl: number): void {
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new InvalidTtlError(ttl, "must be a positive finite number");
  }
  if (ttl > TTL_MAX_SECONDS) {
    throw new InvalidTtlError(
      ttl,
      `must be <= ${TTL_MAX_SECONDS} seconds (90 days). ` +
        `Long-lived data belongs in user-owned storage via mcp-proxy.`,
    );
  }
}
