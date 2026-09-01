# agentic-app-template

The **manage-only** repo for your guuey agent: the whole definition lives
here as files — the system prompt and the manifest — and `guuey agent
apply` is the whole deploy story. There is no web app in this repo; your
agent is reached through the surfaces guuey hosts for it (the widget
embed, the share page, the portal).

## The loop

```bash
pnpm install
pnpm login          # once — opens the guuey console
# edit prompts/system.md (the agent's voice) and guuey.json (model, MCP servers)
pnpm apply          # push the definition to your live agent
```

`guuey.json`'s `appId` binds this repo to your app. If it was scaffolded
from the console it is already set; otherwise `pnpm apply` will tell you
what to do.

## Guest & authenticated modes

If your agent was drafted in the guuey console with guest/auth mode
prompts, **run `guuey pull` before your first `pnpm apply`** — it writes
the live definition (modes included) into this repo. Apply is
doc-is-desired-state: a document without `agent.modes` declares an agent
without modes, and the CLI will refuse a first apply that would strip
live modes (pass `--replace` only if that is what you mean). To declare
modes here directly:

```jsonc
// guuey.json → agent
"modes": {
  "rep":   { "systemPromptAppend": "prompts/rep.md",  "audience": ["guest"] },
  "agent": { "systemPromptAppend": "prompts/full.md", "audience": ["authenticated"] }
}
```

## Wanting more?

If you outgrow manage-only — you want your OWN site with the agent
embedded — scaffold the app template next to this repo:

```bash
npx @guuey/create-agentic-app my-site --template agentic-app --app <your appId>
```
