# `@guuey/create-agentic-app` live e2e — scaffold → dev → deploy (operator)

**What this proves:** the whole builder golden path is real end-to-end — scaffold
a working local dev stack (agent + colocated todo MCP + ggui + web chat), and
`guuey deploy` takes that same project from a laptop to a live pod behind a
public `/agent/invoke` endpoint, with the `AgentDeployment` row reaching
`status: 'live'` and the colocated todo MCP (built into the worker image,
auto-spawned as a supervised child inside the pod) answering tool calls on the
live turn. There is no hosted-MCP leg: a `kind: 'colocated'` entry produces no
`McpServer`/`McpServerDeployment` rows, no `guuey.json` server write-back, and
nothing to `guuey mcp status`.

Two parts:

- **Part A — local dev.** Scaffold + install + `pnpm dev`, one live browser turn.
  Manual, run against whatever AWS account you like (only needs an
  `ANTHROPIC_API_KEY`; no platform deploy involved).
- **Part B — platform deploy.** Fully automated by
  `e2e/scaffolder/scripts/dev-env-e2e.mjs` (repo root;
  `make e2e-scaffold-dev-env`) — the stage-3 real-infra e2e from the scaffolder-e2e-tiers plan.
  It scaffolds to a temp dir, logs in headlessly, creates a throwaway app,
  deploys, asserts every leg, curls the deployed endpoint, and tears everything
  down in a `finally` (pass `--keep` to skip teardown for debugging). This
  section is now just: prereqs → run the one command → eyeball Portal.

> Mechanics verified against source (Task 16 research pass, 2026-07-03; Part B
> re-verified + automated in the scaffolder-e2e-tiers Task 3 pass, 2026-07-04;
> re-scoped to the colocated todo in the MCP-audit remediation D2 pass,
> 2026-07-22):
> `oss/packages/cli/src/commands/deploy.ts` (deploy orchestrator; hosted legs
> print `MCP "<name>" … → deploying as …` — the e2e asserts that line is ABSENT),
> `oss/packages/cli/src/deploy-plan.ts` (`planMcpLegs` only plans `kind:
'hosted'` entries — a colocated entry produces no leg and no write-back),
> `oss/packages/cli/src/commands/{login,apps,delete,undeploy,deployments}.ts`
> (`--token`, `apps create --json`, `delete --force` [not `--yes`],
> `undeploy --app-id --force`, `deployments list --json`),
> `oss/packages/cli/src/ggui-assets.ts` (ggui-asset leg, env-dormant by design),
> `backend/amplify/data/marketplace.ts` (`AgentDeployment`),
> `oss/packages/cli/src/dev/dev-server.ts` (`/agent/invoke` SSE contract — byte-matches
> `backend/services/nocode-runtime/src/sse-server.ts`'s framing by design; also
> the `guuey dev` colocated auto-spawn `lowerForDev` consumes),
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

`dev.mjs` boots 4 processes together (Ctrl-C tears down all of them). The
colocated todo MCP is NOT one of them — `guuey dev` auto-spawns every
`kind: 'colocated'` entry itself from its `source`/`devPort`, so the todo
server still listens on :6782 but as a supervised child of the `agent`
process:

```
worker   tsup --watch                         (no port — rebuilds guuey.worker.js)
agent    guuey dev --serve                    http://localhost:6790
                                              (auto-spawns mcps/todo → http://localhost:6782)
ggui     ggui serve --mcp-only --dev-allow-all http://localhost:6781
web      vite                                 http://localhost:6890
```

**Expect:** all 4 processes print ready/listening with no crash loop, and the
todo child's own listening line shows up double-prefixed (`[agent] [todo] …`)
— `guuey dev` prefixes the child it spawned, `dev.mjs` prefixes `guuey dev`.

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

## Part B — platform deploy (dev env, automated)

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
   user who can create apps and deploy in the target workspace.
3. **A workspace id.** The script pins every CLI call to it via
   `GUUEY_WORKSPACE`. The colocated todo produces no hosted-MCP deploy leg, so
   `guuey deploy` itself no longer demands one for this scaffold — but the gate
   stays: it keeps the throwaway app landing in the standing e2e workspace, and
   any future `kind: 'hosted'` entry's MCP leg refuses to run without one. Grab
   the id of a workspace the PAT's user belongs to (Workspace settings in the
   dev platform, or `WorkspaceMembership` in the dev DynamoDB console) →
   `GUUEY_E2E_WORKSPACE`.
