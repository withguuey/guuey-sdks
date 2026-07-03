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
