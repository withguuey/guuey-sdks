# Your Google-ADK agent on Guuey

You write **pure [Google ADK](https://google.github.io/adk-docs/) code** —
`src/agent.ts` exports your agent, and Guuey runs it. There is no Guuey SDK
to learn, no worker loop, no event plumbing: the platform injects the
harness around your export, locally (`pnpm dev`) and in production
(`guuey deploy`) identically.

```ts
import type { GuueyContext } from "@guuey/config";

export default (guuey: GuueyContext<MCPToolset>) =>
  new LlmAgent({
    model: guuey.model,
    instruction: guuey.instruction,
    tools: [myTool, ...guuey.mcpToolsets],
  });
```

## Quick start

```bash
pnpm install
cp .env.example .env.local      # set GEMINI_API_KEY
pnpm dev                        # local stack: your agent + the todo MCP + chat
guuey deploy                    # same code, hosted
```

## The GuueyContext (everything the platform hands you)

Your factory runs **once per turn** and receives:

| field                                 | what it is                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                               | resolved model id (from `guuey.json`, registry default otherwise)                                                                                 |
| `instruction`                         | your system prompt **with the conversation preamble already prepended** — feed it to the agent and it is conversational with zero state code      |
| `mcpToolsets`                         | ready-to-use ADK `MCPToolset`s for every server in `guuey.json#mcpServers` — credentials, URLs, and auth headers already resolved by the platform |
| `user`                                | the end user this turn serves: `{ id, authMode }` — build multi-tenant behavior on `user.id`                                                      |
| `files`                               | three storage tiers (absolute paths — see the state map below)                                                                                    |
| `history` / `memory` / `workingState` | the raw conversation state, if you want to render context yourself instead of using `instruction`                                                 |

## Where state lives (the three-tier map)

| you want to…                                                     | use                                                                                                                            | persistence                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| save/read **files** from agent code or tools                     | `guuey.files.home` (per-USER durable) · `guuey.files.session` (per-session scratch) · `guuey.files.app` (read-only app assets) | `home` survives across sessions per user       |
| have the agent **remember the conversation**                     | nothing — `instruction` already carries history + thread memory + working state                                                | automatic (Guuey folds every turn)             |
| store data from your **MCP server's tools** (e.g. the todo list) | `@guuey/state` KV inside the MCP server — scoped per `(user, server)`                                                          | managed by Guuey; export/delete in the console |

Two honest notes:

- **ADK-native session state does not persist across turns here.** Guuey
  runs your agent with a fresh `InMemoryRunner` per turn (that's what makes
  turns cheap and stateless); `session.state` / `outputKey` /
  `DatabaseSessionService` won't carry data forward. Use the table above —
  history and thread memory ARE the persistence, and they arrive
  pre-rendered in `instruction`.
- **Writing `workingState` for the next turn** is a platform feature in
  flight; today the fold carries what the conversation itself establishes.

## MCP servers

`guuey.json#mcpServers` declares them; the platform connects them and hands
you `guuey.mcpToolsets`. Locally, `pnpm dev` boots the colocated `mcps/todo`
server on its `devPort`. Note: ADK speaks **Streamable HTTP** only — an
`sse` transport server will be rejected with a clear error.

## When you outgrow the factory

If you need to own the turn loop itself (custom streaming, multiple agents
per turn, your own protocol), graduate to a full worker: add a
`guuey.worker.js` build via `@guuey/worker`'s `serveNative()` — see the
Guuey docs. `agent.entry` and a full worker are mutually exclusive; the
worker wins if both exist.
