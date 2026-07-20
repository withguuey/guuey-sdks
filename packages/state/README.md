# `@guuey/state`

> Open-source KV client for MCP servers hosted on
> [guuey.com](https://guuey.com). Scoped per `(user, mcp)`.
> The MCP stays stateless from its own POV; the user retains
> data ownership.

## Install

```sh
npm install @guuey/state
# or
pnpm add @guuey/state
```

## When to reach for this

You're building an MCP server hosted on guuey, and you need a small
amount of per-user state — idempotency tokens, rate-limit counters,
OAuth `state` nonces, user preferences a few KB in size.

You should **not** reach for `@guuey/state` if you need:

- More than ~1 MB of data per user (per MCP).
- Queries / joins / indexes — KV only.
- Cross-user shared data — scopes are strict per `(user, mcp)`.
- Long-lived data (max TTL is 90 days; longer-lived data should
  live in the user's own SaaS via mcp-proxy credential brokering).

Those cases are explicitly out of scope. The hard caps are the
product — see [guuey MCP Hosting Policy](https://github.com/loqu-co/guuey/blob/main/docs/principles/mcp-hosting-policy.md)
for the full rationale.

## Quick start

### Explicit context (tests, scripts)

```ts
import { createGuueyState } from "@guuey/state";

const kv = createGuueyState({
  context: { userId: "u_abc", mcpId: "mcp_xyz" },
});

await kv.set("user-prefs", { theme: "dark" }, { ttl: 60 * 60 * 24 * 7 });
const prefs = await kv.get<{ theme: string }>("user-prefs");
```

### Implicit context (production MCP servers)

In production, guuey-hosted MCP pods install a middleware that
sets the `(userId, mcpId)` context per incoming request from the
`X-Guuey-User-Id` / `X-Guuey-Mcp-Id` headers. Inside tool handlers
you just import the barrel-exported `kv`:

```ts
import { kv } from "@guuey/state";

// Inside an MCP tool handler — middleware has bound the context.
async function handleAddTask(input: { title: string }) {
  const seenKey = `idempotency:${hash(input.title)}`;
  if (await kv.has(seenKey)) {
    return { duplicate: true };
  }
  await kv.set(seenKey, true, { ttl: 60 });
  // ... create the task
  return { duplicate: false };
}
```

If you call `kv.*` outside a context, you get a clear
`MissingContextError` instead of silently writing to a fallback
scope.

## API

| Method                         | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `get<T>(key)`                  | Read. Returns `undefined` if absent or expired.              |
| `set(key, value, { ttl })`     | Write. TTL required (no permanent keys).                     |
| `delete(key)`                  | Delete (no-op if absent).                                    |
| `has(key)`                     | Existence check.                                             |
| `keys({ prefix?, limit? })`    | List keys (cap 1000 per call).                               |
| `increment(key, { ttl, by? })` | Atomic counter (creates key if absent).                      |
| `decrement(key, { ttl, by? })` | Inverse of `increment`.                                      |
| `mget(keys[])`                 | Bulk read.                                                   |
| `scope()`                      | Live usage snapshot (`usedBytes`, `limitBytes`, `keyCount`). |

## Limits (== the product)

| Cap                | Value                | Why                                                |
| ------------------ | -------------------- | -------------------------------------------------- |
| Scope size         | 1 MiB                | Forces opting into a real DB beyond this.          |
| Single value       | 64 KiB               | Large blobs → `@guuey/files` (planned).            |
| Key length         | 1 KiB                | Keeps keys cheap to log + index.                   |
| Key character set  | `[A-Za-z0-9_.:\-/]+` | Same set CloudWatch/Datadog use.                   |
| TTL max            | 90 days              | Longer-lived data → user-owned SaaS via mcp-proxy. |
| `keys()` page size | 1000                 | Diagnostics tool, not a query engine.              |

If you outgrow any of these, you're having a **Case-B moment** (per
the hosting policy) — build a real backend on a real cloud and treat
that backend as your MCP's "well-defined API."

## Local development

The library currently ships **one binding: in-memory**. It emits a
one-time `console.warn` on first use; data is per-process and lost on
restart. That's exactly right for tests and `guuey dev` runs — and it
is also the honest current ceiling in production (see Status below).

Setting `GUUEY_KV_URL` (or `options.bindingUrl`) **throws
`TransportError` today**: the hosted HTTP binding doesn't exist yet,
and silently handing back a non-durable store to a caller who asked
for the hosted one would be worse than failing loud.

## Errors

Every operation that can fail throws a subclass of
`GuueyStateError`. Use `instanceof` to discriminate:

```ts
import { kv, QuotaExceededError, InvalidKeyError } from "@guuey/state";

try {
  await kv.set("big-blob", huge, { ttl: 3600 });
} catch (err) {
  if (err instanceof QuotaExceededError) {
    // Scope hit its 1 MiB ceiling. Tell the user.
  } else if (err instanceof InvalidKeyError) {
    // Bug in the calling code.
  } else {
    throw err;
  }
}
```

Codes: `QUOTA_EXCEEDED`, `VALUE_TOO_LARGE`, `INVALID_KEY`,
`INVALID_TTL`, `MISSING_CONTEXT`, `TRANSPORT`.

## What this library is NOT

- **Not a database.** No queries, joins, transactions across keys,
  or secondary indexes.
- **Not durable beyond 90 days.** Longer-lived storage is the user's
  own SaaS via mcp-proxy.
- **Not cross-MCP.** Two MCPs cannot share data via `@guuey/state`
  even for the same user — by design.
- **Not for storing the agent's chat history** — that's portal's
  job via `@guuey-private/chat-managed-amplify` + AppSync.

## Status

🧪 **Developer preview (`0.x`).** The API surface, error shapes, and
hard caps are **locked and enforced** — code written against this
package today keeps working unchanged when the hosted binding ships.
What exists vs. what's coming:

| Piece                                       | Status                               |
| ------------------------------------------- | ------------------------------------ |
| `Kv` API, typed errors, context middleware  | ✅ locked + tested                   |
| Cap enforcement (scope/value/TTL/key rules) | ✅ enforced in every binding         |
| In-memory binding (dev, tests)              | ✅ shipped                           |
| Hosted binding (durable, cross-pod)         | 🔜 lands with guuey-hosted MCP state |
| Console export + delete (data ownership)    | 🔜 ships with the hosted binding     |

Until the hosted binding lands, state is per-pod and non-durable in
every environment — design your MCP so that losing this state is an
inconvenience (re-auth, cache miss), never data loss.
