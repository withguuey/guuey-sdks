# @guuey/create-agentic-app

Scaffold a deployable AI agent for [guuey](https://guuey.com) — agent code,
MCP servers, and generative UI, in one workspace.

```
npx @guuey/create-agentic-app my-agent
cd my-agent
pnpm install
pnpm bootstrap      # brand, theme, copy → guuey.app.json + AGENTS.md (local, no account)
pnpm dev            # local: your agent + MCP servers + the web app, hot reload
guuey login
guuey deploy        # hosted: agent + MCP servers live on guuey
pnpm bootstrap -- --link   # bind the deployed app into the frontend
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
npx @guuey/create-agentic-app <dir> [--template base|agentic-app] [--framework claude-agent-sdk|openai-agents-sdk|google-adk] [--install]
```

- `--template base` (default) — a three-page app: landing (with the guuey
  widget), login (guest + BYO-OIDC seam), home (live status + the
  three-ways distribution guide), plus an embedded-chat page on
  [`@guuey/chat`](https://www.npmjs.com/package/@guuey/chat).
- `--template agentic-app` — everything in base, plus a split-sidebar
  product shell: upper sidebar = your menus, lower sidebar = the agent
  dock; activating the dock swaps the main canvas to a fullscreen agent
  (generative-UI cards get the whole width), and "Talk on mobile" shows a
  QR to the same agent in the guuey portal.
- `--install` — run `pnpm install` after scaffolding (off by default).
- `--example <vertical>` — instead of a blank template, extract one of the
  open-source demo apps from
  [`withguuey/demos`](https://github.com/withguuey/demos) (e.g.
  `--example trimly`) — the exact app behind the live demo, already wired
  end to end. Re-brand it with `pnpm bootstrap` (which also turns the demo
  chrome off). Mutually exclusive with `--template`/`--framework`. Manual
  alternative: `npx degit withguuey/demos/<vertical>`.

## Binding to an existing app

`guuey deploy` (above) creates a new app on first run. To bind this
scaffold to an app you already have — including a no-code agent built in
[Studio](https://studio.guuey.com) — run `guuey pull --app-id <id>` instead: it
refreshes `guuey.json`'s `appId`, and for a Studio no-code app pulls the
Studio-authored system prompt/model/MCP servers down into the scaffold too.
There is no `guuey link` command — `guuey pull --app-id` is the only way
to bind a project to an existing app.
