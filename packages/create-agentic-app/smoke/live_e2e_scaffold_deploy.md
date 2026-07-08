# `@guuey/create-agentic-app` live e2e — scaffold → dev → deploy (operator)

**What this proves:** the whole builder golden path is real end-to-end — scaffold
a working local dev stack (agent + todo MCP + ggui + web chat), and `guuey deploy`
takes that same project from a laptop to a live pod behind a public
`/agent/invoke` endpoint, with the hosted-MCP leg's `McpServer`/
`McpServerDeployment` rows and the `AgentDeployment` row both reaching
`status: 'live'`.

Two parts:

- **Part A — local dev.** Scaffold + install + `pnpm dev`, one live browser turn.
  Manual, run against whatever AWS account you like (only needs an
  `ANTHROPIC_API_KEY`; no platform deploy involved).
- **Part B — hosted deploy.** Fully automated by
  `e2e/scaffolder/scripts/dev-env-e2e.mjs` (repo root;
  `make e2e-scaffold-dev-env`) — the stage-3 real-infra e2e from the scaffolder-e2e-tiers plan.
  It scaffolds to a temp dir, logs in headlessly, creates a throwaway app,
  deploys, asserts every leg, curls the deployed endpoint, and tears everything
  down in a `finally` (pass `--keep` to skip teardown for debugging). This
  section is now just: prereqs → run the one command → eyeball Portal.

> Mechanics verified against source (Task 16 research pass, 2026-07-03; Part B
> re-verified + automated in the scaffolder-e2e-tiers Task 3 pass, 2026-07-04):
> `oss/packages/cli/src/commands/deploy.ts` (deploy orchestrator),
> `oss/packages/cli/src/deploy-plan.ts` (mode routing + `writeBackServerId`),
> `oss/packages/cli/src/commands/mcp.ts` (`resolveServerName`/`resolveWorkspaceId`/
> `mcpStatus`/`mcpDelete` — the real flag shapes `e2e/scaffolder/scripts/dev-env-e2e.mjs` (repo root) drives),
> `oss/packages/cli/src/commands/{login,apps,delete,undeploy,deployments}.ts`
> (`--token`, `apps create --json`, `delete --force` [not `--yes`],
> `undeploy --app-id --force`, `deployments list --json`),
> `oss/packages/cli/src/ggui-assets.ts` (ggui-asset leg, env-dormant by design),
> `backend/amplify/data/mcp.ts` (`McpServer`/`McpServerDeployment`),
> `backend/amplify/data/marketplace.ts` (`AgentDeployment`),
> `oss/packages/cli/src/dev/dev-server.ts` (`/agent/invoke` SSE contract — byte-matches
> `backend/services/nocode-runtime/src/sse-server.ts`'s framing by design),
> `apps/portal/services/ownerApps.ts` + `apps/portal/app/my-agents.tsx` ("My Agents").

**Part A prereqs:**

- A real `ANTHROPIC_API_KEY` (drives the scaffolded agent locally). No AWS account
  or platform deploy is involved in Part A.
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

**Expect:** all 5 lines print ready/listening with no crash loop.

### A2 — Live browser turn (todo-create via chat + a ggui render)

Open `http://localhost:6890`. It's a minimal chat: a scrollback + a text input.

1. Send: `create a todo: buy milk`. The system prompt routes this to the todo MCP's
   `todo_create` tool (`{title: string}` → returns the created `Todo`).
   **Expect:** a tool-result block appears in the scrollback for the `todo_create` call.
2. If the result renders as an interactive card (not just plain text), that's the
   ggui MCP-Apps leg working — the block mounts via `@mcp-ui/client`'s
   `<AppRenderer>` in a sandboxed iframe (dev sandbox at
   `http://127.0.0.1:6891/sandbox.html`, the vite `sandboxProxyPlugin`).
   **Expect:** either a rendered card OR plain text — both are a PASS for A2 (ggui
   generation can fall back to text on a cache miss / model hiccup); a thrown
   error in the scrollback or a blank pod is the FAIL signal.
3. Optional: send `list my todos` to exercise `todo_list` too.

**Known template limitation (not a bug):** clicking an interactive element that
tries to call back into the model (`onCallTool`/`onReadResource`) shows "tool-call
relay is not wired in this template" — the scaffold's minimal `App.tsx` doesn't wire
that relay. Rendered UI that doesn't round-trip through the model works fine.

Ctrl-C to stop `pnpm dev` before Part B (frees 6781/6782/6790/6890/6891).

---

## Part B — hosted deploy (dev env, automated)

Automated end-to-end by the repo-root `e2e/scaffolder/scripts/dev-env-e2e.mjs` per the scaffolder-e2e-tiers
plan (Task 3) — this section used to be six manual steps (auth, deploy, four
assertion passes, rollback); it is now prereqs + one command + an eyeball check.

### B0 — Prereqs

1. **Dev's `amplify_outputs.json`.** Fetch it the same way any dev-env operator
   does (Amplify console → the dev app → download `amplify_outputs.json`, or
   `ampx generate outputs` against the dev backend if you have CLI access). You
   only need two fields out of it:
   - `custom.cliApiUrl` → `GUUEY_E2E_API_URL`
   - the dev platform's friendly host (e.g. `https://dev.platform.guuey.com` —
     confirm the exact dev domain with whoever owns the dev environment; the
     script's dev-env guard requires this host to carry a recognizable "dev"
     label and rejects anything staging/release/prod-shaped) → `GUUEY_E2E_HOST`

   **BOTH vars must come from the same dev `amplify_outputs.json`.** The
   guard's "must contain dev" check runs on `GUUEY_E2E_HOST`, but every
   mutation (create/deploy/delete) targets `GUUEY_E2E_API_URL` — a dev HOST
   paired with a non-dev API_URL passes the guard and tears down the wrong
   environment. The script prints the resolved API endpoint plus a read-only
   `apps list` fingerprint in a preflight banner right after login; eyeball
   it before letting a run proceed unattended.

