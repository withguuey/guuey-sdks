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
  hosted runtime binds DynamoDB; implement the port against your own store
  for ejected deployments.
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
