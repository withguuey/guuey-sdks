/**
 * Pure planning + write-back logic for the `guuey deploy` orchestrator.
 *
 * No I/O — every function here is a straight data transform, testable
 * without touching the filesystem or network. The orchestrator wiring
 * (loading `guuey.json`, calling `deployMcpFromSource`, writing files back
 * to disk) lives in `commands/deploy.ts`, which calls these functions at
 * each step.
 *
 * See `docs/superpowers/specs/2026-07-03-guuey-create-agentic-app-design.md`
 * §7 for the 5-step deploy pipeline this supports.
 */
import { declaredServerEntries, type GuueyAgent, type GuueyJsonV1 } from '@guuey/config';

// ─── Deploy-mode routing ─────────────────────────────────────────────────

/**
 * The two deploy shapes `guuey deploy` dispatches on. `guuey deploy` deploys
 * CODE only; a declarative (no-code) project is applied with `guuey agent
 * apply`, and an app moves from no-code to code once, through `guuey eject`.
 *
 * - `'code-orchestrated'` — the one-command orchestrator (MCP legs → ggui
 *   leg → build-then-pack agent leg). Selected EXPLICITLY: the `--code`
 *   flag or `guuey.json#agent.mode === 'code'`.
 * - `'code-legacy-dockerfile'` — the pre-orchestrator code path for a
 *   user-committed root Dockerfile with no explicit code declaration.
 */
export type DeployMode = 'code-orchestrated' | 'code-legacy-dockerfile';

/** The observable signals `resolveDeployMode` routes on. All I/O-free. */
export interface DeployModeSignals {
  /** `--declarative` flag. */
  forceDeclarative: boolean;
  /** `--code` flag. */
  forceCode: boolean;
  /** `guuey.json` exists in the project root (cwd, not a parent). */
  hasGuueyJson: boolean;
  /** `Dockerfile` exists in the project root. */
  hasDockerfile: boolean;
  /** `package.json` exists in the project root (needed for the worker build). */
  hasPackageJson: boolean;
  /** `guuey.json#agent.mode` — only from the ROOT guuey.json, undefined otherwise. */
  agentMode: 'code' | 'declarative' | undefined;
}

/**
 * Discriminated routing outcome — a code mode to dispatch, a declarative
 * project (deploy refuses it and names `guuey agent apply`, see
 * {@link declarativeRedirect}), or an actionable error.
 */
export type DeployModeDecision =
  | { kind: 'mode'; mode: DeployMode }
  | { kind: 'declarative' }
  | { kind: 'error'; message: string };

/**
 * Decide which deploy shape to run — made ONCE, dispatched on directly
 * (never re-derived from raw signals a second time).
 *
 * Routing rules:
 * - `--declarative`, or `guuey.json#agent.mode === 'declarative'`, is a
 *   no-code project: `guuey deploy` refuses it. The declaration in guuey.json
 *   wins over `--code` (an app goes code through `guuey eject`, never by a
 *   flag on a no-code project).
 * - `--code` / `agent.mode: 'code'` route to the orchestrator even when a
 *   Dockerfile is present.
 * - Absent `agent.mode`: a root Dockerfile keeps the legacy code path
 *   (pre-existing behavior, even alongside a guuey.json); a guuey.json
 *   alone is a no-code project (e.g. a `guuey pull`'d Studio agent).
 *   `package.json` presence is NOT a routing signal.
 * - The orchestrated code path requires a root `package.json` (the CLI
 *   runs `pnpm build` to produce `guuey.worker.js`) — checked
 *   here so the failure is an early named error, not a confusing build
 *   crash.
 */
