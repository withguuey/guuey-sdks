# `@guuey/create-agentic-app` live e2e — scaffold → dev → deploy (operator)

**What this proves:** the whole builder golden path is real end-to-end against the
**main sandbox** AWS account — `npx @guuey/create-agentic-app` scaffolds a working
local dev stack (agent + todo MCP + ggui + web chat), and `guuey deploy` takes that
same project from a laptop to a live pod behind a public `/agent/invoke` endpoint,
with the hosted-MCP leg's `McpServer`/`McpServerDeployment` rows and the
`AgentDeployment` row both reaching `status: 'live'`.

Two parts:

- **Part A — local dev.** Scaffold + install + `pnpm dev`, one live browser turn.
- **Part B — hosted deploy.** `guuey deploy` (code-orchestrated), assert every leg,
  curl the deployed endpoint, confirm Portal shows the app, clean up.

> Mechanics verified against source (Task 16 research pass, 2026-07-03):
> `oss/packages/cli/src/commands/deploy.ts` (deploy orchestrator),
> `oss/packages/cli/src/deploy-plan.ts` (mode routing + `writeBackServerId`),
> `oss/packages/cli/src/ggui-assets.ts` (ggui-asset leg, env-dormant by design),
> `backend/amplify/data/mcp.ts` (`McpServer`/`McpServerDeployment`),
> `backend/amplify/data/marketplace.ts` (`AgentDeployment`),
> `backend/services/nocode-runtime/src/sse-server.ts` (`/agent/invoke` SSE contract),
> `apps/portal/services/ownerApps.ts` + `apps/portal/app/my-agents.tsx` ("My Agents").

**Prereqs:**

- `make aws` (SSO login, `guuey-sandbox`, us-east-1, PowerUserAccess).
- The **main sandbox** `amplify_outputs.json` at the project root (or an ancestor —
  the CLI walks up 3 dirs from cwd) or as `GUUEY_API_URL`/`GUUEY_HOST` env vars. Its
  `custom.cliApiUrl` is what `guuey deploy`/`undeploy` actually POST to; `host`
  (default `https://platform.guuey.com`, override via `GUUEY_HOST`) is only used by
  `guuey login`'s browser-authorize flow.
