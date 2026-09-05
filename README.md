# guuey-sdks

The open-source surface of [guuey](https://guuey.com) — deploy AI agents,
their MCP servers, and generative UI from one config file.

This repo is the source of truth published to npm as the `@guuey/*` scope:

| package                                                    | what it is                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`@guuey/cli`](packages/cli)                               | `guuey login / deploy / dev / mcp …` — the command line                 |
| [`@guuey/create-agentic-app`](packages/create-agentic-app) | `npx @guuey/create-agentic-app` — scaffold a deployable agent           |
| [`@guuey/mcp-apps-host`](packages/mcp-apps-host)           | the MCP Apps (SEP-1865) Host role — view mounting + locator rehydration |
| [`@guuey/worker`](packages/worker)                         | the Worker Protocol — the contract your agent code implements           |
| [`@guuey/config`](packages/config)                         | `guuey.json` types, schema, and loader                                  |
| `@guuey/host` / `@guuey/fs` / `@guuey/state`               | platform worker + filesystem/state libs (published as they stabilize)   |

## Quick start

```
npx @guuey/create-agentic-app my-agent
cd my-agent && pnpm install
pnpm dev              # local run: agent + MCP servers
guuey login && guuey deploy
```

## Consumer surfaces and the pairing of record

The `@guuey/*` cohort is published lockstep (one version across all thirteen packages, `latest` moves only when all thirteen agree on npm) and is paired with two wire families it re-exports. **Pairing of record: `@guuey/*@0.18.x` + `@silverprotocol/*@0.6.1` + `@ggui-ai/*@0.15.0`** — a wire-family move is a cohort MINOR (a caret on the previous minor deliberately excludes it), so consumers move all three in the same hour; each release names the pairing.

A **consumer surface** is anything a consumer's code or tooling reads without importing a type: wire fields mirrored from the platform, error codes, dist-tags, and **readiness/health probe paths**. The rule (guuey#879): a rename or removal of a consumer surface is a **breaking line in the release notes** and an entry here — never a silent minor. Current entries:

- **Probe path:** `guuey dev --serve` answers readiness on `GET /readyz` only — `200` serving, `503` draining/degraded (retry), `ECONNREFUSED` not listening yet, anything else a real fault. `/healthz` returns **404 on purpose** (moved in 0.16.20, guuey#770; the hosted pod never served it, guuey#758) and will not be aliased — `guuey dev` rehearses the pod.
- **Dist-tags:** install from `latest` only; `next` is a retired rung pinned at 0.16.15 (dist-tag moves are not OIDC-covered, so it stays as a ghost).
- **Wire mirrors:** `@guuey/cli` mirrors the platform's wire types (apps, mcp, widget keys, deploy/agent config, mcp connections, billing, billing-invoicing) and cannot import them; the mirrors are sync-guarded in the monorepo, and an additive wire field is a patch, a removed one a breaking line.

## Developing

```
pnpm install
pnpm build && pnpm test
```

This repository is maintained as a mirror of the guuey platform monorepo;
issues and PRs are welcome here and are synced upstream by the team.

MIT © Loqu, Inc.
