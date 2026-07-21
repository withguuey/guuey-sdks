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
product — per the guuey MCP Hosting Policy: most stateful MCPs only
need a tiny bit of state (idempotency tokens, rate-limit counters,
OAuth nonces, small preferences), and a scoped 1 MiB KV covers that
long tail without turning guuey into a backend-as-a-service.

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

🔜 When the hosted binding ships, guuey-hosted MCP pods will install
a middleware that sets the `(userId, mcpId)` context per incoming
request from platform-injected identity (see "Identity & trust
model" below). Today you install `withGuueyContext` yourself with
whatever identity your server derives. Inside tool handlers you
just import the barrel-exported `kv`:

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

## Hosted binding

The hosted binding is a fetch-based transport that talks to guuey's KV
API. It activates automatically when `GUUEY_KV_URL` (or
`options.bindingUrl`) is set — nothing else about your code changes,
because it implements the same `Kv` interface as the in-memory binding.

```sh
# .env / deploy env — bare origin, NO trailing /v1 or /v1/state.
# The client appends `/v1/state/<op>` itself.
GUUEY_KV_URL=https://api.dev.sandbox.guuey.com     # dev sandbox
# GUUEY_KV_URL=https://api.staging.sandbox.guuey.com  # staging sandbox
# GUUEY_KV_URL=https://api.us-east-1.guuey.com        # prod (region-qualified)
```

**`GUUEY_KV_URL` is injected automatically for guuey-hosted
(`kind: 'hosted'`) and colocated (`kind: 'colocated'`, agent-pod) MCP
servers** — no setup required, state just works. A **dev-hosted external**
server (your own `kind: 'external'` deployment reached over a real URL,
including federated ones) sets `GUUEY_KV_URL` itself (per-env values
above); omitting it silently falls back to the non-durable in-memory
binding rather than failing loud. The per-request auth token, in
contrast, you don't provision by hand: **only federated MCP servers get
one**, minted by the platform on every call. Set `federate: true` on an
`external` entry in `guuey.json` (or use `kind: 'hosted'`/`kind:
'colocated'`, or a `ggui` URL — those are federated automatically):

```json
{ "kind": "external", "url": "https://your-server.example.com", "federate": true }
```

Federation makes guuey mint a per-invoke Bearer JWT and send it as this
server's `Authorization` header on every call. That inbound token IS
the credential — a plain `external` entry with static `headers` gets no
token and can't use hosted state. Derive the `ScopeContext` from it with
`scopeFromAuthorization` and bind it per request:

```ts
import { withGuueyContext, scopeFromAuthorization, kv } from "@guuey/state";

// Middleware / per-request handler — `req.headers.authorization` is the
// Bearer JWT guuey sent this (federated) server.
async function handler(req: { headers: { authorization?: string } }) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string") throw new Error("missing Authorization header");

  return withGuueyContext(scopeFromAuthorization(authHeader), async () => {
    // kv.* inside here is scoped to this request's (userId, mcpId).
    await kv.set("last-seen", Date.now(), { ttl: 60 * 60 * 24 });
  });
}
```

`scopeFromAuthorization` decodes the JWT client-side (unverified — the
KV API is the verifier) into `{ userId, mcpId, token }`; the returned
`token` is what `createGuueyState`/the ALS-bound `kv` uses to
authenticate the hosted binding's requests, so you never touch
`GUUEY_KV_TOKEN` yourself in this path. `mcpId` is derived from the
JWT's `aud` claim (the server's federated resource URL) — deterministic
and identical to the server-side derivation, so two agents pointing at
the same external MCP share that MCP's per-user state.

## API

| Method                               | Purpose                                                      |
| ------------------------------------ | ------------------------------------------------------------ |
| `get<T>(key)`                        | Read. Returns `undefined` if absent or expired.              |
| `set(key, value, { ttl })`           | Write. TTL required (no permanent keys).                     |
| `delete(key)`                        | Delete (no-op if absent).                                    |
| `has(key)`                           | Existence check.                                             |
| `keys({ prefix?, limit?, cursor? })` | List keys, paginated (`{ keys, cursor? }`, ≤1000/page).      |
| `increment(key, { ttl, by? })`       | Atomic counter (creates key if absent).                      |
| `decrement(key, { ttl, by? })`       | Inverse of `increment`.                                      |
| `mget(keys[])`                       | Bulk read.                                                   |
| `scope()`                            | Live usage snapshot (`usedBytes`, `limitBytes`, `keyCount`). |

