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

The root subpath is React-free — importing it never pulls React in. React is a
**required peer** (`react >=18`) because the `./react` subpath needs it; if you
only consume the root subpath, that peer is inert at runtime.

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
      {status === "connecting" && <p>Waking your agent…</p>}
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
`POD_SATURATED` refusals by itself, never after the first streamed byte;
tune or disable via its `coldStartRetry` option.

## React Native / Metro

Both entry points declare a `react-native` export condition that points at the
**TypeScript source** (shipped in the npm tarball alongside `dist/` for exactly
this reason — the standard RN package pattern). Metro resolves that condition
by default and transpiles the source with your app's Babel config; Node and
web bundlers ignore it and use the compiled ESM in `dist/`. No
`transpilePackages`-style configuration is needed on either side.
