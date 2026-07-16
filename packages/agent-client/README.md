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

## Two entry points

| Import                      | Contents                                                                           | React? |
| --------------------------- | ---------------------------------------------------------------------------------- | ------ |
| `@guuey/agent-client`       | SSE helpers, the thread-history reader, `createWebAdapters`, and all public types. | No     |
| `@guuey/agent-client/react` | The `useAgentInvoke` hook (+ `applyHistoryResult`).                                | Yes    |

The root subpath is React-free — importing it never pulls React in. React is a
**required peer** (`react >=18`) because the `./react` subpath needs it; if you
only consume the root subpath, that peer is inert at runtime.

## React example

```tsx
import { useAgentInvoke } from "@guuey/agent-client/react";
import { createWebAdapters } from "@guuey/agent-client";

export function Chat({ endpointUrl, appId }: { endpointUrl: string; appId: string }) {
  const adapters = createWebAdapters({ getAccessToken: async () => myToken });
  const { messages, send, isStreaming } = useAgentInvoke({ endpointUrl, appId, adapters });

  return (
    <>
      {messages.map((m, i) => (
        <p key={i} data-role={m.role}>
          {m.text}
        </p>
      ))}
      <button disabled={isStreaming} onClick={() => send("hello")}>
        Send
      </button>
    </>
  );
}
```

On React Native, supply your own adapters (AsyncStorage + an `expo/fetch`
transport) in place of `createWebAdapters` — the hook's contract is identical.

## React Native / Metro

Both entry points declare a `react-native` export condition that points at the
**TypeScript source** (shipped in the npm tarball alongside `dist/` for exactly
this reason — the standard RN package pattern). Metro resolves that condition
by default and transpiles the source with your app's Babel config; Node and
web bundlers ignore it and use the compiled ESM in `dist/`. No
`transpilePackages`-style configuration is needed on either side.
