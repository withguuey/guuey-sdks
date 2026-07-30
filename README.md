# guuey-sdks

The open-source surface of [guuey](https://guuey.com) — deploy AI agents,
their MCP servers, and generative UI from one config file.

This repo is the source of truth published to npm as the `@guuey/*` scope:

| package                                                    | what it is                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| [`@guuey/cli`](packages/cli)                               | `guuey login / deploy / dev / mcp …` — the command line               |
| [`@guuey/create-agentic-app`](packages/create-agentic-app) | `npx @guuey/create-agentic-app` — scaffold a deployable agent         |
| [`@guuey/worker`](packages/worker)                         | the Worker Protocol — the contract your agent code implements         |
| [`@guuey/config`](packages/config)                         | `guuey.json` types, schema, and loader                                |
| `@guuey/host` / `@guuey/fs` / `@guuey/state`               | platform worker + filesystem/state libs (published as they stabilize) |

## Quick start

```
npx @guuey/create-agentic-app my-agent
cd my-agent && pnpm install
pnpm dev              # local run: agent + MCP servers
guuey login && guuey deploy
```

## Developing

```
pnpm install
pnpm build && pnpm test
```

This repository is maintained as a mirror of the guuey platform monorepo;
issues and PRs are welcome here and are synced upstream by the team.

MIT © Loqu, Inc.
