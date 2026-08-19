/**
 * The fullscreen agent — the whole main canvas is the chat, so generative
 * UI cards render at real size. This is the same configured `<AgentChat>`
 * every chat surface in this template uses.
 */
import { AgentChat } from "../components/AgentChat";

export function AgentCanvas() {
  return (
    <div className="agent-canvas">
      <AgentChat className="chat-fill" />
    </div>
  );
}
