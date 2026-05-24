/**
 * Guuey hosted control-plane types — agent sizing, deployment
 * lifecycle, and the streaming events Guuey's backend emits during
 * deploys.
 *
 * These types describe Guuey hosting concerns: `DeployTarget`
 * includes the `'ggui'` vendor literal, `DeployEvent` is streamed by
 * Guuey's AppSync subscription, and `HostingConfig` is a shape on
 * `guuey.json`. They lived in `@ggui-ai/protocol` until 2026-04-18
 * as a historical artefact — they were never vendor-neutral wire
 * types. Relocated here as part of the overlay-type cleanup in the
 * two-file manifest model. See
 * `docs/plans/2026-04-17-ggui-oss-split.md` §8 for the lock.
 *
 * Open packages must not import from this module. Consumers today
 * are all closed (`@guuey-private/types`, `cloud/`). If an open
 * package ever needs one of these types, re-evaluate the
 * classification before adding the import — most likely the open
 * code should not depend on hosted-control-plane shapes at all.
 */

/**
 * Agent container size — describes workload intensity.
 * Developers pick a size; Guuey maps it to CPU/memory internally.
 *
 * Exported as a tuple so `schema.ts` can reuse the same canonical list
 * when building the `deploy.size` zod enum. Keeping one source of truth
 * for the literal set avoids the two drifting — the hosting type and
 * the `guuey.json` overlay must always agree on what sizes exist.
 */
export const AGENT_SIZES = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
export type AgentSize = (typeof AGENT_SIZES)[number];

/**
 * Deployment target — where the agent runs. `'ggui'` is the Guuey
 * hosted platform; the other literals are recognised but not
 * first-party.
 */
export type DeployTarget = 'ggui' | 'fly' | 'railway' | 'self';

/**
 * Deployment lifecycle status — superset of all states.
 *
 * Transient states (building, pushing, deploying, health_checking)
 * exist only in {@link DeployEvent} streams. The backend stores only
 * settled states (not_deployed, live, failed, stopped, rolled_back).
 * The persisted enum is intentionally narrower.
 */
export type DeploymentStatus =
  | 'not_deployed'
  | 'building'
  | 'pushing'
  | 'deploying'
  | 'health_checking'
  | 'live'
  | 'failed'
  | 'stopped'
  | 'rolled_back';

/**
 * Progress event emitted during deployment.
 * Streamed to CLI and Platform Dashboard via AppSync subscription.
 */
export interface DeployEvent {
  /** App being deployed */
  appId: string;
  /** Unique build identifier */
  buildId: string;
  /** Current deployment phase */
  status: DeploymentStatus;
  /** Human-readable progress message */
  message: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Deployment version number (set when deploying or later) */
  version?: number;
  /** Live endpoint URL (set when status = 'live') */
  url?: string;
  /** Error details (set when status = 'failed') */
  error?: string;
}

/**
 * Hosting configuration field in `guuey.json`.
 */
export interface HostingConfig {
  /** Agent container size (default: 'xs' for free, 'sm' for paid) */
  size?: AgentSize;
  /** Deployment target (default: 'ggui') */
  target?: DeployTarget;
}
