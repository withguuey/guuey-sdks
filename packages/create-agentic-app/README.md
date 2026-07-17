# @guuey/create-agentic-app

Scaffold a deployable AI agent for [guuey](https://guuey.com) — agent code,
MCP servers, and generative UI, in one workspace.

```
npx @guuey/create-agentic-app my-agent
cd my-agent
pnpm install
pnpm dev            # local: your agent + your MCP servers, hot reload
guuey login
guuey deploy        # hosted: agent + MCP servers live on guuey
```

## What you get

- **A code-mode agent worker** (Claude Agent SDK or OpenAI Agents SDK — pick
  with `--framework`) built on the open
  [`@guuey/worker`](https://www.npmjs.com/package/@guuey/worker) protocol.
  The same worker runs locally and on guuey's hosted runtime, sandboxed and
  scaled to zero when idle.
- **A hosted MCP server template** (`mcps/todo`) — your agent's tools, built
  and hosted by `guuey deploy` alongside the agent.
- **`guuey.json`** — the single config file describing the agent, its MCP
  servers, and its ggui generative-UI assets.

## Options

```
npx @guuey/create-agentic-app <dir> [--framework claude-agent-sdk|openai-agents-sdk] [--skip-install]
```

## Binding to an existing app

`guuey deploy` (above) creates a new app on first run. To bind this
scaffold to an app you already have — including a no-code agent built in
[Studio](https://guuey.com) — run `guuey pull --app-id <id>` instead: it
refreshes `guuey.json`'s `appId`, and for a Studio no-code app pulls the
Studio-authored system prompt/model/MCP servers down into the scaffold too.
There is no `guuey link` command — `guuey pull --app-id` is the only way
to bind a project to an existing app.
