# AGENTS.md: steering for the coding agent working in this repo

This is a **manage-only** guuey agent: the whole agent is two files, and guuey runs it. There is no code to write, no
server to start and no build.

- `prompts/system.md` is the agent's system prompt: who it is and how it behaves. It starts as guuey's default agent
  prompt; replace it with what this agent is for.
- `guuey.json` is the manifest: `agent.model`, `agent.systemPrompt`, the agent's MCP servers, modes and hooks, plus
  the top-level `appId` that binds this repo to a live app.

## The loop

```bash
PNPM_PLACEHOLDER install
PNPM_PLACEHOLDER login                          # once; opens the browser
PNPM_PLACEHOLDER pull                           # first, when guuey.json already has an appId: the live agent into the repo
PNPM_PLACEHOLDER exec guuey agent apply --dry-run   # the plan, and nothing written (exit 2 = changes pending)
PNPM_PLACEHOLDER apply                          # make the live agent match this repo
PNPM_PLACEHOLDER status                         # what is live
```

`apply` is the only way a change goes live, and it is doc-is-desired-state: what `guuey.json` and
`prompts/system.md` say is what the agent becomes. Run the dry run first and read the plan. If `guuey.json` came
with an `appId` (a repo started from the guuey console), run `pull` before the first `apply`: until then the repo
holds the template's prompt, and an `apply` would replace the live agent's prompt and MCP servers with it.

**Never** run `guuey deploy` (that is the code-mode verb, for apps with an agent worker) or look for a `dev` server
(a manage-only agent has none). If the user wants agent code, a web app or their own tools, that is code mode:

- for this app, once it is live: `guuey eject --app-id <id>` switches it to a code project, and it is one-way (guuey
  can no longer update the app's runtime, and `apply`, the console and Studio can no longer publish to it). Show the
  user that, and ask them to run it themselves in their own terminal, where it asks [y/N]. Never run it for them,
  and never pass `--yes`;
- for a new app: `npx @guuey/create-agentic-app <dir> --template base`.

## Binding to an app

`apply` needs `appId` at the top level of `guuey.json`. If it is missing, `apply` stops with "No app linked". To
bind:

- the agent already exists (created in the guuey console): put its app id in `guuey.json` as `"appId"`, then run
  `PNPM_PLACEHOLDER pull` before the first `apply`, so the live definition (including any guest/authenticated modes)
  is in the repo and `apply` does not strip it;
- there is no app yet: create one in the guuey console, or from here with the command below. Put the `App ID` it
  prints into `guuey.json` as `"appId"`.

  ```bash
  PNPM_PLACEHOLDER exec guuey apps create --name "My Agent"
  ```

## Tools: MCP servers

The platform's generative-UI server (`ggui`) is attached by default. Servers you declare under `agent.mcpServers` are
added on top of it (`"ggui": false` opts out). A server reached by URL is an `external` entry:

```jsonc
// guuey.json → agent
"mcpServers": {
  "docs": { "kind": "external", "url": "https://example.com/mcp" }
}
```

The URL must be `https://`. **Never put a secret value in `guuey.json`**: it is committed with the repo, and `apply` refuses a
literal secret in `headers`. Reference it
as `${env.NAME}` in the server's `headers`, list `NAME` under `agent.secrets`, and have the user set its value under
Secrets in the guuey console.

## Modes and hooks

- `agent.modes` gives guest and signed-in visitors different prompt additions and tool subsets. A mode can only
  narrow the base tools, never widen them. The README has the shape.
- `agent.hooks` runs platform actions at moments in a conversation. The scaffold ships the email reporter on
  `session.ended`, an end-of-conversation report of what visitors asked. Remove it if the user does not want that.
