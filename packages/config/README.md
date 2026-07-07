# @guuey/config

Types, schema, and loader for `guuey.json` — the single config file that
describes a [guuey](https://guuey.com) agent app: the agent (framework,
prompt, model, runtime), its MCP servers (hosted / co-located / external),
and its ggui generative-UI assets.

```ts
import { loadGuueyJson, safeParseGuueyJson } from "@guuey/config";

const { doc } = loadGuueyJson(projectRoot);
doc.agent.framework; // "claude-agent-sdk" | "openai-agents-sdk" | ...
doc.agent.mcpServers; // { todo: { kind: "hosted", server: "mcp-..." }, ... }
```

The schema is the contract shared by `guuey dev`, `guuey deploy`, and the
hosted runtime — one file, validated the same way everywhere. Scaffold a
project that uses it with `npx @guuey/create-agentic-app`.
