/**
 * Framework-neutral context preamble, shared by every runner.
 *
 * Render prior context sections (conversation history, thread memory, working
 * state) as a preamble and prepend to the system prompt. Ephemeral workers
 * accept only the current `input` as the turn prompt, so feeding context here
 * is how they give the model memory across invokes. The rendering is
 * byte-identical across runners (the Python ADK host carried a verbatim port
 * of this function; the JS ADK runner now shares the original).
 *
 * Empty sections are omitted; if all inputs are empty/undefined the original
 * system prompt is returned unchanged.
 */
import type { HistoryMessage, JsonValue, PriorMemoryRecord } from "@guuey/worker";

export function withContextPreamble(
  systemPrompt: string,
  history: HistoryMessage[] | undefined,
  priorMemory: PriorMemoryRecord[] | undefined,
  priorState: JsonValue | undefined,
): string {
  const sections: string[] = [];

  if (history && history.length > 0) {
    sections.push(
      [
        "Prior conversation with this user, for context. Continue naturally;",
        "do not repeat it back verbatim.",
        "<conversation_history>",
        ...history.map((m) => `${roleLabel(m.role)}: ${m.text}`),
        "</conversation_history>",
      ].join("\n"),
    );
  }

  if (priorMemory && priorMemory.length > 0) {
    sections.push(
      [
        "Facts you previously recorded for this thread. Treat as known.",
        "<thread_memory>",
        ...priorMemory.map((m) => `${m.key ?? "(unkeyed)"}: ${JSON.stringify(m.value)}`),
        "</thread_memory>",
      ].join("\n"),
    );
  }

  if (priorState !== undefined) {
    sections.push(
      [
        "Your working state carried from the previous turn.",
        "<working_state>",
        JSON.stringify(priorState, null, 2),
        "</working_state>",
      ].join("\n"),
    );
  }

  if (sections.length === 0) return systemPrompt;
  return `${sections.join("\n\n")}\n\n${systemPrompt}`;
}

function roleLabel(role: HistoryMessage["role"]): string {
  return role === "agent" ? "Assistant" : "User";
}