2. **Mint a dev-env API key.** Log in to the dev platform as a real user, then
   mint a `guuey_user_...` key from the workspace **API Keys** page (Workspace
   settings → API Keys) and copy it → `GUUEY_E2E_PAT`. This must be a key for a
   user who can create apps AND deploy hosted MCP servers in the target
   workspace.
3. **A workspace id.** `guuey deploy`'s MCP leg refuses to run without one — the
   scaffold's fresh `guuey.json` has no `workspaceId` (that's only stamped by
   `guuey pull` against an already-linked app). Grab the id of a workspace the
   PAT's user belongs to (Workspace settings in the dev platform, or
   `WorkspaceMembership` in the dev DynamoDB console) → `GUUEY_E2E_WORKSPACE`.
4. Repo built (`pnpm install` at the repo root) — the script builds
   `@guuey/cli` + `@guuey/create-agentic-app` itself via turbo, but needs the
   workspace installed first.

**Never** put these in `.env` files or commit them — export them in your shell
for the one command below and nothing else. The script masks the PAT in its own
logs and never touches your real `~/.guuey` (it runs with an isolated `HOME`).

### B1 — Run it

```bash
GUUEY_E2E_PAT=guuey_user_... \
GUUEY_E2E_API_URL=https://<dev-api-id>.execute-api.<region>.amazonaws.com/v1 \
GUUEY_E2E_HOST=https://<dev-domain> \
GUUEY_E2E_WORKSPACE=<workspace-id> \
  pnpm --filter @guuey/create-agentic-app run e2e:dev-env
```