export function resolveDeployMode(s: DeployModeSignals): DeployModeDecision {
  if (s.forceDeclarative || s.agentMode === 'declarative') {
    return { kind: 'declarative' };
  }

  // Explicit code declaration: the --code flag, or guuey.json#agent.mode.
  if (s.forceCode || s.agentMode === 'code') {
    if (s.hasGuueyJson) {
      if (!s.hasPackageJson) {
        return {
          kind: 'error',
          message:
            'Code-mode deploy requires a package.json in the project root — the CLI runs ' +
            '"pnpm build" to produce guuey.worker.js before packing. ' +
            'Run "guuey create" to scaffold a worker project, or commit a root Dockerfile ' +
            'for the legacy image path.',
        };
      }
      return { kind: 'mode', mode: 'code-orchestrated' };
    }
    // --code without a guuey.json (agent.mode implies hasGuueyJson).
    if (s.hasDockerfile) {
      return { kind: 'mode', mode: 'code-legacy-dockerfile' };
    }
    return {
      kind: 'error',
      message:
        '--code requires either a guuey.json worker project (with a package.json whose build ' +
        'produces guuey.worker.js — run "guuey create" to scaffold one) or a root Dockerfile ' +
        'for the legacy image path.',
    };
  }

  // No explicit declaration — infer.
  if (s.hasDockerfile) {
    return { kind: 'mode', mode: 'code-legacy-dockerfile' };
  }
  if (s.hasGuueyJson) {
    return { kind: 'declarative' };
  }
  return {
    kind: 'error',
    message:
      'No guuey.json or Dockerfile found in the project root.\n' +
      '  - Code-mode agents: run "guuey create" (scaffolds guuey.json + a buildable worker), then "guuey deploy".\n' +
      '  - No-code agents: "guuey pull --app-id <id>" writes guuey.json, then "guuey agent apply".',
  };
}

/** The `guuey deploy` flags a declarative project's redirect translates. */
export interface DeclarativeRedirectFlags {
  appId?: string;
  envFile?: string;
  size?: string;
  maxPods?: string;
  runtimeAutoUpdate?: string;
  label?: string;
}

/**
 * What `guuey deploy` prints when it refuses a declarative (no-code)
 * project: the ready-to-run `guuey agent apply` line built from the flags
 * the builder passed, where each no-code knob now lives, and the one door to
 * code mode. Pure, so every line is pinned by `deploy-plan.test.ts`.
 *
 * - `--app-id` / `--env-file` carry onto `agent apply` unchanged.
 * - `--size` lives in guuey.json `agent.deploy.size`: the deploy door sizes a
 *   no-code build from it when the request carries no size (guuey#193).
 * - `--max-pods` / `--runtime-auto-update` live on `guuey agent config`
 *   (the live knob, no redeploy).
 * - `--label` has no no-code home: apply records provenance instead.
 * - `--wait` keeps deploy's old "poll until live" behavior.
 */
export function declarativeRedirect(f: DeclarativeRedirectFlags): string {
  const apply = ['guuey agent apply --wait'];
  if (f.appId !== undefined) apply.push(`--app-id ${f.appId}`);
  if (f.envFile !== undefined) apply.push(`--env-file ${f.envFile}`);
  const lines = [
    'guuey deploy deploys code-mode apps. This project is declarative (no-code), so its command is guuey agent apply:',
    '',
    `  ${apply.join(' ')}`,
  ];
  const knobs: string[] = [];
  if (f.maxPods !== undefined) knobs.push(`--max-pods ${f.maxPods}`);
  if (f.runtimeAutoUpdate !== undefined) knobs.push(`--runtime-auto-update ${f.runtimeAutoUpdate}`);
  if (knobs.length > 0) {
    lines.push(`  guuey agent config${f.appId !== undefined ? ` --app-id ${f.appId}` : ''} ${knobs.join(' ')}`);
  }
  if (f.size !== undefined) {
    lines.push('', `  Pod size lives in guuey.json: set "deploy": { "size": "${f.size}" } under "agent", then apply.`);
  }
  if (f.label !== undefined) {
    lines.push(
      '',
      '  --label is for code-mode builds. A no-code build records where it came from instead: guuey agent apply --provenance <org/repo>@<sha> (the default reads git).',
    );
  }
  lines.push(
    '',
    `To switch this app to code mode for good, run: guuey eject${f.appId !== undefined ? ` --app-id ${f.appId}` : ''}`,
  );
  return lines.join('\n');
}

