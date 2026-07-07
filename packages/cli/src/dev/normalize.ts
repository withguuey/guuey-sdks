/**
 * Framework → AgJSON {@link Normalizer} selection for `guuey dev`. CLI-side
 * mirror of `backend/services/nocode-runtime/src/sse-server.ts`'s
 * `makeNormalizer` (line ~253) — same switch, same error contract, minus the
 * `google-adk` arm (not yet wired for local dev).
 */
import type { Normalizer } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";

/**
 * Build the per-invoke {@link Normalizer} for the agent's framework. An
 * unknown framework throws `AGJSON_NO_NORMALIZER:<framework>` — a hard config
 * error, never silently bypassed (matches the pod's `sse-server.ts` contract).
 */
export function makeNormalizer(framework: string): Normalizer {
  switch (framework) {
    case "claude-agent-sdk":
      return createClaudeNormalizer();
    case "openai-agents-sdk":
      return createOpenaiNormalizer();
    case "google-adk":
      return createAdkNormalizer();
    default:
      throw new Error(`AGJSON_NO_NORMALIZER:${framework}`);
  }
}
