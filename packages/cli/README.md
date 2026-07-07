# @guuey/cli

The [guuey](https://guuey.com) command line — deploy and operate hosted AI
agents and their MCP servers.

```
npm install -g @guuey/cli

guuey login                    # authenticate with your guuey account
guuey apps create --name my-agent
guuey deploy                   # agent + hosted MCP servers, one command
guuey dev --serve              # pod-parity local run of your agent
guuey mcp list|status|logs|delete
guuey deployments list
```

Start from a working scaffold:

```
npx @guuey/create-agentic-app my-agent
```

Configuration lives in your project's `guuey.json`
([`@guuey/config`](https://www.npmjs.com/package/@guuey/config)); agent
workers implement the open
[`@guuey/worker`](https://www.npmjs.com/package/@guuey/worker) protocol.