Add `--keep` at the end to skip teardown on success too (leaves the app + hosted
MCP server live for manual poking — print the cleanup commands yourself from the
script's own "residue"/`--keep` output).

If any of the four `GUUEY_E2E_*` vars is unset, the script prints a skip note and
exits 0 — safe to leave wired into CI, it just never runs there without secrets.
If `GUUEY_E2E_HOST`/`GUUEY_E2E_API_URL` don't look like a dev environment
(contain `staging`/`release`/the bare prod host/no `dev` label), it refuses with
exit 1 unless `GUUEY_E2E_I_KNOW_WHAT_IM_DOING=1` is also set.

**What it does** (mirrors the six manual steps this section used to have):

1. Builds `@guuey/cli` + `@guuey/create-agentic-app` (+ deps) via turbo.
2. Packs the internal cohort to tarballs (same pack-tarball-override mechanism
   as `pnpm smoke` — no registry, no reliance on npm publishes existing yet).
3. Scaffolds the `claude-agent-sdk` framework to a temp dir.
4. Fixes the todo MCP's hosted name to the fixed `e2e-todo` (edits
   `mcps/todo/package.json#name` — **not** `guuey.json`; the deploy
   orchestrator resolves a hosted MCP's server name from the source package's
   `package.json#name`, scope-stripped — `guuey.json#agent.mcpServers.todo` is
   only the internal leg key used for the `server` write-back).
5. `pnpm install`.
6. `guuey login --token $GUUEY_E2E_PAT` (isolated `HOME`).
7. `guuey apps create --name e2e-caa-<unix-ts> --json` (throwaway app).
8. `guuey deploy` — asserts: exits 0; prints the ggui-leg warn-and-continue line
   verbatim (env-dormant leg — a FAIL here would be anything else); prints
   `Live at <url>`.
9. Asserts `guuey.json#agent.mcpServers.todo.server` was written back.
10. `guuey mcp status <serverId> --json` — asserts `hostingStatus: 'live'` +
    `runtimeUrl` set.
11. `guuey deployments list --json` — asserts the newest build's `status` is
    `'live'`.
12. POSTs `{"input":"create a todo: buy milk"}` to the deployed
    `/agent/invoke` and asserts the SSE stream is `event: session` → ≥1
    `event: message` → `event: done`.

    > **Known blocker — the todo tool call itself can't work yet.** The
    > hosted-MCP path serves `runtimeUrl` WITHOUT the `/mcp` suffix
    > (`buildMcpRuntimeUrl` in mcp-store.ts emits
    > `https://<domain>/<serverId>/` bare), the gateway fetches that URL
    > literally, and every shipped MCP template only answers `/mcp` — so the
    > agent's `todo_*` tool calls 404 against the hosted server until a
    > platform slice fixes `buildMcpRuntimeUrl` + gateway + aud together.
    > **What you'll see:** the turn still streams `session` →
    > `message`(s) → `done` (the LLM answers without the tool), and the
    > script prints a `tool-signal: present|absent (known-blocker: …)` line —
    > logged, not asserted, so the run passes; expect `absent` until the fix
    > lands, after which the script's log-only check should be tightened to
    > an assertion. Ledger: `.superpowers/sdd/progress.md`, "PLATFORM
    > FOLLOW-UPS" item (2).

13. **Teardown, always, in a `finally`:** `guuey undeploy --app-id <id> --force`
    → `guuey delete <id> --force` → `guuey mcp delete <serverId> --force
--yes`. Anything that fails to clean up is printed as a "RESIDUE" list at
    the end (never silently swallowed) so you can clean it up by hand.

### B2 — Eyeball Portal

While the script is mid-run (or right after, if you passed `--keep`), open the
dev Portal → **My Agents** and confirm the throwaway `e2e-caa-<ts>` app shows up
with `deploymentStatus: 'live'` and an `endpointUrl` matching the script's
printed URL. This is the one thing the script can't assert from the CLI side
(no Portal API surfaced here) — it's a manual sanity check, not a blocking gate.

### B3 — Debugging a failure

Pass `--keep` to skip teardown and leave the app/pod/hosted-MCP-server live:

