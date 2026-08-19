/**
 * The embedded chat page — distribution way #2 in the flesh. In local dev
 * this talks to `guuey dev --serve` (pnpm dev boots it); once linked it
 * talks to the deployed agent pod. Generative-UI cards render inline via
 * the chat kit's sandboxed default mount — no extra setup.
 */
import { AgentChat } from "../components/AgentChat";

export function Chat() {
  return (
    <main className="page chat-page">
      <AgentChat className="chat-fill" />
    </main>
  );
}
