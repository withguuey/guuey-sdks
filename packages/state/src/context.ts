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
import { createHash } from "node:crypto";
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

/**
 * Derive a ScopeContext from the Authorization header guuey sent this
 * MCP server. Decodes WITHOUT verifying — the KV API is the verifier;
 * this is DX so `withGuueyContext(scopeFromAuthorization(h), fn)` is
 * one line. mcpId = "mcp_" + first 32 hex of sha256(canonical aud URL),
 * identical to the server derivation (auth.ts — keep in sync).
 */
export function scopeFromAuthorization(header: string): ScopeContext {
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) throw new InvalidContextError("userId", "not a Bearer authorization header");
  const token = m[1] ?? "";
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) {
    throw new InvalidContextError("userId", "malformed JWT");
  }
  let payload: { sub?: string; aud?: string | string[] };
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      sub?: string;
      aud?: string | string[];
    };
  } catch {
    throw new InvalidContextError("userId", "JWT payload is not valid JSON");
  }
  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (typeof payload.sub !== "string" || payload.sub.length === 0)
    throw new InvalidContextError("userId", "JWT has no sub claim");
  if (typeof aud !== "string" || aud.length === 0)
    throw new InvalidContextError("mcpId", "JWT has no aud claim");
  return { userId: payload.sub, mcpId: mcpIdFromResourceUrl(aud), token };
}

/** Canonicalize + hash a resource URL into a scope-safe mcpId. */
export function mcpIdFromResourceUrl(url: string): string {
  const u = new URL(url);
  const canonical = `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  return `mcp_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}