```bash
GUUEY_E2E_PAT=... GUUEY_E2E_API_URL=... GUUEY_E2E_HOST=... GUUEY_E2E_WORKSPACE=... \
  pnpm --filter @guuey/create-agentic-app run e2e:dev-env --keep
```

On `--keep`, the script prints the exact `appId`/`serverId`/temp-dir it left
behind plus the manual `guuey undeploy` / `guuey delete` / `guuey mcp delete`
commands to run once you're done investigating — copy them verbatim (they carry
the right `--force`/`--yes` flags).

---

## Pass / Fail summary

| Part | Check                          | Expected                                                              |
| ---- | ------------------------------ | --------------------------------------------------------------------- |
| A1   | `pnpm dev` 5-process boot      | all ready, no crash loop                                              |
| A2   | chat → `todo_create` tool call | tool-result block in scrollback (rendered or plain)                   |
| B1   | `e2e:dev-env` exit code        | `0`                                                                   |
| B1   | MCP leg                        | `guuey mcp status e2e-todo` → `hostingStatus: 'live'`, runtimeUrl set |
| B1   | ggui-asset leg                 | warn-and-continue line printed verbatim (env-dormant, expected)       |
| B1   | agent leg                      | `Live at <url>` printed; newest `deployments list` row `'live'`       |
| B1   | `guuey.json` write-back        | `agent.mcpServers.todo.server` populated post-deploy                  |
| B1   | `/agent/invoke` SSE            | `session` → `message`(s) → `done`                                     |
| B1   | Teardown                       | no "RESIDUE" lines printed                                            |
| B2   | Portal "My Agents"             | app listed, `deploymentStatus: 'live'`, endpoint matches              |

All rows PASS → **the create-agentic-app → guuey deploy golden path is validated
live against the dev environment.**

---

## Troubleshooting / known gaps

- **Script exits 0 immediately with a SKIPPED note** — one of the four
  `GUUEY_E2E_*` vars is unset. That's by design (never blocks keyless CI); set
  all four per B0.
- **Script REFUSES with exit 1 before doing anything** — the dev-env guard
  rejected `GUUEY_E2E_HOST`/`GUUEY_E2E_API_URL` as not dev-shaped. Double-check
  you copied the DEV amplify_outputs, not main/staging/release. Only override
  with `GUUEY_E2E_I_KNOW_WHAT_IM_DOING=1` if you are certain.
- **Fails at "guuey deploy"'s MCP leg with a workspace error** — `guuey.json`
  has no `workspaceId` and `GUUEY_E2E_WORKSPACE` didn't resolve; re-check the
  PAT's user is actually a member of that workspace.
- **ggui-asset leg returns something other than the warn-and-continue line** —
  that IS a real FAIL (`ggui-assets.ts`'s ordering aborts before the agent leg
  on anything but the expected 501/warn). Don't confuse it with the expected
  case.
- **"RESIDUE" printed at the end** — teardown couldn't clean something up (the
  script never silently swallows a cleanup failure). The residue lines name the
  exact leftover (`appId`/`serverId`) — clean it up by hand with the flags shown
  in B3.
- **`/agent/invoke` never sends `event: done`** — confirm the pod actually
  reached `status: 'live'` (not still `deploying`) before the script curled it;
  a `queued`/`building` app has no listener yet. Re-run with `--keep` and poll
  `guuey mcp status`/`guuey deployments list` by hand to see where it's stuck.
- **This is the FIRST live run of the create-agentic-app → deploy path against
  the dev env** (as of 2026-07-04) — if something upstream in the deploy
  pipeline itself is broken (not create-agentic-app-specific), cross-reference
  the deploy-controller's own live runbooks
  (`backend/services/deploy-controller/smoke/`,
  `docs/operations/runbooks/live_e2e_code_mode_python.md`) — they've
  already live-proven the underlying build→deploy→invoke mechanics independently
  of this CLI-driven entrypoint.
