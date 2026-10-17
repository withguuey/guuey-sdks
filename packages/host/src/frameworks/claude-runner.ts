/**
 * Claude runner module — the `FrameworkRunner` adapter around the existing
 * claude turn loop (`claude.ts#runInvoke`). Imports the SDK at module top
 * level so the host's lazy `import()` of this file is what pulls the
 * optional peer.
 *
 * Credential posture (guuey#2139):
 *  - hosted/broker: `ANTHROPIC_BASE_URL` from the environment, the scoped
 *    token from the private launch envelope the boot read. Neither the token
 *    nor any other credential is in this process's environment.
 *  - no envelope: the legacy variables (`ANTHROPIC_AUTH_TOKEN`, or
 *    `ANTHROPIC_API_KEY` for local dev) are read once here.
 *  Either way the CLI child receives the key only on its private descriptor
 *  (`buildOptions` installs the spawner), never in its environment.
 *  A missing key is NOT fatal at boot — the run path emits a clear `error`
 *  per invoke if neither form is present.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { listCredentials, type Emitter } from "@guuey/worker";
import type { FrameworkRunner, HostSnapshot, HostTurn } from "../index.js";
import { runInvoke, type HostRuntime } from "./claude.js";
import { buildHostContext, type HostBoot } from "../boot-context.js";

export function createRunner(boot: HostBoot = {}): FrameworkRunner {
  const bootCtx = buildHostContext(process.env, boot.envelope);
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