- A real `ANTHROPIC_API_KEY` (drives the scaffolded agent locally; the hosted pod
  gets its own key via the platform's managed-LLM broker, not this one).
- `guuey login` completed (PAT saved to `~/.guuey/config.json`) against that same
  host — see Part B step 0.
- Node ≥20, pnpm via corepack (matches `packageManager` pin), a spare terminal for
  `pnpm dev`'s foreground process.

---

## Part A — local dev

### A0 — Scaffold

```bash
npx -y @guuey/create-agentic-app /tmp/caa-live-smoke --framework claude-agent-sdk --name caa-live-smoke
cd /tmp/caa-live-smoke
```

`--framework openai-agents-sdk` is the other supported option — repeat Part A/B on
it too if you want both frameworks live-proven in one pass; the assertions below are
identical either way.

### A1 — Install + boot

```bash
pnpm install
cp .env.example .env.local
# edit .env.local: set ANTHROPIC_API_KEY to a real key
pnpm dev
```

`dev.mjs` boots 5 processes together (Ctrl-C tears down all of them):

```
worker   tsup --watch                         (no port — rebuilds guuey.worker.js)
agent    guuey dev --serve                    http://localhost:6790
todo     mcps/todo/src/server.ts              http://localhost:6782
ggui     ggui serve --mcp-only --dev-allow-all http://localhost:6781
web      vite                                 http://localhost:6890
```

# EXPECT: all 5 lines print ready/listening with no crash loop.

### A2 — Live browser turn (todo-create via chat + a ggui render)

Open `http://localhost:6890`. It's a minimal chat: a scrollback + a text input.

1. Send: `create a todo: buy milk`. The system prompt routes this to the todo MCP's
   `todo_create` tool (`{title: string}` → returns the created `Todo`).
   # EXPECT: a tool-result block appears in the scrollback for the `todo_create` call.
2. If the result renders as an interactive card (not just plain text), that's the
   ggui MCP-Apps leg working — the block mounts via `@mcp-ui/client`'s
   `<AppRenderer>` in a sandboxed iframe (dev sandbox at
   `http://127.0.0.1:6891/sandbox.html`, the vite `sandboxProxyPlugin`).
   # EXPECT: either a rendered card OR plain text — both are a PASS for A2 (ggui
   # generation can fall back to text on a cache miss / model hiccup); a thrown
   # error in the scrollback or a blank pod is the FAIL signal.
3. Optional: send `list my todos` to exercise `todo_list` too.

**Known template limitation (not a bug):** clicking an interactive element that
tries to call back into the model (`onCallTool`/`onReadResource`) shows "tool-call
relay is not wired in this template" — the scaffold's minimal `App.tsx` doesn't wire
that relay. Rendered UI that doesn't round-trip through the model works fine.

Ctrl-C to stop `pnpm dev` before Part B (frees 6781/6782/6790/6890/6891).

---

## Part B — hosted deploy

### B0 — Auth

```bash
guuey login
```

Opens a browser against `${host}/cli/authorize`; completes, saves a `ggui_pat_...`
token. # EXPECT: "Logged in" confirmation printed.

### B1 — Deploy

```bash
cd /tmp/caa-live-smoke
guuey deploy
```

This is the **code-orchestrated** pipeline (`guuey.json#agent.mode: 'code'`, set by
the scaffold) — `deploy.ts`'s `deployCode()`:

1. **First-run app-create-and-link** (TTY only): prompts for an app name, creates a
   `GuueyApp` (`userAuthMode: 'anonymous'`), writes `appId` into `guuey.json` +
   `~/.guuey/config.json`.
2. **MCP leg** — deploys the `todo` MCP server (`agent.mcpServers.todo`, `kind:
'hosted'`) via the same path as `guuey mcp deploy`; polls until
   `McpServerDeployment.status: 'live'`; writes `agent.mcpServers.todo.server =
"<serverId>"` back into `guuey.json` on disk.
3. **ggui-asset leg** — packs `ggui/` and POSTs it. **Expected WARN, not a FAIL**:
   this endpoint is env-dormant until the ggui provisioning API lands
   (`GGUI_PROVISIONING_API_URL` unset on the platform side today), so it returns 501
   and the CLI prints `ggui assets not pushed — the platform-side API is pending
(tracked cross-team); deploy continues` and proceeds. A non-501 error here WOULD
   be a real FAIL (aborts before the agent leg).
4. **Agent leg** — `pnpm build` (must produce `guuey.worker.js`), tars, uploads,
   triggers, polls `AgentDeployment.status` to a terminal state.

# EXPECT: final output block:

```
Live at https://<something>.<agents-domain>/agent/invoke
Build #<n>, size sm
Portal: <portalUrl>/<appId>
todo → <runtimeUrl>
```

Save `APP_ID`, `SERVER_ID` (the todo MCP's), and the printed live `URL` — used below.

```bash
APP_ID=$(node -e "console.log(require('./guuey.json').project?.appId ?? require('./guuey.json').appId)" 2>/dev/null || true)
# If that doesn't resolve, read the appId from the deploy output / ~/.guuey/config.json directly.
```

### B2 — Assert `McpServer` / `McpServerDeployment` live

```bash
guuey.json | jq -r '.agent.mcpServers.todo.server'   # (or: cat guuey.json | jq ...)
```

# EXPECT: `guuey.json`'s `agent.mcpServers.todo.server` is now a real serverId (was

# absent pre-deploy) — this is the write-back proof, not a guess: `deploy-plan.ts`'s

# `writeBackServerId()` lands it to disk immediately after the MCP leg succeeds.

Cross-check via AppSync/DynamoDB console or `guuey mcp deploy --status <serverId>`
if exposed — either way: # EXPECT `McpServer.runtimeUrl` set (in-cluster URL,
e.g. `mcp-servers.guuey.com/<serverId>`) and the deployment row's
`status: 'live'`.

### B3 — Assert `AgentDeployment` live + curl the deployed endpoint

```bash
curl -sS -N -X POST "<the printed Live-at URL>" \
  -H 'Content-Type: application/json' \
  -d '{"input":"create a todo: buy milk"}'
```

# EXPECT: an SSE stream — `event: session`, one or more `event: message` frames

# (AgJSON-shaped `AgentEvent`s, not raw provider deltas), then `event: done`. No

# `Authorization` header needed for this default anonymous-auth app (the endpoint

# resolves identity via `resolveIdentity`, not a bearer check — a bearer header on

# `/agent/invoke` itself 501s by design, that's expected, don't chase it as a bug).

`AgentDeployment.status` should read `'live'` and `endpointUrl` should match the
printed URL (`https://<appId>.<agentsDomain>/agent/invoke`) — confirm via the same
console/query path used for B2.

### B4 — Assert Portal shows the app

Open Portal → **My Agents** (`apps/portal/app/my-agents.tsx`, backed by
`services/ownerApps.ts`: `GET /apps` + `GET /apps/:appId/deployments`).

# EXPECT: the app you just created appears with `deploymentStatus: 'live'` and a

# non-empty `endpointUrl` matching B3's URL. (Note: the deploy controller writes

# `endpointUrl`/`status` only onto `AgentDeployment`, never back onto `GuueyApp` —

# Portal joins deployments in to get this, so an app with zero deployments would

# show no endpoint even if the `GuueyApp` row itself is healthy.)

### B5 — Rollback / cleanup

```bash
guuey undeploy --app-id "$APP_ID"     # tears down the live pod; app row survives
guuey delete "$APP_ID" --force        # removes the throwaway GuueyApp entirely
rm -rf /tmp/caa-live-smoke
```

# EXPECT: `guuey undeploy` prints "Agent torn down. App is still available for

# future deploys."; `guuey delete` removes it from **My Agents**. Also confirm the

# `agent-$APP_ID` k8s namespace is gone (`kubectl get ns agent-$APP_ID` → NotFound)

# if you have cluster access — undeploy should have reaped it.

---

## Pass / Fail summary

| Part | Check                             | Expected                                                  |
| ---- | --------------------------------- | --------------------------------------------------------- |
| A1   | `pnpm dev` 5-process boot         | all ready, no crash loop                                  |
| A2   | chat → `todo_create` tool call    | tool-result block in scrollback (rendered or plain)       |
| B1   | `guuey deploy` MCP leg            | `McpServerDeployment.status: 'live'`                      |
| B1   | `guuey deploy` ggui-asset leg     | WARN "not pushed... deploy continues" (501, expected)     |
| B1   | `guuey deploy` agent leg          | `AgentDeployment.status: 'live'`, `Live at <url>` printed |
| B2   | `guuey.json` write-back           | `agent.mcpServers.todo.server` populated post-deploy      |
| B3   | `curl <url>/agent/invoke`         | SSE `session` → `message`(s) → `done`, AgJSON-shaped      |
| B4   | Portal "My Agents"                | app listed, `deploymentStatus: 'live'`, endpoint matches  |
| B5   | `guuey undeploy` + `guuey delete` | pod torn down, app removed from My Agents                 |

All rows PASS (with B1's ggui-asset leg landing on its expected WARN, not a FAIL) →
**the create-agentic-app → guuey deploy golden path is validated live on the main
sandbox.**

---

## Troubleshooting / known gaps

- **ggui-asset leg returns something other than 501 "not-yet-supported"** — that IS
  a real FAIL (deploy aborts before the agent leg per `ggui-assets.ts`'s ordering).
  Don't confuse it with the expected WARN case.
- **`guuey deploy` fails at "No app ID found. Run guuey create or guuey link
  first."`** — you're running non-interactively (no TTY), so the first-run
  app-create-and-link prompt is skipped by design. Run interactively once, or
  `guuey create`/`guuey link` an app id ahead of time.
- **`guuey.json#agent.mcpServers.todo.server` never appears** — the MCP leg didn't
  land; check `guuey.json#workspaceId` is set (`guuey pull` sets it) or pass
  `--workspace`/`GUUEY_WORKSPACE` explicitly — the MCP leg needs a workspace to
  attribute the hosted server to.
- **`curl .../agent/invoke` hangs with nothing streamed** — confirm the pod is
  actually `status: 'live'` (not still `deploying`) before curling; a `queued`/
  `building` app has no listener yet.
- **Portal shows the app but no live deployment** — `GuueyApp` and
  `AgentDeployment` are separate rows; Portal's "My Agents" joins them via
  `GET /apps/:appId/deployments`, so re-check B1 actually reached `status: 'live'`
  rather than `failed`/`superseded`.
- **This is the FIRST live run of the create-agentic-app → deploy path** (as of
  2026-07-03) — if something upstream in the deploy pipeline itself is broken (not
  create-agentic-app-specific), cross-reference the deploy-controller's own live
  runbooks (`backend/services/deploy-controller/smoke/`,
  `backend/services/adk-host-py/smoke/live_e2e_code_mode_python.md`) — they've
  already live-proven the underlying build→deploy→invoke mechanics independently of
  this CLI-driven entrypoint.
