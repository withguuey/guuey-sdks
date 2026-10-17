/**
 * OpenAI runner module — the `FrameworkRunner` adapter around the existing
 * openai turn loop (`openai.ts#runInvokeOpenai`). Imports the SDK at module
 * top level so the host's lazy `import()` of this file is what pulls the
 * optional peer.
 *
 * Credential posture (guuey#2139): the key (the scoped token from the private
 * launch envelope in hosted mode, else the legacy `OPENAI_API_KEY`) is applied
 * to the SDK in memory with `setDefaultOpenAIKey`, once at runner creation,
 * and never written to `process.env`, so nothing this process spawns inherits
 * it. The SDK reads only the public `OPENAI_BASE_URL` from the environment.
 */
import { run as openaiRun, setDefaultOpenAIKey } from "@openai/agents";
import { listCredentials, type Emitter } from "@guuey/worker";
import type { FrameworkRunner, HostSnapshot, HostTurn } from "../index.js";
import type { HostRuntime } from "./claude.js";
import { runInvokeOpenai, type OpenaiRunFn } from "./openai.js";
import { buildHostContext, type HostBoot } from "../boot-context.js";

/**
 * The real `@openai/agents` `run` (streamed overload), narrowed to the
 * injected {@link OpenaiRunFn} surface the loop consumes. The SDK's `run` is
 * generic over the agent + context; the loop only needs
 * `(agent, input, {stream,maxTurns}) → a streamed result`. A typed adapter
 * (NOT a cast) pins the streamed overload.
 */
const realOpenaiRun: OpenaiRunFn = (agent, input, options) =>
  openaiRun(agent, input, { stream: true, ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}) });

export function createRunner(boot: HostBoot = {}): FrameworkRunner {
  const bootCtx = buildHostContext(process.env, boot.envelope);
  if (bootCtx.openaiKey !== undefined) setDefaultOpenAIKey(bootCtx.openaiKey);
  return {
    async runTurn(snapshot: HostSnapshot, turn: HostTurn, emit: Emitter): Promise<void> {
      // Broker fields (`baseUrl`/`authToken`) are only wired for the Claude
      // path — the OpenAI SDK reads its env directly.
      const runtime: HostRuntime = { listCredentials: listCredentials(turn.fs) };
      await runInvokeOpenai(snapshot, turn, runtime, emit, realOpenaiRun);
    },
  };
}
