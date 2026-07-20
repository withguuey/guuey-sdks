# agentic-app-template

A guuey agentic app: a code-mode agent, a custom MCP server you can copy to
add your own tools, and a `ggui` config for generative UI — all runnable
locally with one command, and deployable to guuey with one more.

## What got scaffolded

```
.
├── guuey.json          # the deploy contract: agent framework/model, system prompt,
│                        #   mcpServers (name → local dev port / hosted source), ggui config
├── package.json         # agent deps + the pnpm workspace root (workspaces: mcps/*, web)
├── src/worker.ts        # your agent code (code-mode worker); build emits ./guuey.worker.js
├── prompts/system.md    # system prompt, referenced from guuey.json#agent.systemPrompt.file
├── mcps/todo/           # the "copy-me" custom MCP server — @modelcontextprotocol/sdk,
│                         #   Streamable HTTP, in-memory todo list, port :6782
├── ggui/                # ggui.json + blueprints/ + themes/ — generative-UI config.
│                         #   `ggui serve` runs against this locally; it's pushed to your
│                         #   deployed app's guuey-managed ggui instance on `guuey deploy`.
├── web/                 # a small Vite SPA chat client — the local dev surface, and a
│                         #   worked example of the bring-your-own-frontend path
├── scripts/dev.mjs      # `pnpm dev` orchestrator — boots the whole local stack
├── .env.example          # ANTHROPIC_API_KEY / OPENAI_API_KEY for local dev
└── .mcp.json             # Claude Code convenience wiring (mcp.ggui.ai/dev)
```

The project root **is** the agent package — `guuey deploy` packs this directory
directly as the deploy tarball, so `guuey.json` and `src/worker.ts` live at the top
level rather than nested under a `servers/` or `apps/` folder.

## Quick start

```bash
pnpm install
cp .env.example .env.local   # done automatically on scaffold if .env.local is absent
# set ANTHROPIC_API_KEY (or OPENAI_API_KEY, for the openai-agents-sdk template) in .env.local
pnpm dev
```

`pnpm dev` (`scripts/dev.mjs`) boots five processes with prefixed, interleaved
logs. Ctrl-C tears all of them down together.

| process      | port  | what                                                         |
| ------------ | ----- | ------------------------------------------------------------ |
| `worker`     | —     | `tsup --watch` — rebuilds `guuey.worker.js` on every save    |
| `guuey dev`  | :6790 | local router: spawns your worker per turn, streams SSE       |
| `mcps/todo`  | :6782 | the example MCP server (copy this directory to add your own) |
| `ggui serve` | :6781 | local generative-UI server, over `ggui/`                     |
| `web`        | :6890 | the Vite chat SPA                                            |

Open http://localhost:6890 to chat with your agent locally.

## Local dev vs. deployed — what's different

`guuey dev` is the open, local equivalent of the pod router that runs your
worker in production. It mirrors the real spawn/stream contract closely — the
same normalizer, the same SSE shape — but it deliberately cuts three corners
that only matter once real users and real money are involved:

- **No sandboxing.** Locally your worker runs as a plain child process — no
  `bwrap`/gVisor isolation. In production every invocation runs inside a
  gVisor-isolated pod.
- **Permissive auth.** `ggui serve --dev-allow-all` accepts any bearer
  locally. The deployed ggui instance enforces real auth.
- **No metering or history.** Local runs aren't billed and aren't persisted.
  Deployed conversations are metered and their history is written to
  DynamoDB so users can resume a thread.

None of this changes your code — `guuey.json` is the same file in both
worlds; only how it's resolved differs (`guuey dev` points MCP server names
at `localhost:<devPort>`, `guuey deploy` points them at the platform's
federated URLs).

## Deploying

```bash
guuey login    # device-flow auth; stores a token in ~/.guuey/auth.json
guuey deploy   # ships everything
```

`guuey deploy` runs four legs, in order, so a hard failure aborts before
anything user-visible changes:

1. **MCP leg** — deploys each `hosted` entry under `guuey.json#agent.mcpServers`
   (e.g. `mcps/todo`) as its own hosted MCP server (build → deploy → registry),
   then writes the resulting server id back into `guuey.json`.
2. **ggui asset leg** — pushes `ggui/` (ggui.json, blueprints, themes) to your
   app's guuey-managed ggui instance.
3. **Agent leg** — builds `src/worker.ts` into `guuey.worker.js`, packs the
   project root, and deploys it as a gVisor-isolated, scale-to-zero pod.
4. **Output** — prints your agent's endpoint URL and a Portal deep link.

Re-running `guuey deploy` converges: unchanged pieces are skipped or reused,
nothing is duplicated.

## Filesystem + memory

Every deployed invoke gets three bound directories — `$GUUEY_HOME_DIR`
(durable, per-user), `$GUUEY_APP_DIR` (read-only, shared), and cwd (session
scratch) — plain `node:fs`, no wrapper API required. Signed-in users get
durable cross-session memory for free (a platform-owned prompt tells the
model to read/write `$GUUEY_HOME_DIR/memories/MEMORY.md`); guests never get
durable storage, by design. Full contract, code examples, and rollout
status: the "Your agent's filesystem" section of the guuey monorepo's
`docs/quickstart.md`, or [`@guuey/fs`](https://www.npmjs.com/package/@guuey/fs)'s
own README — an optional, three-helper sugar layer over the same paths.

## How people talk to your agent

- **guuey Portal** — a Telegram-like agent App Store and universal chat
  client. Once deployed, your agent is reachable from Portal with **zero
  frontend code** — most builders never need to touch `web/` at all.
- **`web/`** — ships anyway, because the local dev loop needs a chat surface,
  and it's a worked example of the bring-your-own-frontend path if you want
  to embed your agent somewhere Portal doesn't reach.
- **Future: guuey widgets** — an embeddable web-chat widget for dropping
  your agent into an existing site is planned as a separate feature; `web/`
  is designed to make that graduation straightforward when it lands.