4. Repo built (`pnpm install` at the repo root) — the script builds
   `@guuey/cli` + `@guuey/create-agentic-app` itself via turbo, but needs the
   workspace installed first.
5. **Rate-card tier override** (required on any enforced env — which is now
   ALL of them, dev included; see the next section):
   `GUUEY_E2E_TIER_OVERRIDE` + `GUUEY_E2E_APP_BILLING_TABLE`, plus ambient AWS
   credentials for the target env's account in the shell (the script shells
   out to `aws dynamodb update-item`).

**Never** put these in `.env` files or commit them — export them in your shell
for the one command below and nothing else. The script masks the PAT in its own
logs and never touches your real `~/.guuey` (it runs with an isolated `HOME`).

### B0.5 — Rate-card enforcement and `GUUEY_E2E_TIER_OVERRIDE` (read this)

The pod-side billing gates (`SpendPolicy` + `QuotaGate` in
`backend/services/nocode-runtime/src/`) enforce the rate card
(`TIER_LIMITS` in `quota-gate.ts`): the **free tier has a $0 managed-LLM
credit and a $0 default spending cap**, so a managed (platform-key) agent on
a free — or tier-less — `AppBilling` row is blocked at its FIRST invoke with
a clean HTTP 429 `{"code":"MANAGED_SPEND_CAP"}` (pod log:
`MANAGED_SPEND_CAP_EXCEEDED usedUsd:0 ceilingUsd:0`). That is **by design**,
not a bug — free tier means $0 managed-LLM spend.

Why every e2e/smoke run hits this: the script creates a **fresh app per
run**, and the platform's `appBillingInitStreamHandler` provisions its
`AppBilling` row on insert. The identity's single free slot
(`UserBilling.freeAppId` / `WorkspaceBilling.freeAppId`) was consumed by the
first app it ever created (long since torn down), so every subsequent fresh
app gets a **tier-less** row — and both gates resolve
`adminOverrideTier ?? tier ?? 'free'`, i.e. tier-less = free = $0 ceiling =
429 at step 11.

**Historical truth (evidence, 2026-07-09):** the dev e2e "passed managed
invokes" before 2026-07-08 only because fresh dev apps had **no `AppBilling`
row at all** — the dev env's `appBillingInitStreamHandler` wasn't
provisioning rows yet (the dev `AppBilling` table's oldest row is
`2026-07-08T13:26Z` despite this identity creating apps for days before
that), and the `SpendPolicy` **fails open** on a missing row
(`failOpen: 'no-billing-row'`, `spend-policy.ts`). Once the dev backend
caught up, dev started blocking exactly like prod: live-proven 2026-07-09
07:19Z on pod `agent-b3d4d905-…` (`POD_SPEND_ENFORCEMENT
policyConstructed:true preInvokeGate:true managed:true` →
`MANAGED_SPEND_CAP_EXCEEDED usedUsd:0 ceilingUsd:0`). Nothing about dev was
ever "allowed to spend" — it was un-provisioned, then fail-open.

The fix is the script's **admin tier override**: set

- `GUUEY_E2E_TIER_OVERRIDE` — one of `free | starter | pro | scale`
  (mirrors the `adminOverrideTier` enum in `backend/amplify/data/user.ts`;
  use `starter` — $20 managed credit + $50 default cap is plenty for one
  smoke turn, and `free` is pointless: $0 ceiling, still blocked);
- `GUUEY_E2E_APP_BILLING_TABLE` — the target env's physical `AppBilling`
  table name.

Right after `guuey apps create` (before deploy, so the pod's first billing
read sees it), the script writes `adminOverrideTier` onto the fresh app's
`AppBilling` row via `aws dynamodb update-item` and verifies the returned
attributes — any failure aborts the run loudly. `adminOverrideTier` takes
precedence over the price-derived `tier` in both gates, so the invoke leg is
gated at the override tier's real ceiling instead of $0. The write is
race-proof against the stream handler in both orderings (see the comment in
the script), and if the script wins the race the throwaway app never
consumes the identity's 1-free-app slot at all.

