#!/usr/bin/env node
/**
 * guuey CLI -- command-line interface for the guuey platform.
 *
 * Provides authentication, app management, and project configuration
 * from the terminal.
 *
 * Legacy binary name `ggui` is still available as a deprecated compat shim.
 *
 * @example
 * ```bash
 * guuey login
 * guuey apps create --name "My Agent App"
 * guuey deploy
 * guuey config init
 * ```
 */

import { configSet, configShow, configUnset, configInit } from './commands/config';
import {
  appsList,
  appsGet,
  appsCreate,
  appsUpdate,
  appsDelete,
  appsRecover,
  appsAccess,
  appsPublish,
  appsUnpublish,
  appsByoUserErase,
} from './commands/apps';
import { status } from './commands/status';
import { login } from './commands/login';
import { logout } from './commands/logout';
import { whoami } from './commands/whoami';
import { open } from './commands/open';
import { create } from './commands/create';
import { deleteApp } from './commands/delete';
import { dev } from './commands/dev';
import { test as testCmd } from './commands/test';
import { logs } from './commands/logs';
import { deploy } from './commands/deploy';
import {
  mcpDeploy,
  mcpList,
  mcpStatus,
  mcpLogs,
  mcpDelete,
  mcpSecretsSet,
  mcpSecretsList,
  mcpSecretsUnset,
  mcpStateList,
  mcpStateExport,
  mcpStateWipe,
} from './commands/mcp';
import { mcpNew } from './commands/mcp-new';
import {
  widgetKeysCreate,
  widgetKeysRotate,
  widgetKeysRevoke,
} from './commands/widget';
import { workerVerify } from './commands/worker';
import { pull } from './commands/pull';
import { undeploy } from './commands/undeploy';
import { stop, start, restart } from './commands/agent-lifecycle';
import { envSet, envList, envUnset } from './commands/env';
import { byokSet, byokList, byokRemove } from './commands/byok';
import { deploymentsList, deploymentsRollback, deploymentsLogs } from './commands/deployments';
import { agentConfig } from './commands/agent';
import { agentApply, agentStatus } from './commands/agent-apply';
import { domainsAdd, domainsList, domainsVerify, domainsRemove } from './commands/domains';
import { tokensCreate, tokensList, tokensRevoke } from './commands/tokens';
import { slugClaim, slugRelease } from './commands/slug';
import { ApiError } from './client';
import { printWelcome, printQuickGuide } from './logo';
import { checkForUpdate, printUpdateNotice } from './update-check';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfigDir } from './paths';
import { parseArgs } from './parse-args';

declare const __CLI_VERSION__: string;

// tsup injects __CLI_VERSION__ into dist builds; a source run (tsx via the
// repo's ./guuey wrapper) has no build step, so report our own package.json
// version instead of a placeholder the update check would flag as stale.
const IS_SOURCE_RUN = typeof __CLI_VERSION__ === 'undefined';

function readOwnPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')) as {
    version: string;
  };
  return pkg.version;
}

const VERSION = IS_SOURCE_RUN ? readOwnPackageVersion() : __CLI_VERSION__;

// Start update check in background (non-blocking). Source runs skip it:
// the workspace tree is not an npm install, so "curl install.sh" is the
// wrong advice and the npm latest comparison is meaningless there.
const updateCheckPromise: Promise<string | null> = IS_SOURCE_RUN
  ? Promise.resolve(null)
  : checkForUpdate(VERSION).catch(() => null);

// ─── Help text ───────────────────────────────────────────────────────

