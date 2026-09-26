/**
 * Framework → AgJSON {@link Normalizer} selection for `guuey dev`. CLI-side
 * mirror of the hosted runtime's normalizer selection: the same three arms,
 * the same error contract, and the same thread id at construction.
 */
import type { Normalizer } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";

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
export function makeNormalizer(framework: string, opts: { threadId?: string } = {}): Normalizer {
  const threadOpts = opts.threadId !== undefined ? { threadId: opts.threadId } : {};
  switch (framework) {
    case "claude-agent-sdk":
      return createClaudeNormalizer(threadOpts);
    case "openai-agents-sdk":
      return createOpenaiNormalizer(threadOpts);
    case "google-adk":
      return createAdkNormalizer(threadOpts);
    default:
      throw new Error(`AGJSON_NO_NORMALIZER:${framework}`);
  }
}
