/**
 * `@guuey/state` — open-source KV client for MCP servers
 * hosted on guuey.com.
 *
 * Scope: every operation runs inside one `(userId, mcpId)` namespace.
 * The MCP server holds no data of its own; data ownership stays
 * with the user (export + delete in the guuey console).
 *
 * Two import shapes:
 *
 * **Explicit** (test-friendly, no AsyncLocalStorage):
 * ```ts
 * import { createGuueyState } from '@guuey/state';
 *
 * const kv = createGuueyState({
 *   context: { userId: 'u_abc', mcpId: 'mcp_xyz' },
 * });
 * await kv.set('hello', 'world', { ttl: 60 });
 * ```
 *
 * **Implicit via middleware** (production MCP servers):
 * ```ts
 * import { withGuueyContext } from '@guuey/state/context';
 * import { kv } from '@guuey/state';
 *
 * // Inside your tool handler, the surrounding middleware has set
 * // the AsyncLocalStorage context from the request headers.
 * await kv.set('hello', 'world', { ttl: 60 });
 * ```
 *
 * The hard caps + design rationale live in
 * `docs/principles/mcp-hosting-policy.md`.
 */

import { getCurrentContext, validateContext } from "./context.js";
import { MissingContextError, TransportError } from "./errors.js";
import { InMemoryKv } from "./in-memory.js";
import type {
  CreateGuueyStateOptions,
  Kv,
  ScopeContext,
} from "./types.js";

export type {
  CreateGuueyStateOptions,
  IncrementOptions,
  KeysPage,
  Kv,
  ScopeContext,
  ScopeInfo,
  SetOptions,
} from "./types.js";

export {
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

export {
  withGuueyContext,
  getCurrentContext,
  validateContext,
} from "./context.js";

/**
 * Create a KV instance bound to the given scope context.
 *
 * Binding selection:
 *
 *   1. `options.bindingUrl` or `GUUEY_KV_URL` env → the hosted HTTP
 *      binding. NOT BUILT YET (no guuey KV API exists on any env), so
 *      requesting it throws `TransportError` — failing loud beats
 *      silently handing back a non-durable in-memory store to a caller
 *      who explicitly asked for the hosted one (data would vanish on
 *      pod restart with zero signal).
 *   2. Otherwise → in-memory binding with a one-time warning.
 *      Suitable for tests and `guuey dev` runs.
 */
export function createGuueyState(opts: CreateGuueyStateOptions): Kv {
  validateContext(opts.context);
  const bindingUrl = opts.bindingUrl ?? process.env.GUUEY_KV_URL;
  if (bindingUrl) {
    throw new TransportError(
      `The hosted KV binding is not implemented yet (requested via ` +
        `${opts.bindingUrl ? "options.bindingUrl" : "GUUEY_KV_URL"}=` +
        `${JSON.stringify(bindingUrl)}). Unset it to use the in-memory ` +
        `binding, or wait for the guuey KV API to ship.`,
    );
  }
  return new InMemoryKv(opts.context);
}

/**
 * Convenience: the barrel-exported `kv` reads the current scope
 * context from AsyncLocalStorage on every call. Use this when
 * your MCP server framework has installed `withGuueyContext` as
 * middleware.
 *
 * Throws `MissingContextError` if called outside a context.
 */
export const kv: Kv = makeAlsKv();

function makeAlsKv(): Kv {
  // Each method wraps `bind()` in an async IIFE so a missing-context
  // throw surfaces as a rejected Promise (matching the async return
  // type) instead of a synchronous throw at the call site. The
  // in-memory binding's underlying store is module-level shared, so
  // a fresh binding per call still sees the same data.
  const withBinding = async <T>(fn: (kv: Kv) => Promise<T>): Promise<T> => {
    const ctx = currentContextOrThrow();
    return fn(createGuueyState({ context: ctx }));
  };
  return {
    get: (key) => withBinding((kv) => kv.get(key)),
    set: (key, value, opts) => withBinding((kv) => kv.set(key, value, opts)),
    delete: (key) => withBinding((kv) => kv.delete(key)),
    has: (key) => withBinding((kv) => kv.has(key)),
    keys: (opts) => withBinding((kv) => kv.keys(opts)),
    increment: (key, opts) => withBinding((kv) => kv.increment(key, opts)),
    decrement: (key, opts) => withBinding((kv) => kv.decrement(key, opts)),
    mget: (keys) => withBinding((kv) => kv.mget(keys)),
    scope: () => withBinding((kv) => kv.scope()),
  };
}

function currentContextOrThrow(): ScopeContext {
  const ctx = getCurrentContext();
  if (!ctx) throw new MissingContextError();
  return ctx;
}