/** Print the full CLI help text to stdout. */
function printHelp(): void {
  console.log(`guuey CLI v${VERSION}

Usage: guuey <command> [options]

Agent Development:
  create <target>                Create a new guuey agent project (target is
                                 the positional output directory)
    --framework <f>              Framework: claude-agent-sdk | openai-agents-sdk
  delete [appId]                 Delete a guuey app from the platform
    --force                      Skip confirmation prompt
  dev --serve                    Run a pod-parity local SSE server against
                                 your built worker (POST /agent/invoke)
    --port <port>                Port (default: 6790)
                                 Without --serve, prints the Expo-style
                                 bridge/QR "coming soon" note (slice 2+).
  test <message>                 Send a test message and print agent response
    --session <id>               Reuse existing session
  deploy                         Deploy agent to guuey hosting (auto-detects
                                 declarative vs code mode; code mode deploys
                                 MCP + ggui + agent legs in one command)
    --app-id <id>                Deploy to this app instead of the guuey.json
                                 binding (the binding is left untouched)
    --declarative                Force declarative mode (uses guuey.json, no build)
    --code                       Force code mode (builds+deploys guuey.worker.js,
                                 or uses a root Dockerfile if present)
    --force                      Force deploy even if unchanged
    --size <s>                   Runtime pod size: xs | sm | md | lg | xl (default: sm)
    --build-size <s>             Build Job size: sm | md | lg | xl (default: md, code-mode only)
    --max-pods <n>               Replica count for the app (plan ceiling applies;
                                 omit to leave the current setting untouched)
    --runtime-auto-update on|off Runtime update channel: "on" (the default) keeps
                                 the agent on the platform's current runtime;
                                 "off" pins it at each deploy's runtime
    --label <tag>                Version label (e.g., v1.0, release-candidate)
  pull                           Refresh guuey.json from hosted state
    --app-id <id>                Override the resolved appId
  undeploy                       Tear down deployed agent (keeps app)
    --app-id <id>                Target a specific app
    --force                      Skip the [y/N] confirmation (required when not
                                 running in an interactive terminal; a declined
                                 or refused confirmation exits non-zero)
  env set KEY=VALUE              Set environment variables
  env list                       List environment variables
  env unset KEY                  Remove environment variables
  deployments [list]             List deployment builds
  agent config                   Show the app's hosting config (pods, runtime updates)
    --max-pods <n>               Set the replica count — applies to the LIVE app,
                                 no redeploy (converges within ~5 minutes)
    --runtime-auto-update on|off Automatic runtime updates (default on) or pinned
                                 to the runtime captured at the last deploy
    --json                       Emit the config as JSON

Agents as code (GitOps — CI-safe with a service token):
  agent apply                    Converge the hosted agent to this checkout's
                                 guuey.json (+ its prompt file) and its
                                 app.access policy in ONE idempotent call:
                                 unchanged bytes never roll the pod
    --dry-run                    Plan only: print the diff + content hashes,
                                 exit 2 when there is drift, write nothing
    --wait                       After applying, poll the build until live
    --provenance <p>             auto (default: GITHUB_REPOSITORY/GITHUB_SHA,
                                 else git origin + HEAD) | none |
                                 <org/repo>@<sha>[:<path>] — recorded on the
                                 build for "guuey agent status"
    --json                       Emit the reconcile response as JSON
  agent status                   What is live: build, provenance (repo@sha),
                                 persisted-snapshot hash, and the app's
                                 access config as stored
    --check                      Also compare THIS checkout byte-exact against
                                 the live build (exit 2 on drift)
    --json                       Emit the status (and check) as JSON
    --app-id <id>                Target a specific app (both subcommands)
  logs                           Fetch runtime logs for your deployed agent
    --since <duration>           Time window (default: 1h). Examples: 30s, 15m, 2h, 1d
    --tail <n>                   Only the last <n> lines
    --follow                     Live tail (Ctrl+C to stop)

Hosted MCP Servers:
  mcp deploy                     Deploy a hosted MCP server (code-mode, workspace-owned)
    --name <name>                Server name (workspace-unique; default: package.json name)
    --workspace <id>             Owning workspace (or $GUUEY_WORKSPACE)
    --size <s>                   Pod size: xs | sm | md | lg | xl (default: sm)
    --label <tag>                Version label
  mcp list                       List the workspace's hosted MCP server registry
    --workspace <id>             Owning workspace (or $GUUEY_WORKSPACE)
    --json                       Emit the raw servers array as JSON
  mcp status [<server>]          Show a server's registry row, deploy history, and grant count
    --server <id>                Target server (or positional / $GUUEY_MCP_SERVER)
    --workspace <id>             Owning workspace (or $GUUEY_WORKSPACE)
    --json                       Emit the full status response as JSON
  mcp logs [<server>]            Show captured build output for a build
                                 (default: latest; only failed builds capture
                                 output — streaming is a future slice)
    --build <n>                  Select a specific build number
    --server <id>                Target server (or positional / $GUUEY_MCP_SERVER)
    --workspace <id>             Owning workspace (or $GUUEY_WORKSPACE)
    --json                       Emit the selected deployment row as JSON
  mcp delete [<server>]          Fail-closed deprovision; polls until deleted
                                 Prompts "delete <serverId>? [y/N]" on a TTY
                                 unless --yes; refuses outright on a
                                 non-interactive session without --yes.
    --force                      Delete even if apps are attached (revokes their access)
    --yes                        Skip the interactive confirmation prompt
    --server <id>                Target server (or positional / $GUUEY_MCP_SERVER)
    --workspace <id>             Owning workspace (or $GUUEY_WORKSPACE)
  mcp secrets set NAME=VALUE     Set a hosted-MCP secret (KMS-encrypted)
    --server <id>                Target hosted MCP server (or $GUUEY_MCP_SERVER)
  mcp secrets list               List secret names (values never shown)
  mcp secrets unset NAME         Remove a hosted-MCP secret
  mcp state list                 List per-user stored-state usage for an MCP server
    --server <id>                Target hosted MCP server (or --colocated)
    --colocated <appId>/<name>   Target a colocated MCP server instead of --server
    --workspace <id>             Owning workspace (or $GUUEY_WORKSPACE; --server only)
    --json                       Emit the raw scopes array as JSON
  mcp state export --user <id>   Export one user's stored KV entries as pretty JSON
    --server <id>                Target hosted MCP server (or --colocated)
    --colocated <appId>/<name>   Target a colocated MCP server instead of --server
    -o <file>                    Write the export to a file instead of stdout
  mcp state wipe --user <id>     Irreversibly delete one user's stored KV entries
                                 Prompts "Wipe stored state for '<userId>' on
                                 '<server>'? [y/N]" on a TTY unless --yes;
                                 refuses outright on a non-interactive session.
    --server <id>                Target hosted MCP server (or --colocated)
    --colocated <appId>/<name>   Target a colocated MCP server instead of --server
    --yes                        Skip the interactive confirmation prompt
  mcp new <name>                 Scaffold a hosted MCP from the shared mcp-base template
    --scope <scope>              Package scope override (default: project scope, or <name> standalone)
                                 Inside a guuey project: scaffolds mcps/<name>/ and wires it
                                 into guuey.json#agent.mcpServers (kind: hosted). Outside one:
                                 scaffolds a self-contained ./<name>/ package for "guuey mcp deploy".
                                 Asks no questions — pick the mcpServers kind yourself:
                                   hosted (this)  — you own the code, want guuey to build+run it
                                   colocated      — an HTTP child that rides the agent pod for free
                                   external       — you already host it somewhere reachable by URL
                                   proxied        — 3rd-party SaaS MCP via the mcp-proxy credential broker (v2)

Worker Conformance:
  worker verify [<entry>]        Verify a worker is Guuey Worker Protocol v1 conformant
                                 (default entry: ./guuey.worker.js)

Authentication:
  login                         Log in via browser (opens auth page; a token
                                pasted at the prompt also works)
  login --no-browser            Print the auth URL only; paste the token back
                                (remote/SSH sessions)
  login --token <pat>           Log in with a Personal Access Token (headless)
  logout                        Clear stored credentials
  whoami                        Show current authenticated user

Apps:
  apps create                   Create a new app (auto-login if needed)
    --name <name>               App name (required)
  apps list                     List your apps
  apps get [appId]              Show app details
  apps update [appId]           Update app configuration
    --name <name>               App name
    --description <text>        App description
    --domains <d1,d2>           Allowed domains (comma-separated; pass
                                 --domains with no value to clear). Each entry
                                 is a bare domain (example.com) or a full
                                 origin (https://app.example.com[:port]) —
                                 no paths and no wildcards.
    --auth-mode <mode>          End-user auth: anonymous | native_pool | byo
    --issuer-url <url>          BYO OIDC issuer (https://…), with --audience
    --audience <aud>            Expected aud claim, with --issuer-url
    --clear-auth-config         Remove the issuer/audience binding
    --widget-embed-identity <identified|anonymous|clear>
                                 Embed identity-mode policy (widget wave 2).
                                 Read only when --auth-mode is byo; 'clear'
                                 restores the default (identified).
    --brand-icon-url <url>      Icon shown on the agent's page and in Discover
                                 (https://…). Pass 'clear' to unset.
    --brand-og-image-url <url>  Social-preview image for share links
                                 (https://…). Pass 'clear' to unset.
    --brand-icon-file <path>    Upload a local image as the icon instead of
                                 hosting it yourself (.png/.jpg/.jpeg/.webp —
                                 GIF and SVG are refused). Guuey serves it
                                 from the assets CDN and saves the URL
                                 immediately. Not with --brand-icon-url.
    --brand-og-image-file <path>  Same upload path, for the social-preview
                                 image. Not with --brand-og-image-url.
    --brand-accent <#rrggbb>    Accent colour for the send button and live dot.
                                 Must clear a 4.5:1 WCAG-AA contrast floor
                                 against the fixed #0e1014 foreground, or the
                                 server rejects it. Pass 'clear' to unset.
    --welcome-copy <text>       One-line welcome shown on the agent's own page
                                 before the first message (≤280 chars). Pass
                                 'clear' to unset.
    --identity-endpoint-url <url>  https endpoint on your own site the
                                 standalone page fetches (with credentials) to
                                 sign end-users in — the "C" identified-auth
                                 path. Pass with no value to unset.
                                 Branding applies whether or not the app is
                                 published — an unlisted share link is branded
                                 too. Styling, webhooks and rate limits are
                                 managed in the console, not here.
  apps delete [appId]           Delete an app
  apps recover [appId]          Cancel a pending deletion inside the 30-day
                                 window. Brings the widget signing key back
                                 with it (same app secret, so embeds need no
                                 changes); does NOT resume billing, so the app
                                 returns on free-tier limits until you
                                 resubscribe in the console.
  apps access [appId]           Set guest-chat access policy (personal apps only;
                                 workspace-owned apps 404 — use the platform UI)
    --guests <on|off>           Allow unauthenticated guest chat
    --guest-limit <n|off>       Per-guest daily message cap ('off' clears it)
                                 At least one of the two flags is required.
  apps publish [appId]          List the app in the store (personal apps only;
                                 workspace-owned apps 404 — use the platform UI)
    --name <name>               Listing name (defaults to the app's display name)
    --description <text>        Listing description
    --category <category>       Listing category
                                 The icon moved to: apps update --brand-icon-url
                                 — it brands the agent whether or not it is listed.
                                 Prints the share link, https://app.guuey.com/agent/<appId>
                                 (production portal origin; sandbox/dev envs serve the
                                 same route at a different origin).
  apps unpublish [appId]        Remove the app from the store (personal apps only;
                                 workspace-owned apps 404 — use the platform UI)
                                 Idempotent; the share link keeps working after unpublish.

App Admin (BYO-auth apps; workspace-admin only):
  apps byo-user erase [appId]   Erase one BYO end-user's app data (GDPR):
                                 enqueues the durable-home memory wipe (done
                                 within ~15 min) and synchronously deletes
                                 their threads/sessions for this app.
                                 Idempotent — re-running is safe.
    --sub <sub>                  The end-user's raw issuer sub (required)
  apps byo-user erase [appId] --status
                                 Poll the erase state instead of enqueuing:
                                 queued | done | none. stuck: true means
                                 the wipe hasn't drained — contact support.
    --sub <sub>                  The end-user's raw issuer sub (required)

Domains:
  domains add <domain>          Register a custom domain for the app and
                                 start DNS verification: point a CNAME at
                                 the cnameTarget the command prints (the
                                 app's always-on <appId>.agents… hostname).
                                 Apex domains are unsupported — use a
                                 subdomain (chat.example.com).
  domains list                  Default domain plus each custom domain's
                                 verification status (verified / pending /
                                 failed) and, once the edge picks it up,
                                 its TLS serving status
  domains verify <domain>       Run the DNS check now instead of waiting
                                 for the poll; prints the CNAME record to
                                 create if it does not match yet
  domains remove <domain>       Remove a custom domain
    --app-id <id>               Target a specific app (all subcommands)
                                 Not 'apps update --domains' — that flag is
                                 the CORS/embed origin allowlist, unrelated
                                 to custom domains.

Service tokens (headless CI, guuey#217):
  tokens create --label <l>     Mint an app-scoped service token
                                 (guuey_svc_*) for CI reconcile/deploy
                                 reads. Secret printed ONCE — store it as
                                 a CI secret, pass via GUUEY_API_KEY. No
                                 expiry; revoke is the kill switch.
  tokens list                   Prefix, label, and lifecycle per token
                                 (never the secret)
  tokens revoke <tokenId>       Revoke — auth stops within seconds
    --app-id <id>               Target a specific app (all subcommands)

Slug (free on every plan):
  slug claim <slug>             Claim the app's public short name, or change
                                 it. Buys BOTH surfaces at once: the portal
                                 path (/agent/<slug>) and the guuey-hosted
                                 <slug>.agents… subdomain, whose address the
                                 command prints. 3-50 characters, lowercase
                                 letters/digits/hyphens. The app's uuid
                                 address keeps working.
  slug release                  Give the slug back — its address stops
                                 resolving and the name becomes claimable
                                 by anyone
    --app-id <id>               Target a specific app (both subcommands)

Embeddable Widget (guuey-issued end-user identity):
  widget keys create [appId]    Enrol the app in guuey's per-app token issuer.
                                 Generates an RSA keypair (the private half is
                                 KMS-sealed and never leaves the platform) and
                                 prints an app secret ONCE — store it now, it
                                 cannot be shown again. Your backend signs
                                 end-user tokens with it via @guuey/widget-auth.
                                 Skip this entirely if you already run your own
                                 OIDC issuer — use 'apps update' instead.
    --audience <aud>            Also point the app at this issuer in one step
                                 (sets --auth-mode byo + the issuer binding).
                                 Refused if the app already trusts a DIFFERENT
                                 issuer, or is already on another auth mode,
                                 since either change re-keys every existing
                                 end-user. The key is still minted; finish with
                                 'guuey apps update' if you really mean it.
  widget keys rotate [appId]    Replace the signing keypair with no downtime —
                                 both public keys stay published for ~65 minutes,
                                 so tokens already issued keep verifying.
    --new-secret                Also mint a new app secret (printed once). The
                                 old secret stops working IMMEDIATELY, so your
                                 backend must ship the new one.
  widget keys revoke [appId]    Switch the app's widget identity off: revoke
                                 disables minting and unpublishes the JWKS
                                 immediately — every embedded widget for this
                                 app stops authenticating end-users. 'widget
                                 keys create' re-enrols with a fresh key —
                                 end-users keep their identity. Prompts on a
                                 TTY unless --yes; refuses outright in a
                                 non-interactive session.
    --yes                       Skip the interactive confirmation prompt

Configuration:
  config show                   Show resolved configuration
  config set <key> <value>      Set a config value (host, api-key, app-id)
  config unset <key>            Remove a global config value
  config init                   Create guuey.json in the current directory

Navigation:
  open [page]                   Open a console page in the browser
                                Pages: dashboard, settings, billing,
                                       usage, sessions, analytics

Status:
  status                        Check connectivity to guuey host

Global Options:
  --host <url>                  Override platform host URL for this command
  --config <path>               Use a custom config file instead of ~/.guuey/config.json
  --app-id <id>                 Target a specific app (overrides config)
  --json                        Output as JSON
  --help                        Show help
  --version                     Show version

Environment Variables:
  GUUEY_HOST                     Override platform host URL
  GUUEY_API_KEY                  Override configured API key
  GGUI_APP_ID                   Override configured app ID
  GUUEY_WORKSPACE                Default owning workspace for 'mcp deploy' / 'mcp list' /
                                 'mcp status' / 'mcp logs' / 'mcp delete'
  GUUEY_MCP_SERVER               Default hosted MCP server for 'mcp status' / 'mcp logs' /
                                 'mcp delete' / 'mcp secrets'
                                 ('mcp state' resolves via --server / --colocated only, not
                                 this env var)

Project Config (guuey.json):
  Place a guuey.json in your project root. Non-secret settings
  (appId, host, bridgeUrl) are merged with global config (project
  takes precedence). Run 'guuey config init' to create one.

Examples:
  guuey apps create --name "My Agent App"
  guuey deploy
  guuey open dashboard
  guuey config init
`);
}

