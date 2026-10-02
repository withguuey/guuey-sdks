# @guuey/threads

Universal session/thread persistence for AgJSON agents.

Hosted guuey agents get thread rehydration ("my agent remembers this
conversation") from the platform. This package is that same session model as
a public contract, so ejected and self-hosted agents — and integration
harnesses — share it:

- **`ThreadStore`** — the storage-agnostic logic: thread resolution and
  ownership, atomic gap-free sequencing, `clientMessageId` idempotency,
  turn-level fold persistence (messages + generative-UI card rows + the
  latest-replace snapshot), and the prompt-lane history projection.
- **`ThreadPersistencePort`** — the narrow surface a binding implements.
  `InMemoryThreadPersistence` ships in the box (dev, tests, CI); guuey's
  hosted runtime binds DynamoDB; `HttpThreadPersistence` points a
  self-hosted agent at guuey's hosted thread API ("eject the code, keep your
  memory"); or implement the port against your own store.
- **fold ↔ row mapping** — `agMessageToRow`, `reassembleFold`,
  `uiCardArtifactsFromMessages` and friends: byte-identity persistence of an
  `@silverprotocol/core` `AgReduceResult`, including the projection that
  persists MCP-App cards carried on tool-result blocks.
- **`@guuey/threads/testing`** — the port contract suite. Run it against
  your binding and "works in-memory" and "works on the real thing" mean the
  same set of guarantees.

```ts
import { InMemoryThreadPersistence, ThreadStore } from "@guuey/threads";

const store = new ThreadStore(new InMemoryThreadPersistence());
const threadId = await store.ensureThread({
  userId: "g_dev",
  appId: "my-agent",
  region: "local",
});
await store.appendMessage({
  threadId,
  userId: "g_dev",
  role: "user",
  content: "hello",
  text: "hello",
  clientMessageId: "m1",
});
const history = await store.loadHistory(threadId);
```

```ts
// your-binding.test.ts
import { runThreadPersistenceContractSuite } from "@guuey/threads/testing";
runThreadPersistenceContractSuite("MyBinding", async () => ({ port: makeMyPort() }));
```

## Hosted binding — keep your memory after ejecting

`HttpThreadPersistence` implements the same port over guuey's thread API, so
an agent you run yourself reads and writes the SAME conversation rows the
hosted runtime does. It is scoped to one app and one end-user: pass the
end-user's bearer token — one your app's configured identity issuer minted
(your own IdP, or guuey's per-app widget issuer via `@guuey/widget-auth`).
The server verifies it against that issuer, derives the same end-user id the
hosted runtime uses, and confines every op to `(app, user)`.

```ts
import { HttpThreadPersistence, ThreadStore } from "@guuey/threads";

const appId = process.env.GUUEY_APP_ID!;
const port = new HttpThreadPersistence({
  baseUrl: "https://api.us-east-1.guuey.com",
  appId,
  token: endUserToken, // per request — the end-user's own token
});
const { userId, region } = await port.scope(); // what the token resolves to
const store = new ThreadStore(port);
const threadId = await store.ensureThread({ threadId: clientThreadId, userId, appId, region });
```

Requires the app to run identified end-users (`userAuthMode: "byo"`); guests
and Cognito sessions are served on-platform only. Errors surface as
`HttpThreadStoreError` (`status`, `code`). Reads retry once on a network
failure or 5xx; writes never do.

## Row size limits

A store with an item-size limit declares it as the port's optional
`rowBudget` (`{ maxBytes, bytesOf(row), numberFits?(n) }`). The DynamoDB-backed
bindings, `HttpThreadPersistence` included, declare `DYNAMODB_ROW_BUDGET`:
380,000 bytes measured by `dynamoItemBytes`, an upper bound under DynamoDB's
own item-size rules, and `dynamoNumberFits`, which refuses a number DynamoDB
cannot hold as written (outside the safe-integer range, NaN or an infinity, or
a non-zero magnitude below 1e-130). A port without a budget stores rows exactly
as mapped.

`appendFold` checks every row of a turn against the budget before it writes any:

- A tool-call value is stored as a marker in its place,
  `{ "com.guuey/elided": { "bytes": <UTF-8 length of its JSON> } }`, when it
  carries a number the store cannot hold (`reason: "number"`), and, for an
  oversized row, a `providerMetadata.wireInput` copy first, then `input`, the
  largest first, until the row fits (`reason: "size"`). The result lists each
  one in `elidedToolInputs`.
- A turn that still cannot be stored is never written in part. With
  `unstorableNotice: { text }` the turn is stored as ONE agent row carrying that
  text and `content.error.code` `"stored_turn_too_large"` or
  `"stored_turn_unstorable_number"` (`classifyStoredRow` reads either as a
  failure), and the result carries `unstorable`. Without it, `appendFold`
  throws `StoredRowTooLargeError` or `StoredRowUnstorableNumberError` and
  writes nothing.

`appendMessage` refuses such a row the same way before it allocates a seq.
`withItemSizeLimit(port)` from `@guuey/threads/testing` wraps any port to
declare the budget and refuse what DynamoDB would, for tests.

## Support

Questions and help: the guuey community on Discord — https://guuey.com/discord.
Bugs and feature requests: https://github.com/withguuey/guuey-sdks/issues.
