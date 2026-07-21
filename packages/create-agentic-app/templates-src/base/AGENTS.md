# AGENTS.md — steering for the coding agent working in this repo

You (the coding agent) are extending a guuey agentic app. Before you reach
for a database or a cache, read this file. The single most common mistake
here is standing up local Redis/SQLite/file-based state "just to get
something working" — **don't.** Every pod this project deploys to
(`src/worker.ts`'s agent pod — including every `kind: colocated` `mcps/*`
server auto-spawned inside it, like this scaffold's `mcps/todo` — and every
`mcps/*` server deployed with `kind: hosted`) is **ephemeral and horizontally
replaced**: gVisor-isolated,
scale-to-zero, ordinary process death on every deploy or idle timeout. A
local file or an in-process `Map` used as a database is not a shortcut —
it is silent data loss the first time the pod recycles.

Use this table to route persistence decisions. Pick a row, don't invent one.

| Need                                                                                                         | Use                                                                                                                                                                                                                                                                                                                                                                    | Why                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Small per-user state on an MCP server (idempotency keys, rate-limit counters, OAuth nonces, prefs, a few KB) | [`@guuey/state`](https://www.npmjs.com/package/@guuey/state) — `withGuueyContext(scopeFromAuthorization(...), fn)`                                                                                                                                                                                                                                                     | Zero auth code — guuey owns the identity rails. Durable, per-`(user, mcp)`, survives pod restarts.                                                                                                                                                                                                                                      |
| Large or relational data (rows, queries, joins, anything you'd reach for Postgres/Redis for)                 | An external managed serverless DB — Neon, Upstash, Supabase, or Turso — wired in via `guuey mcp secrets set DATABASE_URL=... --server <id>` (hosted MCP) or `guuey env set DATABASE_URL=...` (the agent worker and its colocated MCP children — the pod's declared env/secrets are handed to every colocated child), consumed through the provider's serverless driver | Guuey **integrates, never operates** databases — that's the platform's hosting policy, not a v1 gap. Pick the provider's **`us-east-1`** region: a guuey-hosted MCP → provider hop is then same-region AWS backbone, single-digit-ms — comparable to a cross-AZ hop, and agent turns are already dominated by seconds of LLM inference. |
| Local Redis, SQLite, or any file written as a database                                                       | **Never.** Not for v1, not "temporarily."                                                                                                                                                                                                                                                                                                                              | Pods are ephemeral and horizontally replaced — a local store vanishes on the next deploy, restart, or scale event, with no warning to you or the user.                                                                                                                                                                                  |
| Per-user files/blobs from **inside the agent pod** (`src/worker.ts`)                                         | [`@guuey/fs`](https://www.npmjs.com/package/@guuey/fs)'s `homeDir()`/`appDir()`/`sessionDir()`, or the raw `$GUUEY_HOME_DIR`/`$GUUEY_APP_DIR` env vars + `node:fs`                                                                                                                                                                                                     | Every invoke already gets these three bound directories — `$GUUEY_HOME_DIR` is durable per-user, `$GUUEY_APP_DIR` is read-only shared, cwd is session scratch. No wrapper API required, but the helpers save you the env-var lookups.                                                                                                   |
| Per-user files/blobs from **inside an MCP server** (`mcps/*`)                                                | Not yet available — `@guuey/files` is planned but not shipped. Fall back to the managed-DB row above (e.g. store blobs in the provider's object storage) until it lands.                                                                                                                                                                                               | Don't build against an API that doesn't exist yet.                                                                                                                                                                                                                                                                                      |
| Conversation / chat history                                                                                  | **Do not re-implement.** The platform already persists it.                                                                                                                                                                                                                                                                                                             | Guuey writes thread history to DynamoDB and streams it back over AppSync; agents that keep their own transcript store are duplicating (and diverging from) data the platform already owns.                                                                                                                                              |

## `@guuey/state`: the one-line pattern

`@guuey/state` only works inside an MCP server whose `guuey.json` entry is
**federated** — that's the opt-in. A `kind: colocated` entry (like
`mcps/todo` in this scaffold) or a `kind: hosted` entry is federated
automatically. If you add a `kind: external` entry (a server you host
yourself, reached by URL), you must set `federate: true` on it:

```json
{
  "kind": "external",
  "url": "https://your-server.example.com",
  "federate": true
}
```

Without `federate: true` (or `kind: colocated`/`kind: hosted`/a `ggui`
URL), guuey has no
identity to hand your server — a plain external entry with static
`headers` gets **no token and no state.** The token guuey sends on every
request to a federated server IS the credential; there is no separate
API key to provision.

Inside a federated MCP server, wrap each request in
`withGuueyContext(scopeFromAuthorization(header), fn)` and use the
barrel-exported `kv` inside `fn` — that's the whole integration. One
complete, runnable example — an idempotency-key check on a tool call,
using the raw Node `http` transport this scaffold's `mcps/todo/src/server.ts`
already uses:

```ts
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { withGuueyContext, scopeFromAuthorization, kv, QuotaExceededError } from "@guuey/state";

// Inside the per-request handler (see mcps/todo/src/server.ts for the
// full StreamableHTTPServerTransport wiring this drops into):
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string") {
    res.writeHead(401).end();
    return;
  }

  await withGuueyContext(scopeFromAuthorization(authHeader), async () => {
    // ... hand off to your MCP transport/tool dispatch here; the
    // AsyncLocalStorage context set above is visible to every `kv.*`
    // call for the lifetime of this request, however deep the call
    // stack goes (tool handlers, helper functions, etc.).
    await handleCreateOrder({ orderPayload: "..." });
  });
}

async function handleCreateOrder(input: { orderPayload: string }): Promise<{ duplicate: boolean }> {
  const idempotencyKey = `order:${createHash("sha256").update(input.orderPayload).digest("hex")}`;

  if (await kv.has(idempotencyKey)) {
    return { duplicate: true };
  }

  try {
    // TTL is required on every `set` — no permanent keys. Pick a window
    // that covers realistic retry storms; 1 hour is a reasonable default
    // for an idempotency key.
    await kv.set(idempotencyKey, true, { ttl: 60 * 60 });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      // The (user, mcp) scope hit its 1 MiB cap. Surface this to the
      // caller instead of silently dropping the idempotency guard.
      throw new Error("state quota exceeded — cannot verify idempotency");
    }
    throw err;
  }

  // ... actually create the order here.
  return { duplicate: false };
}
```

`scopeFromAuthorization` derives `{ userId, mcpId }` from the inbound
`Authorization: Bearer <jwt>` header guuey sends on every federated call —
`userId` from the JWT's `sub`, `mcpId` deterministically from its `aud`
(your server's federated resource URL). You never assert either id
yourself; a mismatched or missing token is rejected server-side.

## The hard caps (design your data model around these, don't work around them)

`@guuey/state` is a KV, not a database — enforced, not a suggestion:

| Cap                | Value                                         |
| ------------------ | --------------------------------------------- |
| Scope size         | 1 MiB (per `(user, mcp)`, key bytes included) |
| Single value       | 64 KiB                                        |
| TTL                | required, ≤ 90 days — no permanent keys       |
| `keys()` page size | ≤ 1000                                        |
| `mget()` batch     | ≤ 100 keys                                    |
| Counters           | safe integers only (`increment`/`decrement`)  |

If your data model needs more than this — queries, joins, cross-user
data, anything past a long tail of small per-user facts — that's the
signal to use the managed-DB row above, not to fight the cap.

## Chat history: really, don't

If you find yourself writing message transcripts to `@guuey/state`,
`$GUUEY_HOME_DIR`, or an external DB keyed by conversation, stop — that's
the platform's job. Guuey persists every thread to DynamoDB and streams
history back over AppSync subscriptions; the client and Portal already
read it from there. A parallel, agent-owned history store will drift from
the platform's copy and confuse users about which one is authoritative.
