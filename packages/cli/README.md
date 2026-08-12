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

## `guuey dev` trust posture

`guuey dev --serve` runs your agent **unsandboxed, as you**:

- the worker is a plain child process — no jail on any platform (in
  production every invocation runs inside a gVisor-isolated pod);
- it inherits your **full shell environment**, including credentials that
  have nothing to do with this agent;
- when filesystem layers are bound, the host grants the agent shell and
  file tools **without prompting** — the isolation those tools assume is
  the production jail, which does not exist locally.

This is a deliberate local-dev trade-off, stated here so it's a decision
you read rather than one you discover. If your agent — or any MCP server
it talks to — handles untrusted input, run `guuey dev` inside a throwaway
container/shell with a minimal environment.
