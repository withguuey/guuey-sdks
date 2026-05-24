#!/usr/bin/env node
/**
 * guuey CLI -- command-line interface for the guuey platform.
 *
 * Provides authentication, app management, project configuration, and
 * type generation from the terminal.
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
import { appsList, appsGet, appsCreate, appsUpdate, appsDelete, appsRecover } from './commands/apps';
import { status } from './commands/status';
import { typegen } from './commands/typegen';
import { login } from './commands/login';
import { logout } from './commands/logout';
import { whoami } from './commands/whoami';
import { open } from './commands/open';
import { create } from './commands/create';
import { deleteApp } from './commands/delete';
import { dev } from './commands/dev';
import { link } from './commands/link';
import { test as testCmd } from './commands/test';
import { logs } from './commands/logs';
import { deploy } from './commands/deploy';
import { pull } from './commands/pull';
import { undeploy } from './commands/undeploy';
import { stop, start, restart } from './commands/agent-lifecycle';
import { envSet, envList, envUnset } from './commands/env';
import { byokSet, byokList, byokRemove } from './commands/byok';
import { deploymentsList, deploymentsRollback, deploymentsLogs } from './commands/deployments';
import { agentConfig } from './commands/agent';
import { domainsAdd, domainsList, domainsVerify, domainsRemove } from './commands/domains';
import { slugClaim } from './commands/slug';
import { ApiError } from './client';
import { printWelcome, printQuickGuide } from './logo';
import { checkForUpdate, printUpdateNotice } from './update-check';
import { existsSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from './paths';

declare const __CLI_VERSION__: string;

const VERSION = typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : '0.0.1';

// Start update check in background (non-blocking)
const updateCheckPromise = checkForUpdate(VERSION).catch(() => null);

// ─── Minimal arg parser ──────────────────────────────────────────────

/**
 * Parse CLI arguments into positional commands and named flags.
 *
 * Flags starting with `--` are extracted as key-value pairs. A flag followed
 * by a non-flag value is treated as `key=value`; otherwise it is `key=true`.
 *
 * @param argv - Raw argument list (typically `process.argv.slice(2)`)
 * @returns Parsed `command` positional args and `flags` key-value map
 */
function parseArgs(argv: string[]): {
  command: string[];
  flags: Record<string, string | true>;
} {
  const command: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      command.push(arg);
    }
  }

  return { command, flags };
}

// ─── Help text ───────────────────────────────────────────────────────