/**
 * The agent mode of the build that is serving right now: the newest
 * (highest `buildNumber`) row whose status is `'live'`, or `null` when
 * nothing is live. Reads the `GET /apps/:id/deployments` rows, whose
 * `agentMode` and `status` every served door carries.
 */
export function liveAgentMode(
  deployments: ReadonlyArray<{ buildNumber: number; status: string; agentMode: 'code' | 'nocode' }>,
): 'code' | 'nocode' | null {
  let newest: { buildNumber: number; agentMode: 'code' | 'nocode' } | null = null;
  for (const d of deployments) {
    if (d.status !== 'live') continue;
    if (newest === null || d.buildNumber > newest.buildNumber) newest = d;
  }
  return newest === null ? null : newest.agentMode;
}

/**
 * Why `guuey deploy` refuses a code deploy onto an app whose live build is
 * no-code: that deploy would switch the app to code mode for good, and the
 * switch is `guuey eject`'s alone, behind its confirmation.
 */
export function nocodeLiveRefusal(appId: string): string {
  return (
    `App ${appId} is live on guuey's no-code runtime. A code deploy would switch it to code mode for good, ` +
    `so guuey deploy will not do it on its own.\n` +
    `  To switch, run: guuey eject --app-id ${appId}\n` +
    `  To keep it no-code, edit its definition and run: guuey agent apply`
  );
}

/**
 * Whether `guuey deploy` may open the interactive first-run "create + link
 * an app" prompt when no app is linked. Only the code-orchestrated shape
 * offers it (the plan's "first run offers apps create + link" is scoped to
 * the new orchestrator), and only on a real terminal — a non-TTY invocation
 * (CI, piped) must fail fast with the actionable "run guuey create / guuey
 * link" error instead of hanging on a readline prompt.
 */
export function shouldOfferAppCreate(
  mode: DeployMode,
  stdinIsTTY: boolean | undefined,
  stdoutIsTTY: boolean | undefined,
): boolean {
  return mode === 'code-orchestrated' && stdinIsTTY === true && stdoutIsTTY === true;
}

/**
 * The "no app linked" remedy `guuey deploy` prints when it will NOT open
 * the create prompt (guuey#1064). The interactive-terminal sentence is
 * true only where {@link shouldOfferAppCreate} can ever say yes — the
 * code-orchestrated shape. A legacy Dockerfile project
 * following it would loop: auto-create never offers there, so it is told
 * the doors that exist for it instead. Pure, so the two sentences are
 * pinned by `deploy-plan.test.ts` and never drift apart again.
 */
export function noAppLinkedRemedy(mode: DeployMode): string {
  const bind = 'Set "appId" in guuey.json, pass --app-id <id>, run "guuey pull --app-id <id>" to bind an existing app';
  return mode === 'code-orchestrated'
    ? `${bind}, or run "guuey deploy" in an interactive terminal to create one.`
    : `${bind}, or create one with "guuey apps create --name <name>" and put its id in guuey.json.`;
}

/**
 * One hosted MCP server that needs a `deployMcpFromSource` leg — an
 * `agent.mcpServers` entry with `kind: 'hosted'` and a `source` (build
 * recipe). Entries with only `server` (no `source`) are already fully
 * resolved by a prior deploy and need no leg at all — `planMcpLegs` omits
 * them entirely, not just flags them.
 */
export interface McpLeg {
  /** The `agent.mcpServers` key — used for write-back, NOT the deployed server name. */
  name: string;
  /** Source directory, relative to `guuey.json`'s directory. */
  source: string;
  /** Whether this entry already carries a resolved `server` id from a prior deploy. */
  hasServerId: boolean;
}

