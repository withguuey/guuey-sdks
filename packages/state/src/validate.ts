/**
 * Shared key/TTL/value validation + cap constants.
 *
 * Both bindings (in-memory, hosted HTTP) enforce the exact same
 * contract on keys/TTLs/values before touching storage — living here
 * once means the two implementations can never drift on what counts
 * as a valid key, TTL, or JSON-serializable value.
 */
import { InvalidArgumentError, InvalidKeyError, InvalidTtlError } from "./errors.js";

export const SCOPE_LIMIT_BYTES = 1 * 1024 * 1024; // 1 MiB
export const VALUE_LIMIT_BYTES = 64 * 1024; // 64 KiB
export const KEY_LIMIT_BYTES = 1024;
export const TTL_MAX_SECONDS = 60 * 60 * 24 * 90; // 90 days
export const MGET_LIMIT = 100;
export const VALID_KEY = /^[A-Za-z0-9_.:\-/]+$/;

export function validateKey(key: string): void {
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

export function validateTtl(ttl: number): void {
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

/**
 * JSON-encode a value for storage, converting every serialization
 * failure into the library's typed error. `JSON.stringify` returns
 * the VALUE `undefined` (not a string) for top-level `undefined`,
 * functions, and symbols, and throws natively for circular
 * structures and `BigInt` — none of which may escape as a bare
 * `TypeError` (the error contract promises `GuueyStateError`
 * subclasses from every failable operation).
 */
export function encodeValue(key: string, value: unknown): string {
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