## Limits (== the product)

| Cap                | Value                | Why                                                |
| ------------------ | -------------------- | -------------------------------------------------- |
| Scope size         | 1 MiB                | Forces opting into a real DB beyond this.          |
| Single value       | 64 KiB               | Large blobs → `@guuey/files` (planned).            |
| Key length         | 1 KiB                | Keeps keys cheap to log + index.                   |
| Key character set  | `[A-Za-z0-9_.:\-/]+` | Same set CloudWatch/Datadog use.                   |
| TTL max            | 90 days              | Longer-lived data → user-owned SaaS via mcp-proxy. |
| `keys()` page size | 1000                 | Diagnostics tool, not a query engine.              |
| `mget()` batch     | 100 keys             | Bulk convenience, not a table scan.                |
| Counters           | Safe integers only   | Rate limits + sequences; not float math.           |

Sizes are **UTF-8 bytes of the key plus its JSON-encoded value** —
keys are storage too, so a scope of long keys with tiny values
cannot dodge the cap. The same accounting applies in every binding,
so quota behavior is identical in tests and production.

Values must be JSON-serializable: top-level `undefined`, functions,
symbols, `BigInt`, and circular structures throw
`InvalidArgumentError`. Standard JSON semantics otherwise apply
(`NaN`/`Infinity` become `null`; nested `undefined` properties are
dropped) — if that matters for your data, validate before writing.

## Identity & trust model

Every operation is scoped by a `ScopeContext` (`userId`, `mcpId`).
Where those ids come from — and who is trusted to assert them —
is the access-control story:

- **Today (in-memory binding only):** the context is caller-asserted.
  That's fine because the store is process-local — your process owns
  all of its own data, and both ids are validated (non-empty, no
  whitespace/control characters, ≤256 chars) to fail wiring bugs
  loudly.
- **🔜 Hosted binding (planned contract):** `mcpId` is derived
  **server-side** from the pod's per-deploy credential
  (`GUUEY_KV_TOKEN`) — a compromised MCP server can never reach
  another MCP's scopes, by construction. `userId` comes from
  platform-injected per-request identity (guuey's ingress strips any
  inbound copy of the header and re-sets it from the verified caller
  token). Anonymous/guest callers get no durable scope at all —
  the same platform-layer exclusion guuey applies to durable file
  storage.
- **Blast radius:** within its own app an MCP server necessarily
  handles every one of its users' requests, so a compromised server
  can touch its own app's scopes — never another app's. Cross-MCP
  isolation is enforced by the storage layer, not by cooperation.
- **Data ownership:** per-user export + delete lands in the guuey
  console together with the hosted binding — end users can see and
  remove what an MCP stored about them.

If you outgrow any of these, you're having a **Case-B moment** (per
the hosting policy) — build a real backend on a real cloud and treat
that backend as your MCP's "well-defined API."

## Local development

The library currently ships **one binding: in-memory**. It emits a
one-time `console.warn` on first use; data is per-process and lost on
restart. That's exactly right for tests and `guuey dev` runs — and it
is also the honest current ceiling in production (see Status below).

Setting `GUUEY_KV_URL` (or `options.bindingUrl`) activates the hosted
HTTP binding — see "Hosted binding" above. It requires a token
(`authToken`/`GUUEY_KV_TOKEN`/`context.token`) or throws
`InvalidContextError` rather than silently handing back a non-durable
in-memory store to a caller who explicitly asked for the durable one.

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
`INVALID_TTL`, `INVALID_ARGUMENT`, `INVALID_CONTEXT`,
`TYPE_MISMATCH`, `MISSING_CONTEXT`, `TRANSPORT`.

## What this library is NOT

- **Not a database.** No queries, joins, transactions across keys,
  or secondary indexes.
- **Not durable beyond 90 days.** Longer-lived storage is the user's
  own SaaS via mcp-proxy.
- **Not cross-MCP.** Two MCPs cannot share data via `@guuey/state`
  even for the same user — by design.
- **Not for storing the agent's chat history** — the platform's
  managed conversation history already handles that.

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
