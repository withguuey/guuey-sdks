/**
 * AsyncLocalStorage-based scope context.
 *
 * Two ways to feed a `ScopeContext` to the library:
 *
 * 1. **Explicit per-call** — pass `{ context }` to
 *    `createGuueyState`. Best for tests, scripts, and code that
 *    runs outside an HTTP request lifecycle.
 *
 * 2. **Implicit via AsyncLocalStorage** — wrap the request
 *    handler in `withGuueyContext` and use the barrel-exported
 *    `kv` (or call `getCurrentContext()` directly). This is
 *    what guuey-hosted MCP servers do: a middleware reads
 *    `X-Guuey-User-Id` + `X-Guuey-Mcp-Id` headers per request
 *    and calls `withGuueyContext(...)` for the handler body.
 *
 * Why AsyncLocalStorage and not a plain module-level variable:
 * concurrent requests on the same Node.js process can be in
 * different scopes simultaneously. ALS gives us per-async-chain
 * isolation.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { InvalidContextError } from "./errors.js";
import type { ScopeContext } from "./types.js";

const storage = new AsyncLocalStorage<ScopeContext>();

/**
 * Reject unusable scope ids at bind time. Scope ids are
 * platform-issued opaque identifiers (Cognito subs, app ids) —
 * whitespace or control characters in one is always a wiring bug,
 * and catching it here beats a scope-ambiguity bug in storage.
 * Shared by `withGuueyContext` and `createGuueyState` so both
 * entry points enforce the same contract.
 */
export function validateContext(context: ScopeContext): void {
  for (const field of ["userId", "mcpId"] as const) {
    const value = context[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new InvalidContextError(field, "must be a non-empty string");
    }
    if (/[\s\p{Cc}]/u.test(value)) {
      throw new InvalidContextError(
        field,
        "must not contain whitespace or control characters",
      );
    }
    if (value.length > 256) {
      throw new InvalidContextError(field, "must be <= 256 characters");
    }
  }
}

/**
 * Run `fn` with the given scope context bound to AsyncLocalStorage.
 * Nested calls override the outer context for their lifetime.
 *
 * The MCP server frameworks (express/fastify/hono middleware,
 * `@modelcontextprotocol/sdk` transports) call this once per
 * incoming request after extracting the user/mcp ids from headers
 * or the SDK's session context.
 */
export function withGuueyContext<T>(
  context: ScopeContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  // Validation failures surface as a rejected promise (matching the
  // return type), never a synchronous throw. `storage.run` itself must
  // stay synchronous — AsyncLocalStorage binds the context only for
  // the synchronous extent of `run`, and `fn` starts inside it.
  try {
    validateContext(context);
  } catch (err) {
    return Promise.reject(err);
  }
  return Promise.resolve(storage.run(context, fn));
}

/**
 * Current scope context, or `undefined` if none is bound. The
 * library's barrel-exported `kv` calls this on every operation
 * and throws `MissingContextError` when it returns `undefined`.
 */
export function getCurrentContext(): ScopeContext | undefined {
  return storage.getStore();
}