// ─── Main ────────────────────────────────────────────────────────────

/**
 * CLI entry point. Parses arguments and routes to the appropriate command handler.
 * Exits with code 1 on unrecognized commands or errors.
 */
async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    console.log(VERSION);
    return;
  }

  // --host: override platform URL for this command
  if (flags.host) {
    process.env.GUUEY_HOST = flags.host as string;
  }

  // --config: override config file path
  if (flags.config && typeof flags.config === 'string') {
    const { setConfigFile } = await import('./config');
    setConfigFile(flags.config);
  }

  if (flags.help) {
    printHelp();
    return;
  }

  if (command.length === 0) {
    // First run (no config) → show full welcome with logo
    // Subsequent runs → show compact guide
    const configDir = getConfigDir();
    if (!existsSync(join(configDir, 'config.json'))) {
      printWelcome(VERSION);
    } else {
      printQuickGuide(VERSION);
    }
    return;
  }

  const [group, action, ...rest] = command;
  const jsonFlag = flags.json === true;

  /**
   * A flag's string value, or `undefined` when it is absent OR present
   * without a value. `parseArgs` yields `true` for a valueless flag, so
   * `flags.x as string | undefined` would hand a boolean to a
   * string-typed parameter and ship it onto the wire.
   */
  const str = (value: string | true | undefined): string | undefined =>
    typeof value === 'string' ? value : undefined;

  switch (group) {
    case 'create':
      await create(action, flags);
      break;

    case 'delete':
      await deleteApp(action, flags);
      break;

    case 'deploy':
      await deploy(flags);
      break;

    case 'mcp':
      switch (action) {
        case 'deploy':
          await mcpDeploy(flags);
          break;
        case 'list':
          await mcpList(flags);
          break;
        case 'status':
          await mcpStatus(rest[0], flags);
          break;
        case 'logs':
          await mcpLogs(rest[0], flags);
          break;
        case 'delete':
          await mcpDelete(rest[0], flags);
          break;
        case 'new':
          await mcpNew(rest[0], flags);
          break;
        case 'secrets':
          switch (rest[0]) {
            case 'set':
              await mcpSecretsSet(rest[1], flags);
              break;
            case 'list':
              await mcpSecretsList(flags);
              break;
            case 'unset':
              await mcpSecretsUnset(rest[1], flags);
              break;
            default:
              console.error(
                `Unknown mcp secrets command: ${rest[0] ?? '(none)'}. Use: set, list, unset`,
              );
              process.exit(1);
          }
          break;
        case 'state':
          switch (rest[0]) {
            case 'list':
              await mcpStateList(flags);
              break;
            case 'export':
              await mcpStateExport(flags);
              break;
            case 'wipe':
              await mcpStateWipe(flags);
              break;
            default:
              console.error(
                `Unknown mcp state command: ${rest[0] ?? '(none)'}. Use: list, export, wipe`,
              );
              process.exit(1);
          }
          break;
        default:
          console.error(
            `Unknown mcp command: ${action ?? '(none)'}. Use: list, status, deploy, logs, delete, new, secrets, state`,
          );
          process.exit(1);
      }
      break;

    case 'worker':
      switch (action) {
        case 'verify':
          await workerVerify(rest[0], flags);
          break;
        default:
          console.error(
            `Unknown worker command: ${action ?? '(none)'}. Use: verify <entry>`,
          );
          process.exit(1);
      }
      break;

    case 'pull':
      await pull(flags);
      break;

    case 'undeploy':
      await undeploy(flags);
      break;

    case 'stop':
      await stop(flags);
      break;

    case 'start':
      await start(flags);
      break;

    case 'restart':
      await restart(flags);
      break;

    case 'deployments':
      switch (action) {
        case 'list':
        case undefined:
          await deploymentsList({ json: jsonFlag }, flags);
          break;
        case 'rollback':
          await deploymentsRollback(rest[0], flags);
          break;
        case 'logs':
          await deploymentsLogs(rest[0], { json: jsonFlag }, flags);
          break;
        default:
          console.error(`Unknown deployments command: ${action}. Use: list, rollback, logs`);
          process.exit(1);
      }
      break;

    case 'domains':
      switch (action) {
        case 'add':
          await domainsAdd(rest[0], flags);
          break;
        case 'list':
        case undefined:
          await domainsList(flags);
          break;
        case 'verify':
          await domainsVerify(rest[0], flags);
          break;
        case 'remove':
          await domainsRemove(rest[0], flags);
          break;
        default:
          console.error(`Unknown domains command: ${action}. Use: add, list, verify, remove`);
          process.exit(1);
      }
      break;

    case 'tokens':
      switch (action) {
        case 'create':
          await tokensCreate(flags);
          break;
        case 'list':
        case undefined:
          await tokensList(flags);
          break;
        case 'revoke':
          await tokensRevoke(rest[0], flags);
          break;
        default:
          console.error(`Unknown tokens command: ${action}. Use: create, list, revoke`);
          process.exit(1);
      }
      break;

    case 'slug':
      switch (action) {
        case 'claim':
          await slugClaim(rest[0], flags);
          break;
        case 'release':
          await slugRelease(flags);
          break;
        default:
          console.error(
            `Unknown slug command: ${action ?? '(none)'}. Use: claim <slug>, release`,
          );
          process.exit(1);
      }
      break;

    case 'env':
      switch (action) {
        case 'set':
          await envSet(rest, flags);
          break;
        case 'list':
          await envList({ json: jsonFlag }, flags);
          break;
        case 'unset':
          await envUnset(rest, flags);
          break;
        default:
          console.error(`Unknown env command: ${action ?? '(none)'}. Use: set, list, unset`);
          process.exit(1);
      }
      break;

    case 'dev':
      await dev(flags);
      break;

    case 'test':
      await testCmd(action, flags);
      break;

    case 'logs':
      await logs(flags);
      break;

    case 'login':
      await login(flags);
      break;

    case 'logout':
      logout();
      break;

    case 'whoami':
      whoami({ json: jsonFlag });
      break;

    case 'config':
      switch (action) {
        case 'show':
          configShow();
          break;
        case 'set':
          if (!rest[0] || !rest[1]) {
            console.error('Usage: guuey config set <key> <value>');
            process.exit(1);
          }
          configSet(rest[0], rest[1]);
          break;
        case 'unset':
          if (!rest[0]) {
            console.error('Usage: guuey config unset <key>');
            process.exit(1);
          }
          configUnset(rest[0]);
          break;
        case 'init':
          configInit(flags);
          break;
        default:
          console.error(`Unknown config command: ${action ?? '(none)'}`);
          process.exit(1);
      }
      break;

    case 'apps':
      switch (action) {
        case 'list':
          await appsList({ json: jsonFlag });
          break;
        case 'get':
          await appsGet(rest[0], { json: jsonFlag });
          break;
        case 'create':
          await appsCreate({
            name: flags.name as string | undefined,
            json: jsonFlag,
          });
          break;
        case 'update':
          await appsUpdate(rest[0], {
            name: str(flags.name),
            description: str(flags.description),
            // `--domains` with no value clears the allowlist.
            domains: flags.domains === true ? '' : str(flags.domains),
            authMode: str(flags['auth-mode']),
            issuerUrl: str(flags['issuer-url']),
            audience: str(flags.audience),
            clearAuthConfig: flags['clear-auth-config'] === true,
            widgetEmbedIdentity: str(flags['widget-embed-identity']),
            // Standalone-page branding (guuey#137 slice 3). A bare flag
            // (`--brand-accent` with no value) reads as an explicit clear,
            // same convention as `--domains`.
            brandIconUrl: flags['brand-icon-url'] === true ? '' : str(flags['brand-icon-url']),
            brandOgImageUrl:
              flags['brand-og-image-url'] === true ? '' : str(flags['brand-og-image-url']),
            // Upload flags (guuey#138). A bare flag maps to '' so appsUpdate
            // can refuse it with a usage message instead of dropping it.
            brandIconFile:
              flags['brand-icon-file'] === true ? '' : str(flags['brand-icon-file']),
            brandOgImageFile:
              flags['brand-og-image-file'] === true ? '' : str(flags['brand-og-image-file']),
            brandAccent: flags['brand-accent'] === true ? '' : str(flags['brand-accent']),
            welcomeCopy: flags['welcome-copy'] === true ? '' : str(flags['welcome-copy']),
            identityEndpointUrl:
              flags['identity-endpoint-url'] === true
                ? ''
                : str(flags['identity-endpoint-url']),
            json: jsonFlag,
          });
          break;
        case 'delete':
          await appsDelete(rest[0], { json: jsonFlag });
          break;
        case 'recover':
          await appsRecover(rest[0], { json: jsonFlag });
          break;
        case 'access':
          await appsAccess(rest[0], {
            guests: flags.guests as string | true | undefined,
            guestLimit: flags['guest-limit'] as string | true | undefined,
            json: jsonFlag,
          });
          break;
        case 'publish':
          await appsPublish(rest[0], {
            name: flags.name as string | undefined,
            description: flags.description as string | undefined,
            category: flags.category as string | undefined,
            // No `--icon-url` (guuey#137 slice 3): the icon is app branding —
            // `apps update --brand-icon-url` — because an unlisted share link
            // has no listing to hang one on.
            json: jsonFlag,
          });
          break;
        case 'unpublish':
          await appsUnpublish(rest[0], { json: jsonFlag });
          break;
        case 'byo-user':
          switch (rest[0]) {
            case 'erase':
              await appsByoUserErase(rest[1], {
                sub: flags.sub as string | undefined,
                status: flags.status as string | true | undefined,
                json: jsonFlag,
              });
              break;
            default:
              console.error(`Unknown apps byo-user command: ${rest[0] ?? '(none)'}. Use: erase`);
              process.exit(1);
          }
          break;
        default:
          console.error(
            `Unknown apps command: ${action ?? '(none)'}. Use: list, get, create, update, delete, recover, access, publish, unpublish, byo-user`,
          );
          process.exit(1);
      }
      break;

    case 'widget':
      switch (action) {
        case 'keys':
          switch (rest[0]) {
            case 'create':
              await widgetKeysCreate(rest[1], {
                audience: str(flags.audience),
                json: jsonFlag,
              });
              break;
            case 'rotate':
              await widgetKeysRotate(rest[1], {
                newSecret: flags['new-secret'] === true,
                json: jsonFlag,
              });
              break;
            case 'revoke':
              await widgetKeysRevoke(rest[1], {
                yes: flags.yes === true,
                json: jsonFlag,
              });
              break;
            default:
              console.error(
                `Unknown widget keys command: ${rest[0] ?? '(none)'}. Use: create, rotate, revoke`,
              );
              process.exit(1);
          }
          break;
        default:
          console.error(`Unknown widget command: ${action ?? '(none)'}. Use: keys`);
          process.exit(1);
      }
      break;

    case 'byok':
      switch (action) {
        case 'set':
          await byokSet(flags);
          break;
        case 'list':
          await byokList(flags);
          break;
        case 'remove':
          await byokRemove(flags);
          break;
        default:
          console.error(`Unknown byok command: ${action ?? '(none)'}. Use: set, list, remove`);
          process.exit(1);
      }
      break;

    case 'open':
      open(action);
      break;

    case 'agent':
      switch (action) {
        case 'config':
          await agentConfig(flags);
          break;
        case 'apply':
          await agentApply(flags);
          break;
        case 'status':
          await agentStatus(flags);
          break;
        default:
          console.error(`Unknown agent command: ${action ?? '(none)'}. Use: config, apply, status`);
          process.exit(1);
      }
      break;

    case 'status':
      await status();
      break;

    default:
      console.error(`Unknown command: ${group}`);
      printHelp();
      process.exit(1);
  }
}

main()
  .then(async () => {
    // Show update notice after command completes (non-blocking)
    const latest = await updateCheckPromise;
    if (latest) printUpdateNotice(latest, VERSION);
  })
  .catch(async (err: unknown) => {
    if (err instanceof ApiError) {
      console.error(`✗ API error (${err.status}): ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`✗ ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
    } else {
      console.error(`✗ ${err}`);
    }
    // Still show update notice on error
    const latest = await updateCheckPromise.catch(() => null);
    if (latest) printUpdateNotice(latest, VERSION);
    process.exit(1);
  });
