/**
 * The builder's tool gates (`agent.tools.allowlist` / `agent.tools.denylist`)
 * for the frameworks that filter an MCP server's tools one server at a time:
 * OpenAI (the server's `toolFilter`) and ADK (the toolset's predicate). The
 * gate itself is `@guuey/config`'s `toolGatePredicate`, the one
 * implementation the host and the code-mode scaffolds share (its module doc
 * carries the contract); this file adds only the host's MCP Apps visibility.
 */
import { toolGatePredicate, type ToolGates } from "@guuey/config";
import { modelMayCallTool, type WithheldTool } from "@guuey/worker";

export type { ToolGates };

/**
 * The predicate that keeps a tool on `server` this turn, or `undefined` when
 * nothing is filtered (no allowlist narrowing, nothing denied or withheld):
 * the framework then builds the server exactly as before.
 */
export function mcpToolPredicateFor(
  server: string,
  gates: ToolGates,
  withheld?: readonly WithheldTool[],
): ((tool: string) => boolean) | undefined {
  return toolGatePredicate(gates, server, withheld);
}

/**
 * The model-facing filter for one server's listing: the tool must be one the
 * model may call (`modelMayCallTool`, `@guuey/worker`: MCP Apps visibility;
 * the Claude Agent SDK applies the same rule itself), and then pass the builder's gates
 * and this turn's withholds ({@link mcpToolPredicateFor}). ALWAYS a filter,
 * never `undefined`: visibility applies to every server, gated or not.
 */
export function modelToolFilterFor(
  server: string,
  gates: ToolGates,
  withheld?: readonly WithheldTool[],
): (name: string, listed: object) => boolean {
  const keep = mcpToolPredicateFor(server, gates, withheld);
  return (name, listed) => modelMayCallTool(listed) && (keep === undefined || keep(name));
}
