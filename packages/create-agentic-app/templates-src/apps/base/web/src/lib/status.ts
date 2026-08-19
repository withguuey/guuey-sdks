/**
 * Live-ness probe for the Home page.
 *
 * Probes the agent's own `/healthz` from the browser — the pod's CORS
 * admits the app's allowed domains (plus localhost in dev), so this works
 * exactly where the chat itself works. The platform's richer status API is
 * credentialed and guuey-origin-CORS'd, so the CLI is the tool for detail:
 * `pnpm status` runs `guuey apps get` + `guuey agent status`.
 */
import { agentEndpointUrl, isLinked } from "../config";

export type AgentProbe =
  | { state: "checking" }
  | { state: "reachable" }
  | {
      /**
       * Calm, honest failure: a fresh clone before `bootstrap --link` (or a
       * dev session without `pnpm dev` running) is ALWAYS in this state —
       * it is a setup stage, not an error.
       */
      state: "unreachable";
      hint: string;
    };

export async function probeAgent(): Promise<AgentProbe> {
  const base = agentEndpointUrl().replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return { state: "reachable" };
    return { state: "unreachable", hint: `healthz answered ${res.status}` };
  } catch {
    return {
      state: "unreachable",
      hint: isLinked
        ? "agent unreachable from this origin — check the app's Allowed Domains include this site, and that a deployment is live (pnpm status)"
        : "local dev router not running — start it with `pnpm dev` (or bind a deployed app with `pnpm bootstrap -- --link`)",
    };
  }
}
