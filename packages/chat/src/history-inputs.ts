/**
 * The HISTORY input assembler (spec §7 "Input assembly") — persisted thread
 * read → `TranscriptInputs`, no hook, no DOM, no React: the seam that makes
 * server-side transcript rendering real. Give it what the read plane
 * returned (an agent-client `HistoryLoadResult`, or `null` while the read is
 * in flight) and plan the result with `planTranscript` anywhere Node runs.
 *
 * The LIVE twin (`useTranscriptInputs`, `@guuey/chat/react`) assembles the
 * same shape from `useAgentInvoke`'s state; the two produce byte-identical
 * inputs for the same settled conversation — that identity is what lets a
 * server-rendered transcript hydrate under the live one without a repaint.
 */
import type { HistoryLoadResult } from "@guuey/agent-client";
import type { TranscriptInputs } from "./types.js";

/** The settled-idle baseline every assembled input starts from. */
function idleInputs(): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [],
  };
}

/**
 * Assemble transcript inputs from a history read.
 *
 *  - `null` (read still in flight) → the R13 `loading` skeleton state;
 *  - `{ gone: true }` → the R13 `thread-gone` labeled empty state;
 *  - a transcript → the settled conversation, with any persisted cards
 *    riding the R13 → R6 remount path.
 */
export function transcriptInputsFromHistory(load: HistoryLoadResult | null): TranscriptInputs {
  const base = idleInputs();
  if (load === null) return { ...base, historyState: "loading" };
  if ("gone" in load) return { ...base, historyState: "gone" };
  return {
    ...base,
    historyState: "loaded",
    messages: load.messages,
    ...(load.cards && load.cards.length > 0 ? { historyCards: load.cards } : {}),
  };
}
