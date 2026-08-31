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

## Wanting more?

If you outgrow manage-only — you want your OWN site with the agent
embedded — scaffold the app template next to this repo:

```bash
npx @guuey/create-agentic-app my-site --template agentic-app --app <your appId>
```
