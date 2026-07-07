# @guuey/host

The universal agent host for [guuey.com](https://guuey.com) — the injected
harness that runs declarative (no-code) and graceful code-mode agents on
Guuey pods, and locally under `guuey dev --serve`.

**You usually don't install this directly.** It arrives two ways:

- on Guuey pods, baked into the platform image (`/shared`);
- locally, as a dependency of [`@guuey/cli`](https://www.npmjs.com/package/@guuey/cli),
  which spawns it so your local loop matches production exactly.

## What it does

Reads the resolved agent snapshot, lazily loads the runner for the agent's
framework, drives one turn per invoke, and streams the framework's native
events to the platform (which normalizes them to AgJSON via
`@silverprotocol/*`). Frameworks are **optional peer dependencies** — the
host is orchestration; the runtime comes from the installer (on Guuey, the
platform's pinned versions; in graceful mode, _your_ project's copy wins).

| framework           | runner                                              | runtime peer                     |
| ------------------- | --------------------------------------------------- | -------------------------------- |
| `claude-agent-sdk`  | Claude Agent SDK loop                               | `@anthropic-ai/claude-agent-sdk` |
| `openai-agents-sdk` | OpenAI Agents loop                                  | `@openai/agents`                 |
| `google-adk`        | official Google ADK (`LlmAgent` + `InMemoryRunner`) | `@google/adk`                    |

## Graceful mode

If `guuey.json#agent.entry` names a module, the host imports it and runs
your framework-native agent — plain export or factory:

```ts
import type { GuueyContext } from "@guuey/config";
export default (guuey: GuueyContext) =>
  new LlmAgent({
    model: guuey.model,
    instruction: guuey.instruction,
    tools: [myTool, ...guuey.mcpToolsets],
  });
```

Scaffold one with `npm create @guuey/agentic-app`.

## License

MIT © Loqu, Inc.
