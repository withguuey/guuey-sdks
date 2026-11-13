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
 *
 * guuey#3407 leg 5: when the launcher sets `GUUEY_CLAUDE_SPARE` (the spare's
 * template), a Claude CLI is started here, at boot, as a parked spare holding
 * no credential, and the first turn that fits it claims it. Unset, nothing is
 * started and every turn runs exactly as before.
 */
import * as claudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import { listCredentials, type Emitter } from "@guuey/worker";
import type { FrameworkRunner, HostSnapshot, HostTurn } from "../index.js";
import { closeParkedSpare, prewarmClaudeSpare, runInvoke, type HostRuntime } from "./claude.js";
import { CLAUDE_SPARE_ENV, parseSpareTemplate, sparePrewarmOf, type ParkedSpare } from "./claude-spare.js";
import { buildHostContext, type HostBoot, type HostBootContext } from "../boot-context.js";

export function createRunner(boot: HostBoot = {}): FrameworkRunner {
  const bootCtx = buildHostContext(process.env, boot.envelope);
  const spare = boot.snapshot !== undefined ? startSpare(boot.snapshot, bootCtx, process.env[CLAUDE_SPARE_ENV]) : undefined;
  let spareTaken = false;
  // The spare serves at most one turn: the first one that takes it.
  const takeSpare =
    spare === undefined
      ? undefined
      : (): Promise<ParkedSpare | undefined> => {
          if (spareTaken) return Promise.resolve(undefined);
          spareTaken = true;
          return spare;
        };
  return {
    async runTurn(snapshot: HostSnapshot, turn: HostTurn, emit: Emitter): Promise<void> {
      const runtime: HostRuntime = {
        listCredentials: listCredentials(turn.fs),
        ...(bootCtx.anthropicApiKey !== undefined ? { apiKey: bootCtx.anthropicApiKey } : {}),
        ...(bootCtx.anthropicBaseUrl !== undefined ? { baseUrl: bootCtx.anthropicBaseUrl } : {}),
        ...(bootCtx.anthropicAuthToken !== undefined ? { authToken: bootCtx.anthropicAuthToken } : {}),
      };
      await runInvoke(snapshot, turn, runtime, emit, claudeAgentSdk.query, {}, takeSpare);
    },
    async close(): Promise<void> {
      // A spare no turn took is closed with the host, and its state root removed.
      if (spare === undefined || spareTaken) return;
      spareTaken = true;
      const parked = await spare;
      if (parked !== undefined) closeParkedSpare(parked);
    },
  };
}

/** Start the parked spare when the launcher asked for one; undefined (the path is off) when it did not. */
function startSpare(snapshot: HostSnapshot, bootCtx: HostBootContext, raw: string | undefined): Promise<ParkedSpare | undefined> | undefined {
  if (raw === undefined || raw === "") return undefined;
  const template = parseSpareTemplate(raw);
  if (!template.ok) {
    process.stderr.write(`[guuey] Claude spare not started: ${template.reason}\n`);
    return undefined;
  }
  const prewarm = sparePrewarmOf(claudeAgentSdk);
  if (prewarm === undefined) {
    process.stderr.write("[guuey] Claude spare not started: the installed @anthropic-ai/claude-agent-sdk has no prewarm\n");
    return undefined;
  }
  const runtime: HostRuntime = {
    listCredentials: () => [],
    ...(bootCtx.anthropicBaseUrl !== undefined ? { baseUrl: bootCtx.anthropicBaseUrl } : {}),
  };
  return prewarmClaudeSpare(snapshot, template.invoke, runtime, prewarm);
}
