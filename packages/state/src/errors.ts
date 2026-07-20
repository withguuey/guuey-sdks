/**
 * Typed error hierarchy for `@guuey/state`. Every operation that
 * can fail throws a subclass of `GuueyStateError`, so call sites
 * can `instanceof`-discriminate without parsing message strings.
 */

export class GuueyStateError extends Error {
  /** Stable, machine-readable error code. */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GuueyStateError";
    this.code = code;
  }
}

/**
 * The scope is at or above its byte limit. Thrown by `set` and
 * `increment` when the write would push usage past the cap.
 * Includes the live `usedBytes` + `limitBytes` so the caller can
 * surface a meaningful error to the user.
 */
export class QuotaExceededError extends GuueyStateError {
  readonly usedBytes: number;
  readonly limitBytes: number;

  constructor(usedBytes: number, limitBytes: number) {
    super(
      "QUOTA_EXCEEDED",
      `Scope used ${usedBytes}B of ${limitBytes}B limit. ` +
        `Delete keys or move long-lived data to user-owned storage ` +
        `(mcp-proxy + their Notion/Drive/S3) — see guuey MCP Hosting Policy.`,
    );
    this.name = "QuotaExceededError";
    this.usedBytes = usedBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * A single value exceeds the per-value cap. Today: 64 KiB.
 * Large blobs belong in `@guuey/files` (planned), not in KV.
 */
export class ValueTooLargeError extends GuueyStateError {
  readonly valueBytes: number;
  readonly limitBytes: number;

  constructor(valueBytes: number, limitBytes: number) {
    super(
      "VALUE_TOO_LARGE",
      `Value is ${valueBytes}B; max is ${limitBytes}B per key. ` +
        `Split the value, or use @guuey/files when it ships.`,
    );
    this.name = "ValueTooLargeError";
    this.valueBytes = valueBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * Key string is too long or contains a forbidden character. Today:
 * 1 KiB max length; ASCII letters, digits, and `_.:-/` only
 * (the standard "URL-safe-ish" set). Keeps keys cheap to log + index.
 */
export class InvalidKeyError extends GuueyStateError {
  readonly key: string;

  constructor(key: string, reason: string) {
    const shown =
      key.length > 64 ? `${JSON.stringify(key.slice(0, 64))}…` : JSON.stringify(key);
    super("INVALID_KEY", `Invalid key ${shown}: ${reason}`);
    this.name = "InvalidKeyError";
    this.key = key;
  }
}

/**
 * TTL is missing, zero, negative, or above the 90-day cap.
 */
export class InvalidTtlError extends GuueyStateError {
  readonly ttl: unknown;

  constructor(ttl: unknown, reason: string) {
    super("INVALID_TTL", `Invalid TTL ${JSON.stringify(ttl)}: ${reason}`);
    this.name = "InvalidTtlError";
    this.ttl = ttl;
  }
}

/**
 * The library was called without a `ScopeContext` — either no
 * `createGuueyState({ context })` AND no surrounding
 * `withGuueyContext(...)` block. Common in unit tests that import
 * `kv` from the barrel without setting up context.
 */
export class MissingContextError extends GuueyStateError {
  constructor() {
    super(
      "MISSING_CONTEXT",
      `@guuey/state was called without a scope context. ` +
        `Either pass { context } to createGuueyState, or wrap the call ` +
        `in withGuueyContext({ userId, mcpId }, async () => { ... }).`,
    );
    this.name = "MissingContextError";
  }
}

/**
 * `increment`/`decrement` was called on a key whose stored value is
 * not a number. Counter ops require number-typed keys; mixing a
 * counter and a JSON value under one key is a calling-code bug.
 */
export class TypeMismatchError extends GuueyStateError {
  readonly key: string;
  readonly actualType: string;

  constructor(key: string, actualType: string) {
    super(
      "TYPE_MISMATCH",
      `Key ${JSON.stringify(key)} holds a ${actualType} value; ` +
        `increment/decrement require number-typed keys.`,
    );
    this.name = "TypeMismatchError";
    this.key = key;
    this.actualType = actualType;
  }
}

/**
 * A per-call argument is outside its allowed range — e.g. a
 * `keys()` limit outside 1..1000, or an `mget` batch over 100 keys.
 * Distinct from `InvalidKeyError`/`InvalidTtlError`, which cover the
 * key and TTL contracts specifically.
 */
export class InvalidArgumentError extends GuueyStateError {
  constructor(reason: string) {
    super("INVALID_ARGUMENT", `Invalid argument: ${reason}`);
    this.name = "InvalidArgumentError";
  }
}

/**
 * A `ScopeContext` field is unusable — empty, or containing
 * whitespace/control characters. Scope ids are platform-issued
 * opaque identifiers (Cognito subs, app ids); anything with
 * whitespace in it is a wiring bug at the call site, and the
 * storage layer refuses it rather than risking scope ambiguity.
 */
export class InvalidContextError extends GuueyStateError {
  readonly field: "userId" | "mcpId";

  constructor(field: "userId" | "mcpId", reason: string) {
    super("INVALID_CONTEXT", `Invalid ScopeContext.${field}: ${reason}`);
    this.name = "InvalidContextError";
    this.field = field;
  }
}

/**
 * The KV binding's transport call failed (HTTP 5xx, network blip,
 * timeout). Includes the underlying cause for diagnostics. The
 * caller may safely retry idempotent reads.
 */
export class TransportError extends GuueyStateError {
  constructor(message: string, cause?: unknown) {
    super("TRANSPORT", message, cause !== undefined ? { cause } : undefined);
    this.name = "TransportError";
  }
}