Known table names (verified 2026-07-09):

| Env            | Account                        | `AppBilling` table                           | `AppMonthlyUsage` (spend diagnosis)               |
| -------------- | ------------------------------ | -------------------------------------------- | ------------------------------------------------- |
| dev            | `guuey-sandbox` (285851439369) | `AppBilling-u7ftmnewvjay7ixg27bvqj2ioi-NONE` | `AppMonthlyUsage-u7ftmnewvjay7ixg27bvqj2ioi-NONE` |
| prod (release) | `guuey-release` (364660314633) | `AppBilling-myjpnhwcjfczhgv6fig7kr4lb4-NONE` | `AppMonthlyUsage-myjpnhwcjfczhgv6fig7kr4lb4-NONE` |

(Other envs: same `<Model>-<amplify-data-api-id>-NONE` shape — read the env's
`amplify_outputs.json` or `aws dynamodb list-tables`.)

### B1 — Run it

```bash
GUUEY_E2E_PAT=guuey_user_... \
GUUEY_E2E_API_URL=https://<dev-api-id>.execute-api.<region>.amazonaws.com/v1 \
GUUEY_E2E_HOST=https://<dev-domain> \
GUUEY_E2E_WORKSPACE=<workspace-id> \
GUUEY_E2E_TIER_OVERRIDE=starter \
GUUEY_E2E_APP_BILLING_TABLE=AppBilling-u7ftmnewvjay7ixg27bvqj2ioi-NONE \
  node e2e/scaffolder/scripts/dev-env-e2e.mjs
```

(`make e2e-scaffold-dev-env` runs the same script; the shell needs AWS
credentials for the dev/sandbox account for the tier-override write — the
default `make aws` SSO profile is exactly that.)

