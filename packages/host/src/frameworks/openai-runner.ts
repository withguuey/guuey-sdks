/**
 * OpenAI runner module — the `FrameworkRunner` adapter around the existing
 * openai turn loop (`openai.ts#runInvokeOpenai`). Imports the SDK at module
 * top level so the host's lazy `import()` of this file is what pulls the
 * optional peer.
 *
 * Credential posture (unchanged from the pre-restructure host): the key (or
 * opaque broker token in hosted mode) is applied globally to the SDK via
 * `setDefaultOpenAIKey` once at runner creation. The OpenAI SDK also reads
 * `OPENAI_BASE_URL` + `OPENAI_API_KEY` from env directly, so the broker env
 * injected by the Router's `buildWorkerEnv` already routes it.
 */
import { run as openaiRun, setDefaultOpenAIKey } from "@openai/agents";
import type { Emitter } from "@guuey/worker";
import type { FrameworkRunner, HostSnapshot, HostTurn } from "../index.js";
import type { HostRuntime } from "./claude.js";
import { runInvokeOpenai, type OpenaiRunFn } from "./openai.js";
import { listCredentials } from "../creds.js";
import { buildHostContext } from "../boot-context.js";

/**
 * The real `@openai/agents` `run` (streamed overload), narrowed to the
 * injected {@link OpenaiRunFn} surface the loop consumes. The SDK's `run` is
 * generic over the agent + context; the loop only needs
 * `(agent, input, {stream,maxTurns}) → a streamed result`. A typed adapter
 * (NOT a cast) pins the streamed overload.
 */
const realOpenaiRun: OpenaiRunFn = (agent, input, options) =>
  openaiRun(agent, input, { stream: true, ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}) });

export function createRunner(): FrameworkRunner {
  const bootCtx = buildHostContext(process.env);
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