/**
 * List every `hosted` + `source` entry in `agent.mcpServers` as a deploy
 * leg. Entries with `server` set but no `source` need no leg (nothing to
 * build/re-deploy) and are omitted. Entries with both `server` and
 * `source` (post-write-back re-deploys) ARE included — `hasServerId: true`
 * — because the orchestrator re-deploys them too (same-name reuse-or-create
 * ships a new version of the same server).
 */
export function planMcpLegs(agent: GuueyAgent): McpLeg[] {
  const servers = agent.mcpServers;
  if (!servers) return [];

  const legs: McpLeg[] = [];
  // `declaredServerEntries` filters the `ggui: false` opt-out (guuey#24) — not a
  // server, so never a deploy leg.
  for (const [name, entry] of declaredServerEntries(servers)) {
    if (entry.kind !== 'hosted') continue;
    if (entry.source === undefined) continue;
    legs.push({ name, source: entry.source, hasServerId: entry.server !== undefined });
  }
  return legs;
}

/**
 * Set `agent.mcpServers[name].server = serverId` on a copy of `doc`,
 * preserving every other field on that entry (`source`, `devPort`) and
 * leaving `doc` itself untouched. Throws if `name` isn't a `hosted`
 * `mcpServers` entry — the orchestrator only ever calls this right after a
 * successful `deployMcpFromSource` for a leg `planMcpLegs` produced, so a
 * missing/wrong-kind entry means a caller bug, not a runtime condition to
 * swallow.
 */
export function writeBackServerId(
  doc: GuueyJsonV1,
  name: string,
  serverId: string,
): GuueyJsonV1 {
  const servers = doc.agent.mcpServers;
  const entry = servers?.[name];
  if (entry === undefined) {
    throw new Error(`writeBackServerId: no mcpServers entry named "${name}"`);
  }
  if (entry === false) {
    throw new Error(
      `writeBackServerId: mcpServers entry "${name}" is the generative-UI opt-out (\`ggui: false\`), not a deployable server`,
    );
  }
  if (entry.kind !== 'hosted') {
    throw new Error(`writeBackServerId: mcpServers entry "${name}" is not hosted (kind: ${entry.kind})`);
  }

  return {
    ...doc,
    agent: {
      ...doc.agent,
      mcpServers: {
        ...servers,
        [name]: { ...entry, server: serverId },
      },
    },
  };
}

/**
 * Assert every `hosted` `mcpServers` entry in `doc` carries a resolved
 * `server` id, returning `doc` unchanged on success. Throws — naming every
 * offending entry — when one or more hosted entries have no `server` yet.
 *
 * This is the client-side mirror of the deploy-controller's
 * `resolve-mcp.ts` guard (`hosted MCP "<name>": 'source' ... resolution
 * lands in T5.1`): the agent-leg snapshot must never carry an unresolved
 * `source`-only hosted ref, because the pod can't reach a server by source
 * path. The orchestrator calls this right before building the deploy
 * snapshot, after every `planMcpLegs` entry has been deployed +
 * written back — so a throw here means a caller-side bug (a leg was
 * skipped or its write-back was lost), not an expected runtime failure.
 */
export function snapshotWithServerIds(doc: GuueyJsonV1): GuueyJsonV1 {
  const servers = doc.agent.mcpServers;
  if (!servers) return doc;

  // `declaredServerEntries` filters the `ggui: false` opt-out (guuey#24) — not a
  // server, so it can never be an unresolved hosted ref.
  const offenders = declaredServerEntries(servers)
    .filter(([, entry]) => entry.kind === 'hosted' && entry.server === undefined)
    .map(([name]) => name);

  if (offenders.length > 0) {
    throw new Error(
      `hosted mcpServers entries missing a resolved "server" id: ${offenders.join(', ')} ` +
        '(the MCP leg should have deployed + written this back before the agent leg ran)',
    );
  }
  return doc;
}