Add `--keep` at the end to skip teardown on success too (leaves the app — pod,
colocated todo child and all — live for manual poking; copy the cleanup commands
from the script's own "residue"/`--keep` output).

If any of the four `GUUEY_E2E_*` vars is unset, the script prints a skip note and
exits 0 — safe to leave wired into CI, it just never runs there without secrets.
If `GUUEY_E2E_HOST`/`GUUEY_E2E_API_URL` don't look like a dev environment
(contain `staging`/`release`/the bare prod host/no `dev` label), it refuses with
exit 1 unless `GUUEY_E2E_I_KNOW_WHAT_IM_DOING=1` is also set.

**What it does** (mirrors the six manual steps this section used to have):

1. Builds `@guuey/cli` + `@guuey/create-agentic-app` (+ deps) via turbo.
2. Packs the internal cohort to tarballs (same pack-tarball-override mechanism
   as `pnpm smoke` — no registry, no reliance on npm publishes existing yet).
3. Scaffolds the `claude-agent-sdk` framework to a temp dir. (No name-fixing
   step: the todo MCP is `kind: 'colocated'`, identified by its `guuey.json`
   key — `mcps/todo/package.json#name` is never consulted and there is no
   hosted registry to bound residue in.)
4. `pnpm install`.
5. `guuey login --token $GUUEY_E2E_PAT` (isolated `HOME`).
6. `guuey apps create --name e2e-caa-<unix-ts> --json` (throwaway app).
7. `guuey deploy` — asserts: exits 0; prints the ggui-leg warn-and-continue line
   verbatim (env-dormant leg — a FAIL here would be anything else); prints
   `Live at <url>`. The colocated todo is agent-leg cargo: it is built into
   the worker image and auto-spawned as a supervised child at pod boot.
8. Asserts `guuey.json#agent.mcpServers.todo` stayed `kind: 'colocated'` and
   gained NO `server` write-back (`planMcpLegs` only plans hosted legs — the
   deploy must leave the entry byte-untouched).
9. Asserts the deploy output contains NO hosted-MCP leg line (`MCP "…" →
deploying as …`) — no `McpServer`/`McpServerDeployment` rows exist for
   the colocated todo, so registry-side there is nothing to assert or tear
   down; the POSITIVE colocated proof is step 11's required tool-signal.
10. `guuey deployments list --json` — asserts the newest build's `status` is
    `'live'`.
11. POSTs `{"input":"create a todo: buy milk"}` to the deployed
    `/agent/invoke` and asserts the SSE stream is `event: session` → ≥1
    `event: message` → `event: done`, **and** that at least one message
    frame carries a TYPED tool signal (`tool.start`/`tool_use`/… — first
    enforced by the 2026-07-06 hosted-MCP data-plane slice, retained across
    the colocated flip: the todo tool now round-trips agent → the pod's
    auto-spawned colocated child → tool result in the stream; a turn that
    gracefully degrades to no tools FAILS).

    > On an enforced env without the tier override this step is exactly
    > where the run dies: `POST … failed: HTTP 429` (the pre-invoke
    > `MANAGED_SPEND_CAP` gate — see §B0.5).

12. **Teardown, always, in a `finally`:** `guuey delete <id> --force` (which
    archives + opens the 30-day deletion cascade — there is no `guuey
undeploy` leg; that endpoint is a deferred cliApi surface). That one
    command is the whole cleanup — the colocated todo lives inside the agent
    pod's image, so there is no separate MCP server to delete. Anything that
    fails to clean up is printed as a "RESIDUE" list at the end (never
    silently swallowed) so you can clean it up by hand. The `AppBilling` row
    (including a written `adminOverrideTier`) is NOT swept — billing rows for
    deleted apps are inert residue the platform already accumulates, and the
    override is harmless once the app is gone.

### B2 — Eyeball Portal

While the script is mid-run (or right after, if you passed `--keep`), open the
dev Portal → **My Agents** and confirm the throwaway `e2e-caa-<ts>` app shows up
with `deploymentStatus: 'live'` and an `endpointUrl` matching the script's
printed URL. This is the one thing the script can't assert from the CLI side
(no Portal API surfaced here) — it's a manual sanity check, not a blocking gate.

### B2.5 — Running against PROD (operator-owned; the post-enforcement smoke)

The same script doubles as the prod smoke — prod enforces the rate card, so
the tier override is **mandatory** there (the prod smoke identity's fresh
free app 429s by design otherwise). Differences from the dev run:

- The dev-env guard will (correctly) refuse `platform.guuey.com` — the
  explicit `GUUEY_E2E_I_KNOW_WHAT_IM_DOING=1` override is required. **This
  script creates AND deletes real prod resources.** Eyeball the preflight
  banner before letting it run unattended.
- AWS credentials must be for the **release** account (364660314633) — e.g.
  `AWS_PROFILE=guuey-prod-admin` — or the tier-override `update-item` fails
  loudly before deploy (by design: better than a guaranteed 429 later).
- Use the prod smoke identity's PAT + workspace (`ws-prod-smoke-…`), never a
  customer identity.

```bash
AWS_PROFILE=guuey-prod-admin \
GUUEY_E2E_PAT=<prod smoke identity PAT> \
GUUEY_E2E_API_URL=<prod amplify_outputs.json custom.cliApiUrl> \
GUUEY_E2E_HOST=https://platform.guuey.com \
GUUEY_E2E_WORKSPACE=<prod smoke workspace id> \
GUUEY_E2E_TIER_OVERRIDE=starter \
GUUEY_E2E_APP_BILLING_TABLE=AppBilling-myjpnhwcjfczhgv6fig7kr4lb4-NONE \
GUUEY_E2E_I_KNOW_WHAT_IM_DOING=1 \
  node e2e/scaffolder/scripts/dev-env-e2e.mjs
```

WHY this is the shape of the prod smoke now: enforcement means an
un-overridden run only proves "the 429 gate works" (worth one dedicated
check, not the whole golden path), while the `starter` override proves the
full deploy → invoke → tool-round-trip path at a real paid-tier ceiling. A
starter-tier smoke turn costs cents against a $70 customer-dollar ceiling.

### B3 — Debugging a failure

Pass `--keep` to skip teardown and leave the app/pod (colocated todo child
included) live:

```bash
GUUEY_E2E_PAT=... GUUEY_E2E_API_URL=... GUUEY_E2E_HOST=... GUUEY_E2E_WORKSPACE=... \
GUUEY_E2E_TIER_OVERRIDE=starter GUUEY_E2E_APP_BILLING_TABLE=<env AppBilling table> \
  node e2e/scaffolder/scripts/dev-env-e2e.mjs --keep
```

On `--keep`, the script prints the exact `appId`/temp-dir it left behind plus
the manual `guuey delete` command to run once you're done investigating — copy
it verbatim (it carries the right `--force` flag).

---

## Pass / Fail summary

| Part | Check                          | Expected                                                                 |
| ---- | ------------------------------ | ------------------------------------------------------------------------ |
| A1   | `pnpm dev` 4-process boot      | all ready, no crash loop; colocated todo child up under `[agent] [todo]` |
| A2   | chat → `todo_create` tool call | tool-result block in scrollback (rendered or plain)                      |
| B1   | `e2e:dev-env` exit code        | `0`                                                                      |
| B1   | colocated todo (no hosted leg) | no `MCP "…" → deploying as …` line in deploy output                      |
| B1   | ggui-asset leg                 | warn-and-continue line printed verbatim (env-dormant, expected)          |
| B1   | agent leg                      | `Live at <url>` printed; newest `deployments list` row `'live'`          |
| B1   | `guuey.json` untouched         | `agent.mcpServers.todo` still `kind: 'colocated'`, no `server` field     |
| B1   | `/agent/invoke` SSE            | `session` → `message`(s) → `done` + typed tool-signal present            |
| B1   | Tier override (when set)       | "tier override applied: adminOverrideTier=…" printed before deploy       |
| B1   | Teardown                       | no "RESIDUE" lines printed                                               |
| B2   | Portal "My Agents"             | app listed, `deploymentStatus: 'live'`, endpoint matches                 |

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
- **Fails at step 8/9 (colocated purity)** — `guuey.json`'s todo entry gained a
  `server` field or the deploy printed a hosted-MCP leg line. That means the
  scaffold's todo entry regressed to `kind: 'hosted'` (template drift) or the
  deploy orchestrator grew an unplanned write — either is a real product bug,
  not an e2e-env problem.
- **ggui-asset leg returns something other than the warn-and-continue line** —
  that IS a real FAIL (`ggui-assets.ts`'s ordering aborts before the agent leg
  on anything but the expected 501/warn). Don't confuse it with the expected
  case.
- **"RESIDUE" printed at the end** — teardown couldn't clean something up (the
  script never silently swallows a cleanup failure). The residue lines name the
  exact leftover (`appId`/temp dirs) — clean it up by hand with the flags shown
  in B3.