/** Print the full CLI help text to stdout. */
function printHelp(): void {
  console.log(`guuey CLI v${VERSION}

Usage: guuey <command> [options]

Agent Development:
  create [name]                  Create a new guuey agent project
    --framework <f>              Framework: claude-agent-sdk | openai-agents-sdk | google-adk | vanilla
    --target <dir>               Output directory (default: ./<name>)
  delete [appId]                 Delete a guuey app from the platform
    --force                      Skip confirmation prompt
  dev                            Start agent server locally (with hot reload)
    --port <port>                Port (default: 3000)
    --entry <file>               Entry file (default: src/index.ts)
  link                           Connect an existing agent to guuey platform
    --url <endpoint>             Agent endpoint URL
    --name <name>                App name
  test <message>                 Send a test message and print agent response
    --session <id>               Reuse existing session
  logs                           Fetch deployment logs for your agent
    --since <duration>           Time window (default: 1h). Examples: 30m, 2h, 1d
    --tail <n>                   Number of lines from end (default: 500)
    --follow, -f                 Live tail (Ctrl+C to stop)
  deploy                         Deploy agent to guuey hosting (auto-detects
                                 declarative vs code mode)
    --declarative                Force declarative mode (uses agent.json)
    --code                       Force code mode (uses Dockerfile)
    --force                      Force deploy even if unchanged
    --size <s>                   Runtime pod size: xs | sm | md | lg | xl (default: sm)
    --build-size <s>             Build Job size: sm | md | lg | xl (default: md, code-mode only)
    --label <tag>                Version label (e.g., v1.0, release-candidate)
  pull                           Refresh guuey.json from hosted state
    --app-id <id>                Override the resolved appId
  undeploy                       Tear down deployed agent (keeps app)
    --app-id <id>                Target a specific app
  stop                           Pause deployed agent (scale to 0)
  start                          Resume stopped agent
  restart                        Rolling restart of agent pods
    --app-id <id>                Target a specific app (all lifecycle commands)
  env set KEY=VALUE              Set environment variables
  env list                       List environment variables
  env unset KEY                  Remove environment variables
  deployments [list]             List deployment builds
  deployments rollback [build]   Rollback to a previous build number
  domains add <domain>           Add custom domain (CNAME required)
  domains list                   List configured domains
  domains verify <domain>        Re-verify CNAME for pending domain
  domains remove <domain>        Remove custom domain
  slug claim <slug>              Claim a public slug ({slug}.agents.<env>)

Authentication:
  login                         Log in via browser (opens auth page)
  login --token <pat>           Log in with a Personal Access Token (headless)
  logout                        Clear stored credentials
  whoami                        Show current authenticated user

Apps:
  apps create                   Create a new app (auto-login if needed)
    --name <name>               App name (required)
    --auth-mode <mode>          Auth mode (default: anonymous)
  apps list                     List your apps
  apps get [appId]              Show app details
  apps update [appId]           Update app configuration
    --name <name>               App name
    --auth-mode <mode>          Auth mode (anonymous|cognito|byo)
    --styling-prompt <prompt>   Styling prompt
    --webhook-url <url>         Webhook URL
    --rate-limit <n>            Rate limit per minute
    --domains <d1,d2>           Allowed domains (comma-separated)
  apps delete [appId]           Delete an app

BYOK (Bring Your Own Key):
  byok set                      Store a provider API key
    --provider <name>           Provider: anthropic | openai | google | bedrock | openrouter
    --key <value>               API key value
  byok list                     List configured provider keys
  byok remove                   Remove a provider key
    --provider <name>           Provider to remove

Configuration:
  config show                   Show resolved configuration
  config set <key> <value>      Set a config value (host, api-key, app-id)
  config unset <key>            Remove a global config value
  config init                   Create guuey.json in the current directory

Type Generation:
  typegen                       Generate TypeScript types from predefined blueprints
    --out <file>                Output file path (default: stdout)
    --path <dir>                Custom blueprints directory

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

Project Config (guuey.json):
  Place a guuey.json in your project root. Non-secret settings
  (appId, host, bridgeUrl) are merged with global config (project
  takes precedence). Run 'guuey config init' to create one.

Examples:
  guuey apps create --name "My Agent App"
  guuey deploy
  guuey open dashboard
  guuey config init
  guuey typegen --out ggui-blueprints.d.ts
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
          await deploymentsList({ json: jsonFlag });
          break;
        case 'rollback':
          await deploymentsRollback(rest[0], flags);
          break;
        case 'logs':
          await deploymentsLogs(rest[0], { json: jsonFlag });
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

    case 'slug':
      switch (action) {
        case 'claim':
          await slugClaim(rest[0], flags);
          break;
        default:
          console.error(`Unknown slug command: ${action ?? '(none)'}. Use: claim <slug>`);
          process.exit(1);
      }
      break;

    case 'env':
      switch (action) {
        case 'set':
          await envSet(rest, flags);
          break;
        case 'list':
          await envList({ json: jsonFlag });
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

    case 'link':
      await link(flags);
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
            authMode: flags['auth-mode'] as string | undefined,
            json: jsonFlag,
          });
          break;
        case 'update':
          await appsUpdate(rest[0], {
            name: flags.name as string | undefined,
            authMode: flags['auth-mode'] as string | undefined,
            stylingPrompt: flags['styling-prompt'] as string | undefined,
            webhookUrl: flags['webhook-url'] as string | undefined,
            rateLimit: flags['rate-limit'] as string | undefined,
            domains: flags.domains as string | undefined,
            json: jsonFlag,
          });
          break;
        case 'delete':
          await appsDelete(rest[0], { json: jsonFlag });
          break;
        case 'recover':
          await appsRecover(rest[0], { json: jsonFlag });
          break;
        default:
          console.error(`Unknown apps command: ${action ?? '(none)'}`);
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

    case 'typegen':
      typegen(flags);
      break;

    case 'open':
      open(action);
      break;

    case 'agent':
      switch (action) {
        case 'config':
          await agentConfig(flags);
          break;
        default:
          console.error(`Unknown agent command: ${action ?? '(none)'}. Use: config`);
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
