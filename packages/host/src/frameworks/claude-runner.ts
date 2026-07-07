/**
 * Claude runner module — the `FrameworkRunner` adapter around the existing
 * claude turn loop (`claude.ts#runInvoke`). Imports the SDK at module top
 * level so the host's lazy `import()` of this file is what pulls the
 * optional peer.
 *
 * Credential posture (unchanged from the pre-restructure host):
 *  - hosted/broker: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` injected by
 *    the Router's `buildWorkerEnv`; the real `ANTHROPIC_API_KEY` is
 *    intentionally absent so it cannot leak to agent code.
 *  - local-dev: only `ANTHROPIC_API_KEY` is set; `buildOptions` falls back to
 *    the direct-key path.
 *  A missing key is NOT fatal at boot — the run path emits a clear `error`
 *  per invoke if neither form is present.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Emitter } from "@guuey/worker";
import type { FrameworkRunner, HostSnapshot, HostTurn } from "../index.js";
import { runInvoke, type HostRuntime } from "./claude.js";
import { listCredentials } from "../creds.js";
import { buildHostContext } from "../boot-context.js";

export function createRunner(): FrameworkRunner {
  const bootCtx = buildHostContext(process.env);
  return {
    async runTurn(snapshot: HostSnapshot, turn: HostTurn, emit: Emitter): Promise<void> {
      const runtime: HostRuntime = {
        listCredentials: listCredentials(turn.fs),
        ...(bootCtx.anthropicApiKey !== undefined ? { apiKey: bootCtx.anthropicApiKey } : {}),
        ...(bootCtx.anthropicBaseUrl !== undefined ? { baseUrl: bootCtx.anthropicBaseUrl } : {}),
        ...(bootCtx.anthropicAuthToken !== undefined ? { authToken: bootCtx.anthropicAuthToken } : {}),
      };
      await runInvoke(snapshot, turn, runtime, emit, query);
    },
  };
}