- **Step 11 fails with `POST … failed: HTTP 429`** — the managed-spend rate
  card blocked the invoke (`MANAGED_SPEND_CAP`; pod log
  `MANAGED_SPEND_CAP_EXCEEDED usedUsd:0 ceilingUsd:0`). Expected on any
  enforced env for a free/tier-less app — set `GUUEY_E2E_TIER_OVERRIDE` +
  `GUUEY_E2E_APP_BILLING_TABLE` per §B0.5. If it 429s WITH the override, the
  override write went to the wrong table/account (re-check the env ↔ table
  pairing and your AWS credentials) or the app genuinely exhausted the
  override tier's ceiling this month (read the env's `AppMonthlyUsage` row).
- **Script exits 1 with `CONFIG ERROR` before doing anything** —
  `GUUEY_E2E_TIER_OVERRIDE` is set to a non-tier value, or set without
  `GUUEY_E2E_APP_BILLING_TABLE`. Both travel together (§B0.5).
- **`/agent/invoke` never sends `event: done`** — confirm the pod actually
  reached `status: 'live'` (not still `deploying`) before the script curled it;
  a `queued`/`building` app has no listener yet. Re-run with `--keep` and poll
  `guuey deployments list` by hand to see where it's stuck.
- **This is the FIRST live run of the create-agentic-app → deploy path against
  the dev env** (as of 2026-07-04) — if something upstream in the deploy
  pipeline itself is broken (not create-agentic-app-specific), cross-reference
  the deploy-controller's own live runbooks
  (`backend/services/deploy-controller/smoke/`,
  `docs/operations/runbooks/live_e2e_code_mode_python.md`) — they've
  already live-proven the underlying build→deploy→invoke mechanics independently
  of this CLI-driven entrypoint.
