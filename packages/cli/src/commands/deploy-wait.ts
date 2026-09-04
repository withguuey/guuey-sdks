/**
 * How long a deploy command waits for a build to go live, and what it says
 * when the wait runs out (guuey#759 — the CLI face of guuey#754).
 *
 * The controller gives a NEW node up to `DEFAULT_NODE_PROVISION_BUDGET_MS`
 * (10 min, `backend/services/deploy-controller/src/k8s/agent-deployment.ts`)
 * before it calls a deploy unschedulable, then the pod pulls, boots and
 * passes readiness, then the row flips `live`. A client that stops waiting
 * BEFORE that budget elapses tells the builder a green deploy failed: on
 * dev a `--size lg` deploy that needed a fresh bin was Ready at 2 min 53 s
 * and `live` ~18 min after start, while the CLI's 7-minute wait had already
 * printed "✗ Deploy timed out" and exited 1 (QA, 2026-09-04). So:
 *
 *   - every deploy path waits {@link DEPLOY_WAIT_MS}, which is never shorter
 *     than the controller's budget plus readiness + rollout slack — the
 *     controller's constant is MIRRORED here (this package is published and
 *     cannot import the controller) and the controller's
 *     `deploy-wait.sync.test.ts` pins the mirror;
 *   - when the wait runs out the CLI never says "timed out": the platform
 *     keeps going, so the command says so and exits 0 — only a row that
 *     reaches `failed` (or `superseded`) is a failure exit.
 */

/** MIRROR of the controller's `DEFAULT_NODE_PROVISION_BUDGET_MS` — pinned by its sync test. */
export const NODE_PROVISION_BUDGET_MS = 10 * 60 * 1000;

/**
 * Image pull + boot + readiness after the pod is scheduled, plus rollout
 * slack for a multi-pod app under `maxUnavailable: 0`.
 */
export const READINESS_AND_ROLLOUT_SLACK_MS = 12 * 60 * 1000;

/** The one client-side wait, every deploy path (22 minutes today). */
export const DEPLOY_WAIT_MS = NODE_PROVISION_BUDGET_MS + READINESS_AND_ROLLOUT_SLACK_MS;

/** The line every path prints when {@link DEPLOY_WAIT_MS} elapses without a terminal status. */
export function stillDeployingMessage(waitedMs: number): string {
  const minutes = Math.round(waitedMs / 60_000);
  return (
    `  Still deploying after ${minutes} minutes — the platform keeps going. ` +
    'Run "guuey deployments list" to watch it; the app goes live on its own.'
  );
}
