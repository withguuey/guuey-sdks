# @guuey/agent-client

The client SDK for a [guuey](https://guuey.com) agent's streaming contract:

- **`POST /agent/invoke`** — a Server-Sent-Events stream (`session` / `message`
  / `done` / `error` frames) folded into a flat transcript.
- **`GET /threads/:id/messages`** — the paginated history read plane, so a
  reload repaints the conversation before any new streaming starts.

The hook is platform-agnostic: thread-id storage, client-message-id
generation, and the network transport (which also carries identity) are
injected as adapters, so the same core runs on web (Next.js) and React Native.

```bash
npm install @guuey/agent-client
```

## Three entry points

| Import                          | Contents                                                                                             | React? |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| `@guuey/agent-client`           | SSE helpers, `invokeTurn`, the thread-history reader, `createWebAdapters`, and all public types.     | No     |
| `@guuey/agent-client/react`     | The `useAgentInvoke` hook (+ `applyHistoryResult`).                                                  | Yes    |
| `@guuey/agent-client/transport` | Only the invoke transport + guest-identity pieces — zero `@guuey/mcp-apps-host` in the import graph. | No     |

The root subpath is React-free — importing it never pulls React in. React
(`react >=18`) is an **optional peer**: only the `./react` subpath needs it, so
npm does not install it for you. If you import `@guuey/agent-client/react`, add
`react` to your own dependencies.

## React example

```tsx
import { useAgentInvoke } from "@guuey/agent-client/react";
import { createWebAdapters } from "@guuey/agent-client";

export function Chat({ endpointUrl, appId }: { endpointUrl: string; appId: string }) {
  const adapters = createWebAdapters({ getAccessToken: async () => myToken });
  const { messages, send, status, activeTool, error } = useAgentInvoke({
    endpointUrl,
    appId,
    adapters,
  });

  return (
    <>
      {messages.map((m, i) => (
        <p key={i} data-role={m.role}>
          {m.text}
        </p>
      ))}
      {status === "connecting" && <p>Waking up…</p>}
      {status === "using-tool" && <p>Using {activeTool}…</p>}
      {error && <p role="alert">{error}</p>}
      <button disabled={status !== "ready"} onClick={() => send("hello")}>
        Send
      </button>
    </>
  );
}
```

`status` walks the turn lifecycle — `ready` → `connecting` → `thinking` /
`using-tool` (with `activeTool` naming the tool) / `responding` → back to
`ready`. Failures never occupy `status`; they land in `error` and the
composer re-enables. The full vocabulary is documented at
[docs.guuey.com/sdk](https://docs.guuey.com/sdk).

On React Native, supply your own adapters (AsyncStorage + an `expo/fetch`
transport) in place of `createWebAdapters` — the hook's contract is identical.

## Sending more than words

`send(text, options)` carries two more things a turn can hold. The hook checks
both before sending: a turn past the limits is refused by name in `errorCode`,
and nothing is sent.

**Parts** are what the person attaches: images, audio, files and documents.

```tsx
await send("What's in this picture?", {
  parts: [{ type: "image", source: { type: "base64", mediaType: "image/png", data } }],
});
```

- A part is `{ type, source }`. `type` is `image`, `audio`, `file` or
  `document`. `source` is the bytes inline (`{ type: "base64", mediaType, data }`)
  or a link the agent's runtime fetches once (`{ type: "url", url }`, `https`
  only).
- Which kinds an agent takes is its runtime's word. `acceptedPartKinds` lists
  them once a turn has run (a hint for your picker). A turn whose parts the
  runtime does not acknowledge ends with `PARTS_UNSUPPORTED` before any reply.
- Limits per turn: at most 16 parts, 4 images and 1 audio part; each part at
  most 5,000,000 base64 characters, and all inline parts together at most
  6,000,000. Past them, the send is refused with `PARTS_INVALID`.
  `validateUserParts` runs the same check, for a picker.

**Turn context** is text your page adds beside the person's words: what the
page knows that they did not type.

```tsx
await send("Which plan am I on?", {
  turnContext: [{ type: "text", text: "The visitor is on the Pro plan." }],
});
```

- It is untrusted per-turn context. Anyone who controls the page can write
  it, so the agent is told to treat it as untrusted.
- At most 32 text blocks and 16,384 bytes (UTF-8, over the serialized list).
  Past them, the send is refused with `TURN_CONTEXT_INVALID`.
  `validateTurnContext` runs the same check.
- `turnContextDelivered` says whether the agent received it on the last turn.
  It is `false` when the agent's runtime ignored it or predates turn context
  (the turn still goes on, and the hook logs a warning), and `null` when the
  turn carried no context.

**Upgrading from 0.37.** `SendOptions.attachments` (images only) is removed.
Pass the same images as `parts`: `{ kind: "inline", mimeType, data }` becomes
`{ type: "image", source: { type: "base64", mediaType, data } }`, and
`{ kind: "url", url }` becomes `{ type: "image", source: { type: "url", url } }`.
A call that still passes `attachments` no longer compiles.

**Older runtimes.** The hook sends the newer request shape and, when an older
runtime refuses it, falls back once to the older shape. Text and images still
go. A part the older shape cannot carry (audio, a file or a document) is
refused by name rather than sent without it.

## Driving a turn without React

`invokeTurn` is the same wire walk as the hook, as a pure async generator —
for a Node harness, a game loop, or any host with its own turn state machine.
Its event stream is also the observation channel: tool results arrive as
typed `tool.done` AgEvents, so telemetry is a filter, not a callback API.

```ts
import { invokeTurn, toInvokeUrl, fetchStreamTransport } from "@guuey/agent-client";

const req = {
  url: toInvokeUrl(endpointUrl),
  body: { input, clientMessageId: crypto.randomUUID() },
  signal: controller.signal,
};
// `getBearer` is resolved per attempt — a retry re-reads a fresh token.
const transport = (r) => fetchStreamTransport(r, null, null, { getBearer });

for await (const ev of invokeTurn(req, transport)) {
  if (ev.kind !== "message") continue;
  for (const agEvent of ev.agEvents) {
    if (agEvent.type === "tool.done") {
      telemetry.record(agEvent.toolCallId, agEvent.outcome ?? "ok");
    }
  }
  render(ev.assistantText); // full folded text — no delta bookkeeping
}
```

The transport retries cold-start 503s (the post-redeploy window) and
capacity refusals (`POD_SATURATED`, `WORKER_POD_RESOURCE_EXHAUSTED`) by itself,
never after the first streamed byte;
tune or disable via its `coldStartRetry` option.

## React Native / Metro

Every entry point resolves to the compiled ESM in `dist/`, for Metro as for
Node and web bundlers. A stock Expo or React Native Metro config bundles it:
no custom resolver and no `transpilePackages`-style configuration is needed.

## Support

Questions and help: the guuey community on Discord — https://guuey.com/discord.
Bugs and feature requests: https://github.com/withguuey/guuey-sdks/issues.
