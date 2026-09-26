/**
 * Framework → AgJSON {@link Normalizer} selection for `guuey dev`. CLI-side
 * mirror of the hosted runtime's normalizer selection: the same three arms,
 * the same error contract, and the same thread id at construction.
 */
import type { Normalizer } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";
import { ADK_HOST_COMPLETION_CAPABILITY } from "@guuey/worker";

/**
 * Build the per-invoke {@link Normalizer} for the agent's framework. An
 * unknown framework throws `AGJSON_NO_NORMALIZER:<framework>` — a hard config
 * error, never silently bypassed (matches the hosted runtime's contract).
 *
 * `threadId` is the dev session's thread (the id its `session` frame names),
 * AgJSON's partition root. Each facet stamps it on every `turn.start` and
 * assistant `message.start`; without it a facet stamps its own placeholder
 * (Claude: the SDK session id; ADK and OpenAI: the labels `"google"` and
 * `"openai"`).
 */
export function makeNormalizer(
  framework: string,
  opts: { threadId?: string; hostCompletion?: boolean } = {},
): Normalizer {
  const threadOpts = opts.threadId !== undefined ? { threadId: opts.threadId } : {};
  switch (framework) {
    case "claude-agent-sdk":
      return createClaudeNormalizer(threadOpts);
    case "openai-agents-sdk":
      return createOpenaiNormalizer(threadOpts);
    case "google-adk":
      return createAdkNormalizer({ ...threadOpts, ...(opts.hostCompletion === true ? { hostCompletion: true } : {}) });
    default:
      throw new Error(`AGJSON_NO_NORMALIZER:${framework}`);
  }
}

/** An invoke's normalizer plus the one input that can still shape it: the worker's hello. */
export interface HelloGatedNormalizer {
  readonly normalizer: Normalizer;
  /** Feed the worker's hello. Honoured only while no native has reached the normalizer. */
  onHello(capabilities: readonly string[] | undefined): void;
}

/**
 * The invoke's {@link Normalizer}, with the google-adk arm's `hostCompletion`
 * negotiated from the worker's hello. An opted-in ADK facet holds every
 * successful turn open until the host feeds `__host_complete__`, so it opts in
 * only on the worker's word ({@link ADK_HOST_COMPLETION_CAPABILITY}): a local
 * project may run an older `@guuey/host`, or its own worker, that never sends it.
 *
 * The contract: the hello must PRECEDE the invoke's first native. The ADK
 * normalizer is built at its first use (the first native, or the flush) from
 * what is known then, and a later hello never rebuilds it or changes the option.
 * The Claude and OpenAI arms are built at once. An unknown framework throws
 * here, as {@link makeNormalizer} does.
 */
export function makeHelloGatedNormalizer(
  framework: string,
  opts: { threadId?: string } = {},
): HelloGatedNormalizer {
  if (framework !== "google-adk") {
    return { normalizer: makeNormalizer(framework, opts), onHello: ignoreHello };
  }
  let built: Normalizer | undefined;
  let hostCompletion = false;
  const current = (): Normalizer => (built ??= makeNormalizer(framework, { ...opts, hostCompletion }));
  return {
    normalizer: { push: (native) => current().push(native), flush: () => current().flush() },
    onHello: (capabilities) => {
      if (built === undefined && capabilities?.includes(ADK_HOST_COMPLETION_CAPABILITY) === true) hostCompletion = true;
    },
  };
}

function ignoreHello(): void {
  // The Claude and OpenAI facets take no option a hello negotiates.
}
