import type { AgentInvokeStatus } from "@guuey/agent-client";

/**
 * The LISTEN state (guuey#1038): ggui's `ggui_consume` is the one tool whose
 * pending state means "waiting on the user" — the card is live and the agent
 * is listening for a click — not "the agent is working". Every guuey chat
 * surface (the kit's `<GuueyChat>`, the console's `CardChat`) reads it
 * through these two predicates so the composer contract is one: during a
 * listen the composer stays open, Send is offered (no Stop), and a typed
 * reply ends the listen and goes out as the next turn.
 */

/** ggui's listen tool by wire name — bare (`ggui_consume`) or the MCP prefix shape (`mcp__<server>__ggui_consume`). */
export function isGguiConsumeTool(name: string | null): boolean {
  return name !== null && /(^|__)ggui_consume$/.test(name);
}

/** True while the ONLY thing in flight is a listen — the state the composer must not lock on. */
export function isWaitingOnUser(status: AgentInvokeStatus, activeTool: string | null): boolean {
  return status === "using-tool" && isGguiConsumeTool(activeTool);
}
