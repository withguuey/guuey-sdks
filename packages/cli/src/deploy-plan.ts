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
import type { GuueyAgent, GuueyJsonV1 } from '@guuey/config';

// ─── Deploy-mode routing ─────────────────────────────────────────────────

/**
 * The three deploy shapes `guuey deploy` dispatches on:
 *
 * - `'code-orchestrated'` — the one-command orchestrator (MCP legs → ggui
 *   leg → build-then-pack agent leg). Selected EXPLICITLY: the `--code`
 *   flag or `guuey.json#agent.mode === 'code'`.
 * - `'code-legacy-dockerfile'` — the pre-orchestrator code path for a
 *   user-committed root Dockerfile with no explicit code declaration.
 * - `'declarative'` — snapshot-only POST, stock nocode-runtime pod.
 */
export type DeployMode = 'declarative' | 'code-orchestrated' | 'code-legacy-dockerfile';

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

/** Discriminated routing outcome — a mode to dispatch, or an actionable error. */
export type DeployModeDecision =
  | { kind: 'mode'; mode: DeployMode }
  | { kind: 'error'; message: string };

/**
 * Decide which deploy shape to run — made ONCE, dispatched on directly
 * (never re-derived from raw signals a second time).
 *
 * Routing rules (Task 13 review, controller-decided):
 * - Flags win: `--declarative` / `--code` (mutually exclusive).
 * - `agent.mode` in `guuey.json` is the explicit per-project declaration:
 *   `'code'` routes to the orchestrator even when a Dockerfile is present;
 *   `'declarative'` routes declarative even when a Dockerfile is present.
 * - Absent `agent.mode`: a root Dockerfile keeps the legacy code path
 *   (pre-existing behavior, even alongside a guuey.json); a guuey.json
 *   alone is declarative. `package.json` presence is NOT a routing signal.
 * - The orchestrated code path requires a root `package.json` (the CLI
 *   runs `corepack pnpm build` to produce `guuey.worker.js`) — checked
 *   here so the failure is an early named error, not a confusing build
 *   crash.
 */
export function resolveDeployMode(s: DeployModeSignals): DeployModeDecision {
  if (s.forceDeclarative && s.forceCode) {
    return { kind: 'error', message: 'Cannot pass both --declarative and --code. Pick one.' };
  }

  if (s.forceDeclarative) {
    if (!s.hasGuueyJson) {
      return {
        kind: 'error',
        message: '--declarative requires a guuey.json in the project root.',
      };
    }
    return { kind: 'mode', mode: 'declarative' };
  }

  // Explicit code declaration: the --code flag, or guuey.json#agent.mode.
  if (s.forceCode || s.agentMode === 'code') {
    if (s.hasGuueyJson) {
      if (!s.hasPackageJson) {
        return {
          kind: 'error',
          message:
            'Code-mode deploy requires a package.json in the project root — the CLI runs ' +
            '"corepack pnpm build" to produce guuey.worker.js before packing. ' +
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

  if (s.agentMode === 'declarative') {
    return { kind: 'mode', mode: 'declarative' };
  }

  // No explicit declaration — infer.
  if (s.hasDockerfile) {
    return { kind: 'mode', mode: 'code-legacy-dockerfile' };
  }
  if (s.hasGuueyJson) {
    return { kind: 'mode', mode: 'declarative' };
  }
  return {
    kind: 'error',
    message:
      'No guuey.json or Dockerfile found in the project root.\n' +
      '  - Declarative agents: add a guuey.json.\n' +
      '  - Code-mode agents: run "guuey create" (scaffolds guuey.json + a buildable worker).',
  };
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
  for (const [name, entry] of Object.entries(servers)) {
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
  if (!entry) {
    throw new Error(`writeBackServerId: no mcpServers entry named "${name}"`);
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

  const offenders = Object.entries(servers)
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
