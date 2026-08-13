/**
 * guuey agent -- Agent hosting management commands.
 *
 * Subcommands:
 *   config                     Show the app's scaling config
 *   config --max-pods <n>      Set the app's replica count
 *
 * Usage:
 *   guuey agent config                 # Show maxPods + the ceiling it is gated at
 *   guuey agent config --max-pods 3    # Scale a LIVE app, no redeploy
 *   guuey agent config --json          # Machine-readable (either mode)
 *
 * Backed by `GET|PATCH /v1/apps/:id/config` (scaling S1-F4, guuey#162) —
 * the route this command was gated behind `notYetAvailable` waiting for. A
 * PATCH lands without a redeploy: the deploy-controller's tier-sweep reads
 * `AppBilling.maxPods` on its 5-min converge pass and patches `spec.replicas`
 * toward it. The same knob also rides `guuey deploy --max-pods`.
 *
 * The ceiling is the SERVER's to name — plan tier, or an admin per-app raise
 * — so this validates only "positive integer" and prints the ceiling from
 * the response rather than hardcoding one (the old dormant body's 1..10 was
 * a guess that matched no tier).
 *
 * Pod size and idle timeout are deliberately NOT here: size is a per-deploy
 * choice (`guuey deploy --size`, shown by `guuey deployments`), and neither
 * has a config route. One knob, one contract.
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import { apiRequest, parseApiError } from '../deploy-shared';
import * as out from '../output';

/**
 * MIRROR of `@guuey-private/cli-wire#AgentConfigWire` — the `GET|PATCH
 * /v1/apps/:id/config` response. Hand-mirrored rather than imported (the
 * wire package is private, this one is published npm); pinned against the
 * wire source by `wire-sync.test.ts`. See `../wire-mirror-parse.ts`.
 */
export interface AgentConfig {
  appId: string;
  /** The persisted knob; `null` = unset, which the platform runs as 1 replica. */
  maxPods: number | null;
  /** The ceiling the next write is gated at (tier limit, or an admin raise). */
  maxPodsCeiling: number;
  /** The effective tier the ceiling derives from (admin raise aside). */
  tier: string;
  /** Resolved runtime-update posture — absent knob reads back `true`
   * (the platform-timed default); only a stored `false` reads `false`. */
  runtimeAutoUpdate: boolean;
  /** Read-only: the runtime digest the latest LIVE build renders, or
   * `null` before the controller has stamped one. */
  runtimeImageDigest: string | null;
}

/**
 * Handle the `guuey agent config` command.
 *
 * No update flags: GET the config and display it. With `--max-pods`: PATCH
 * it, then display the server's readback (never the requested value — the
 * readback is what actually persisted).
 */
export async function agentConfig(
  flags: Record<string, string | true>,
): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey pull --app-id <id>" to bind an existing app, or "guuey create" to scaffold a new project first.');
    process.exit(1);
  }

  if (!config.apiUrl) {
    out.error('REST API URL not configured. Ensure amplify_outputs.json is present or set GUUEY_API_URL.');
    process.exit(1);
  }

  const json = flags.json === true;
  const maxPodsFlag = flags['max-pods'];
  const autoUpdateFlag = flags['runtime-auto-update'];

  if (maxPodsFlag === undefined && autoUpdateFlag === undefined) {
    await showConfig(auth.pat, config, appId, json);
    return;
  }

  const patch: { maxPods?: number; runtimeAutoUpdate?: boolean } = {};
  if (maxPodsFlag !== undefined) {
    const maxPods = maxPodsFlag === true ? NaN : Number(maxPodsFlag);
    if (!Number.isInteger(maxPods) || maxPods < 1) {
      out.error('--max-pods must be a positive integer (e.g. --max-pods 3).');
      process.exit(1);
    }
    patch.maxPods = maxPods;
  }
  if (autoUpdateFlag !== undefined) {
    if (autoUpdateFlag !== 'on' && autoUpdateFlag !== 'off') {
      out.error('--runtime-auto-update takes "on" or "off" (e.g. --runtime-auto-update off pins the runtime at its last deploy).');
      process.exit(1);
    }
    patch.runtimeAutoUpdate = autoUpdateFlag === 'on';
  }

  const res = await apiRequest(auth.pat, config, 'PATCH', `/apps/${appId}/config`, patch);

  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    // A 409 here is AGENT_MAX_PODS (over the ceiling) or
    // COLOCATED_STATE_UNARMED (durable state off for this env) — both name
    // the actual constraint in their message, and `parseApiError` prefixes
    // the code so the failure is greppable.
    out.error(parseApiError(data, `Config update failed: HTTP ${res.status}`));
    process.exit(1);
  }

  const updated = (await res.json()) as AgentConfig;
  if (json) {
    out.json(updated);
    return;
  }
  if (patch.maxPods !== undefined) out.success(`Max pods set to ${updated.maxPods ?? 1}.`);
  if (patch.runtimeAutoUpdate !== undefined) {
    out.success(
      updated.runtimeAutoUpdate
        ? 'Runtime updates: automatic — the platform keeps this agent on the current runtime.'
        : 'Runtime updates: pinned — this agent stays on its deploy-time runtime until you deploy again or turn auto-update back on.',
    );
  }
  printConfig(updated);
  console.log('');
  console.log('  Takes effect without a redeploy — the controller converges within ~5 minutes.');
}

/** GET + render the app's current config. */
async function showConfig(
  pat: string,
  config: { apiUrl?: string },
  appId: string,
  json: boolean,
): Promise<void> {
  const res = await apiRequest(pat, config, 'GET', `/apps/${appId}/config`);

  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    out.error(parseApiError(data, `Failed to fetch config: HTTP ${res.status}`));
    process.exit(1);
  }

  const current = (await res.json()) as AgentConfig;
  if (json) {
    out.json(current);
    return;
  }

  console.log('Agent Hosting Configuration');
  console.log('');
  printConfig(current);
}

/**
 * Render the wire as-is. `maxPods: null` prints as 1 — that IS the running
 * replica count for an unset knob — with `(default)` so the reader can tell
 * the two apart before running `--max-pods 1` and seeing nothing change.
 *
 * Ceiling and plan print on separate lines on purpose: the ceiling may come
 * from an admin per-app raise rather than the plan, and the wire does not
 * say which, so "3 (free plan)" would be a claim this command cannot make.
 */
function printConfig(wire: AgentConfig): void {
  const pods = wire.maxPods === null ? '1 (default)' : String(wire.maxPods);
  console.log(`  Max Pods:        ${pods}`);
  console.log(`  Ceiling:         ${wire.maxPodsCeiling}`);
  console.log(`  Plan:            ${wire.tier}`);
  console.log(
    `  Runtime updates: ${wire.runtimeAutoUpdate ? 'automatic (default)' : 'pinned to deploy'}`,
  );
  if (wire.runtimeImageDigest) {
    console.log(`  Runtime digest:  ${wire.runtimeImageDigest}`);
  }
}
